import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from '@theoria/shared/config';
import { projectPath, projectRoot } from '@theoria/shared/paths';
import { nextId, withLock, writeJson } from '@theoria/pi-research/api';
import { terminalWorkerEnv } from '@theoria/pi-telegram/credentials';
import { BoundedAgent, type AgentLimits, type AgentMetrics } from './bounded-agent.ts';
import { SubagentSession, type SubagentLaunch } from './session.ts';

export interface SubagentRequest {
  task: string; context?: string; cwd?: string; model: string; thinking: string; harness: string;
  mode?: 'read' | 'write'; maxCostUsd?: number; maxTurns?: number; timeoutMinutes?: number;
}
export interface SubagentRecord {
  id: string; parentSession: string; ownerPid: number; workerPid?: number;
  task: string; context?: string; cwd: string; model: string; thinking: string; harness: string; mode: 'read' | 'write';
  limits: Required<Pick<SubagentRequest, 'maxCostUsd' | 'maxTurns' | 'timeoutMinutes'>>;
  status: 'starting' | 'running' | 'completed' | 'cancelled' | 'error' | 'interrupted';
  createdAt: string; completedAt?: string; activity?: { text: string; at: string }; metrics: Partial<AgentMetrics>;
  error?: string; resultFile?: string;
}
type Agent = Pick<BoundedAgent, 'start' | 'turn' | 'stop' | 'session' | 'metrics'>;
export interface SubagentServices {
  environment?: () => Promise<NodeJS.ProcessEnv>;
  createAgent?: (launch: SubagentLaunch, limits: AgentLimits, signal: AbortSignal,
    metrics: (value: AgentMetrics) => void, activity: (value: { text: string; at: string }) => void) => Agent;
  finished?: (record: SubagentRecord) => void;
}
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };

