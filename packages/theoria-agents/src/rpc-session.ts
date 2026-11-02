import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';

export type RpcEvent = Record<string, unknown> & { type?: string; id?: string };

/** Shared process transport for benchmark workers and independent subagents. No task or campaign policy. */
export class RpcSession {
  protected child: ChildProcess | undefined;
  private pending = new Map<string, { resolve: (event: RpcEvent) => void; timer?: ReturnType<typeof setTimeout> }>();
  private counter = 0;
  private listeners = new Set<(event: RpcEvent) => void>();
  private closed?: Promise<void>;
  private stopping?: Promise<void>;
  private rpcTimeoutMs = 60000;
  stderr = '';
  exited: Promise<number | null>;
  private exit!: (code: number | null) => void;

  constructor() { this.exited = new Promise(resolve => { this.exit = resolve; }); }

  protected launch(command: string, args: string[], options: SpawnOptions, startupTimeoutMs: number, rpcTimeoutMs = 60000): Promise<void> {
    this.rpcTimeoutMs = rpcTimeoutMs;
    this.child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.closed = new Promise(resolve => this.child!.once('close', () => resolve()));
    createInterface({ input: this.child.stdout! }).on('line', line => {
      let event: RpcEvent;
      try { event = JSON.parse(line) as RpcEvent; } catch { return; }
      if (event.type === 'response' && typeof event.id === 'string' && this.pending.has(event.id)) {
        const pending = this.pending.get(event.id)!; clearTimeout(pending.timer); this.pending.delete(event.id); pending.resolve(event); return;
      }
      for (const listener of this.listeners) listener(event);
    });
    this.child.stderr!.on('data', chunk => { this.stderr = (this.stderr + String(chunk)).slice(-4000); });
    const finish = (code: number | null, reason: string) => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.resolve({ type: 'response', success: false, error: reason }); }
      this.pending.clear(); this.exit(code);
    };
    this.child.on('error', error => { this.stderr = `${this.stderr}\n${error.message}`.slice(-4000); finish(1, error.message); });
    this.child.on('exit', code => finish(code, 'The child session ended.'));
    return this.request({ type: 'get_state' }, startupTimeoutMs).then(response => {
      if (response.success === false) throw new Error(String(response.error ?? 'The child session did not start.'));
    });
  }

  on(listener: (event: RpcEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  request(command: Record<string, unknown>, timeoutMs = this.rpcTimeoutMs): Promise<RpcEvent> {
    if (!this.child?.stdin?.writable) return Promise.resolve({ type: 'response', success: false, error: 'Worker process is not running.' });
    const id = `t${++this.counter}`;
    return new Promise(resolve => {
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.pending.delete(id); resolve({ success: false, error: `Worker RPC ${String(command.type)} timed out after ${timeoutMs / 1000}s.` });
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, timer });
      this.child!.stdin!.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }
  prompt(message: string) { return this.request({ type: 'prompt', message, streamingBehavior: 'followUp' }); }
  abort() { return this.request({ type: 'abort' }); }
  refuse(id: string) { this.child?.stdin?.write(`${JSON.stringify({ type: 'extension_ui_response', id, cancelled: true })}\n`); }
  stop(): Promise<void> {
    if (!this.child) return Promise.resolve();
    if (this.stopping) return this.stopping;
    const child = this.child;
    this.stopping = (async () => {
      const kill = (signal: NodeJS.Signals) => {
        if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, signal); return; } catch { /* already exited */ } }
        child.kill(signal);
      };
      if (child.exitCode === null && child.signalCode === null) kill('SIGTERM');
      const force = setTimeout(() => kill('SIGKILL'), 5000);
      try { await this.closed; } finally { clearTimeout(force); }
    })();
    return this.stopping;
  }
  get pid() { return this.child?.pid; }
}
