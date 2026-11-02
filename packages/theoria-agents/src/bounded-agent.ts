import type { RpcEvent } from './rpc-session.ts';
import { deadlineTimer, limit, showLimit, type Limit } from '@theoria/shared/limits';

export interface AgentMetrics {
  turns: number; costUsd: number; tokens: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number;
  firstTurnInputTokens: number; durationMs: number; rounds: number; stoppedBy?: 'cost' | 'turns' | 'timeout' | 'error' | 'cancelled' | 'agent';
}
export interface AgentSession {
  start(): Promise<void>; on(listener: (event: RpcEvent) => void): () => void;
  prompt(message: string): Promise<RpcEvent>; request(command: Record<string, unknown>): Promise<RpcEvent>;
  abort(): Promise<RpcEvent>; refuse(id: string): void; stop(): Promise<void>;
  exited: Promise<number | null>; stderr: string; readonly pid?: number;
}
export interface AgentLimits { maxCostUsd: Limit; maxTurns: Limit; timeoutMinutes: Limit }
export interface AgentTurnResult { aborted: boolean; error?: string; reply: string; limit?: 'cost' | 'turns' | 'timeout' }

/** The same bounded turn runner is used for proof workers and independent task delegation. */
export class BoundedAgent {
  readonly session: AgentSession;
  readonly metrics: AgentMetrics = { turns: 0, costUsd: 0, tokens: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, firstTurnInputTokens: 0, durationMs: 0, rounds: 0 };
  private error?: string;
  private cancelled = false;
  private settle?: () => void;
  private cancelTimer?: () => void;
  private readonly started = Date.now();
  private unsubscribe: () => void;
  private abort: () => void;
  private limits: AgentLimits;
  private signal: AbortSignal;
  private onMetrics: (metrics: AgentMetrics) => void;
  private completionInstruction: string;
  constructor(session: AgentSession, limits: AgentLimits, signal: AbortSignal,
    onMetrics: (metrics: AgentMetrics) => void = () => {}, onActivity: (activity: { text: string; at: string }) => void = () => {},
    completionInstruction = 'Finish with a verified candidate before these limits; leave time for the host\'s final checks.') {
    this.session = session; this.limits = limits; this.signal = signal; this.onMetrics = onMetrics;
    this.completionInstruction = completionInstruction;
    this.abort = () => { this.cancelled = true; void this.session.abort(); this.settle?.(); };
    signal.addEventListener('abort', this.abort, { once: true });
    this.unsubscribe = this.session.on(event => {
      const activity = (text: string) => onActivity({ text, at: new Date().toISOString() });
      if (event.type === 'message_start' && (event.message as { role?: string })?.role === 'assistant') activity('waiting for model response');
      if (event.type === 'tool_execution_start') activity(`tool: ${String(event.toolName ?? 'tool')}`);
      if (event.type === 'tool_execution_end') activity(`tool finished: ${String(event.toolName ?? 'tool')}`);
      if (event.type === 'message_end') {
        const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { total: number } } };
        if (message?.role !== 'assistant') return;
        this.error = message.stopReason === 'error' ? message.errorMessage ?? 'Provider failed.' : undefined;
        activity(this.error ? `model error: ${this.error}` : 'model response received');
        const usage = message.usage;
        if (usage) {
          if (!this.metrics.tokens) this.metrics.firstTurnInputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
          this.metrics.costUsd += usage.cost.total; this.metrics.tokens += usage.totalTokens;
          this.metrics.tokensIn += usage.input; this.metrics.tokensOut += usage.output;
          this.metrics.cacheRead += usage.cacheRead; this.metrics.cacheWrite += usage.cacheWrite;
        }
        this.metrics.turns++; this.metrics.durationMs = Date.now() - this.started; this.onMetrics(this.metrics);
        if (!this.error && (this.metrics.costUsd >= limit(limits.maxCostUsd) || this.metrics.turns >= limit(limits.maxTurns))) {
          this.error = 'Worker budget or turn limit reached.';
          this.metrics.stoppedBy = this.metrics.costUsd >= limit(limits.maxCostUsd) ? 'cost' : 'turns'; this.abort();
        }
      }
      if (event.type === 'extension_ui_request') this.session.refuse(String(event.id));
      if (event.type === 'agent_settled') this.settle?.();
    });
  }
  async start() {
    if (this.signal.aborted) throw new Error('Cancelled before starting worker.');
    this.cancelTimer = deadlineTimer(limit(this.limits.timeoutMinutes) * 60000,
      () => { this.error = 'Worker time limit reached.'; this.metrics.stoppedBy = 'timeout'; this.abort(); });
    try { await this.session.start(); } catch (error) { throw new Error(`${String(error)} ${this.session.stderr}`); }
  }
  async turn(text: string): Promise<AgentTurnResult> {
    if (this.cancelled || this.signal.aborted) return { aborted: true, error: this.error, reply: '', limit: this.limit() };
    this.error = undefined;
    const settled = new Promise<void>(resolve => { this.settle = resolve; });
    const remaining = `${showLimit(this.limits.maxTurns, n => String(Math.max(0, n - this.metrics.turns)))} model responses, ${showLimit(this.limits.maxCostUsd, n => `$${Math.max(0, n - this.metrics.costUsd).toFixed(3)}`)}, ${showLimit(this.limits.timeoutMinutes, n => Math.max(0, n * 60 - (Date.now() - this.started) / 1000).toFixed(0))} seconds`;
    const response = await this.session.prompt(`${text}\n\nWorker allowance remaining at this prompt: ${remaining}. ${this.completionInstruction}`);
    if (response.success === false) throw new Error(String(response.error));
    await Promise.race([settled, this.session.exited.then(() => { throw new Error(`Worker exited: ${this.session.stderr}`); })]);
    this.settle = undefined;
    if (this.cancelled || this.signal.aborted) return { aborted: true, error: this.error, reply: '', limit: this.limit() };
    const messages = await this.session.request({ type: 'get_messages' });
    const list = (messages.data as { messages?: { role: string; content?: { type: string; text?: string }[] }[] } | undefined)?.messages ?? [];
    const last = list.filter(message => message.role === 'assistant').at(-1);
    return { aborted: this.cancelled || this.signal.aborted, error: this.error,
      reply: (last?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n') };
  }
  private limit() { const reason = this.metrics.stoppedBy; return reason === 'cost' || reason === 'turns' || reason === 'timeout' ? reason : undefined; }
  stop() { this.cancelTimer?.(); this.signal.removeEventListener('abort', this.abort); this.unsubscribe(); return this.session.stop(); }
}