/** Independent child tasks. No campaign or benchmark IDs, state, scheduling or approval loop. */
export class SubagentManager {
  readonly cwd: string;
  readonly parentSession: string;
  private services: SubagentServices;
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  constructor(cwd: string, parentSession: string, services: SubagentServices = {}) {
    this.cwd = realpathSync(projectRoot(cwd)); this.parentSession = parentSession; this.services = services;
  }
  private root() { return projectPath(this.cwd, config().subagents.dir); }
  private dir(id: string) {
    if (!/^subagent-\d+$/.test(id)) throw new Error('Invalid subagent ID.');
    return join(this.root(), id);
  }
  private save(record: SubagentRecord) { writeJson(join(this.dir(record.id), 'agent.json'), record); }
  status(id: string): SubagentRecord {
    const record = JSON.parse(readFileSync(join(this.dir(id), 'agent.json'), 'utf8')) as SubagentRecord;
    if (['starting', 'running'].includes(record.status) && !alive(record.ownerPid)) return { ...record, status: 'interrupted', error: 'The owning session stopped before collecting a result.' };
    return record;
  }
  list() { return existsSync(this.root()) ? readdirSync(this.root()).filter(id => /^subagent-\d+$/.test(id)).sort().map(id => this.status(id)) : []; }
  result(id: string) {
    const record = this.status(id);
    const text = record.resultFile ? readFileSync(join(this.dir(id), 'result.txt'), 'utf8') : '';
    return { ...record, result: text.slice(0, config().subagents.resultChars), truncated: text.length > config().subagents.resultChars,
      transcript: join(this.dir(id), 'session'), ...(record.resultFile ? { resultPath: join(this.dir(id), 'result.txt') } : {}) };
  }
  start(request: SubagentRequest) {
    const settings = config().subagents;
    if (!request.task.trim() || request.task.length > 100000 || (request.context?.length ?? 0) > 100000) throw new Error('Supply a task and at most 100,000 characters of task/context.');
    const cwd = realpathSync(resolve(this.cwd, request.cwd ?? '.'));
    const rel = relative(this.cwd, cwd);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('Subagent cwd must remain inside this project.');
    const limits = { maxCostUsd: request.maxCostUsd ?? settings.maxCostUsd, maxTurns: request.maxTurns ?? settings.maxTurns, timeoutMinutes: request.timeoutMinutes ?? settings.timeoutMinutes };
    if (Object.values(limits).some(value => !Number.isFinite(value) || value <= 0) || !Number.isSafeInteger(limits.maxTurns)) throw new Error('Subagent cost, turns and timeout must be positive; turns must be an integer.');
    if (!['read', 'write'].includes(request.mode ?? 'read')) throw new Error('Subagent mode must be read or write.');
    let record!: SubagentRecord;
    withLock(this.cwd, () => {
      const own = this.list().filter(record => record.parentSession === this.parentSession);
      if (own.length >= settings.maxTasks) throw new Error('Parent-session subagent task limit reached.');
      const running = own.filter(record => ['starting', 'running'].includes(record.status));
      if (running.length >= settings.maxConcurrent) throw new Error('Subagent concurrency limit reached; wait for an existing task.');
      const allocated = own.reduce((sum, record) => sum + ((['starting', 'running'].includes(record.status) || (record.status === 'interrupted' && !record.completedAt))
        ? Math.max(record.limits.maxCostUsd, record.metrics.costUsd ?? 0) : record.metrics.costUsd ?? 0), 0);
      if (allocated + limits.maxCostUsd > settings.maxTotalCostUsd) throw new Error('Parent-session subagent budget exhausted or reserved.');
      mkdirSync(this.root(), { recursive: true });
      let id: string;
      for (;;) {
        id = nextId('subagent-', readdirSync(this.root()), 3);
        try { mkdirSync(this.dir(id)); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      }
      record = { id, parentSession: this.parentSession, ownerPid: process.pid, task: request.task, context: request.context, cwd,
        model: request.model, thinking: request.thinking, harness: request.harness, mode: request.mode ?? 'read',
        limits, status: 'starting', createdAt: new Date().toISOString(), metrics: {} };
      this.save(record);
    });
    const controller = new AbortController();
    const done = this.run(record, controller).finally(() => this.active.delete(record.id));
    void done.catch(() => {}); // wait/result still expose failures; do not leave a detached rejection.
    this.active.set(record.id, { controller, done });
    return record;
  }
  private async run(record: SubagentRecord, controller: AbortController) {
    let agent: Agent | undefined;
    const stop = () => { void agent?.session.stop(); };
    controller.signal.addEventListener('abort', stop, { once: true });
    try {
      const env = await (this.services.environment ?? terminalWorkerEnv)();
      if (controller.signal.aborted) throw new Error('Cancelled before startup.');
      const piName = `subagent-pi/${createHash('sha256').update(`${this.cwd}/${record.id}`).digest('hex').slice(0, 20)}`;
      const launch: SubagentLaunch = { cwd: record.cwd, scratch: this.dir(record.id), piName, model: record.model, thinking: record.thinking, harness: record.harness, mode: record.mode, env };
      const create = this.services.createAgent ?? ((o, limits, signal, metrics, activity) => new BoundedAgent(new SubagentSession(o), limits, signal, metrics, activity, 'Finish the assigned task within these limits and report concrete results.'));
      agent = create(launch, record.limits, controller.signal,
        metrics => { record.metrics = { ...metrics }; this.save(record); },
        activity => { record.activity = activity; this.save(record); });
      await agent.start(); record.workerPid = agent.session.pid; record.status = 'running'; this.save(record);
      const result = await agent.turn(`You are an independent Theoria subagent. Work only on the task below in ${record.cwd}. Mode: ${record.mode}. Your parent receives your final answer; give concrete findings, changed paths and verification results. Do not spawn child agents or assume access to the parent's conversation.\n\nTask:\n${record.task}${record.context ? `\n\nContext supplied by parent:\n${record.context}` : ''}`);
      record.metrics = { ...agent.metrics };
      if (result.reply) { writeFileSync(join(this.dir(record.id), 'result.txt'), result.reply, { mode: 0o600 }); record.resultFile = 'result.txt'; }
      record.error = result.error;
      record.status = controller.signal.aborted ? 'cancelled' : result.aborted ? 'interrupted' : result.error ? 'error' : 'completed';
    } catch (error) { record.status = controller.signal.aborted ? 'cancelled' : 'error'; record.error = String(error); }
    finally {
      controller.signal.removeEventListener('abort', stop);
      try { await agent?.stop(); } catch (error) { record.error ??= String(error); if (record.status === 'completed') record.status = 'error'; }
      record.completedAt = new Date().toISOString(); delete record.workerPid; this.save(record);
      try { this.services.finished?.(record); } catch { /* UI notifications do not alter results. */ }
    }
  }
  async wait(id: string, seconds = config().subagents.maxWaitSeconds, signal?: AbortSignal) {
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > config().subagents.maxWaitSeconds) throw new Error('Invalid subagent wait duration.');
    const active = this.active.get(id);
    if (active) {
      let timer: ReturnType<typeof setTimeout> | undefined; let abort: (() => void) | undefined;
      const wait = new Promise<void>(resolve => {
        timer = setTimeout(resolve, seconds * 1000); abort = resolve;
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) resolve();
      });
      try { await Promise.race([active.done, wait]); } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
    }
    return this.result(id);
  }
  async cancel(id: string) {
    const active = this.active.get(id);
    if (!active && ['starting', 'running'].includes(this.status(id).status)) throw new Error('This child belongs to another active parent session.');
    active?.controller.abort(); await active?.done; return this.result(id);
  }
  async stopAll() { for (const active of this.active.values()) active.controller.abort(); await Promise.allSettled([...this.active.values()].map(active => active.done)); }
}
