import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { config } from './config.ts';

export interface TurnResult { aborted: boolean; reply: string; error?: string; costUsd: number }

/** One turn through Pi, shared by compiler-checked workflows. Only the currently requested turn is observed. */
export class AgentTurn {
  private active: { started: boolean; result: TurnResult; settle: () => void; budget: number; abort: () => void;
    responses: number; maxResponses: number; onSpend?: (spent: number) => void } | undefined;
  private readonly pi: ExtensionAPI;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    pi.on('agent_start', () => { if (this.active) this.active.started = true; });
    pi.on('message_end', event => {
      const active = this.active;
      if (!active || event.message.role !== 'assistant') return;
      const message = event.message;
      active.result.costUsd += message.usage.cost.total;
      active.responses++;
      if (!active.result.aborted) {
        if (message.stopReason === 'aborted') delete active.result.error;
        else if (message.errorMessage || message.stopReason === 'error') active.result.error = message.errorMessage || 'The provider ended the turn with an error.';
        else delete active.result.error; // A provider retry recovered.
      }
      if (message.stopReason === 'aborted') active.result.aborted = true;
      if (active.result.costUsd >= active.budget) { active.result.error = 'The workflow cost limit was reached.'; active.abort(); }
      if (active.responses >= active.maxResponses) { active.result.error = 'The workflow response limit was reached.'; active.abort(); }
      try { active.onSpend?.(active.result.costUsd); } catch (error) { active.result.error = String(error); active.abort(); }
    });
    pi.on('agent_end', event => {
      if (!this.active) return;
      const last = [...event.messages].reverse().find(message => message.role === 'assistant') as { content?: { type: string; text?: string }[] } | undefined;
      this.active.result.reply = (last?.content ?? []).filter(part => part.type === 'text').map(part => part.text ?? '').join('').trim();
    });
    pi.on('agent_settled', () => this.active?.settle());
    pi.on('session_compact', event => {
      const active = this.active;
      if (!active?.onSpend) return;
      const usage = event.compactionEntry.usage;
      if (!usage) { active.result.error = 'Compaction usage is unavailable; cannot account for the research budget.'; active.abort(); return; }
      active.result.costUsd += usage.cost.total;
      try { active.onSpend(active.result.costUsd); } catch (error) { active.result.error = String(error); active.abort(); }
      if (active.result.costUsd >= active.budget) { active.result.error = 'The workflow cost limit was reached.'; active.abort(); }
    });
  }

  async turn(ctx: ExtensionCommandContext, text: string, options: { signal?: AbortSignal; maxCostUsd?: number; maxResponses?: number; onSpend?: (spent: number) => void } = {}): Promise<TurnResult> {
    if (this.active) throw new Error('An agent turn is already running.');
    const result: TurnResult = { aborted: false, reply: '', costUsd: 0 };
    if (options.signal?.aborted) return { ...result, aborted: true };
    let settle!: () => void;
    const done = new Promise<void>(resolve => { settle = resolve; });
    const abort = () => { result.aborted = true; ctx.abort(); settle(); };
    const cancel = () => { delete result.error; abort(); };
    const active = { started: false, result, settle, budget: options.maxCostUsd ?? Infinity, abort,
      responses: 0, maxResponses: options.maxResponses ?? Infinity, onSpend: options.onSpend };
    this.active = active;
    const sent = Date.now();
    const timer = setInterval(() => {
      if (!active.started && Date.now() - sent > config().workflows.turn.startGraceMs && ctx.isIdle()) {
        result.error ??= 'The model did not start a turn.';
        settle();
      }
    }, config().workflows.turn.pollMs);
    options.signal?.addEventListener('abort', cancel, { once: true });
    try {
      this.pi.sendUserMessage(text);
      await done;
      if (result.aborted) await ctx.waitForIdle();
      return result;
    } finally {
      clearInterval(timer);
      options.signal?.removeEventListener('abort', cancel);
      this.active = undefined;
    }
  }
}
