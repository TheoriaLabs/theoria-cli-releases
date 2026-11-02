import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendRunEvent } from '@theoria/shared/events';
import { config } from '@theoria/shared/config';
import { deadlineTimer, limit, showLimit, storedLimit } from '@theoria/shared/limits';
import { findProfile, profiles, theoriaCommitNow } from '@theoria/shared/harness';
import { checkPlan, createRun, planLines as describePlan, readPlan, registerArtifact, setStatus, type Harness } from '@theoria/pi-research/api';
import { buildComparator, comparatorReady, judge, readSolution } from './comparator.ts';
import { ensureEnv, envState, makeLakeProject, type EnvState, type ExtraWorkspace } from './env.ts';
import { extraDir, extraSpec, extraState } from '@theoria/pi-lean/api';
import { findBenchmark } from './registry.ts';
import { splitsFor } from './splits.ts';
import {
  aggregate, benchRunDir, cancelRequested, clearCancel, evalDir, readBenchRun, saveTrial, trialDir, trials, writeBenchRun, type Aggregate,
} from './store.ts';
import { TrialSession, type RpcEvent } from './trial-session.ts';
import type { Benchmark, BenchmarkRun, BenchmarkRunConfig, BenchmarkTask, BenchmarkTrial, TrialMetrics } from './types.ts';
import type { CompressionInputs, CompressionRequest } from './compression-types.ts';
import { inputHash, prepareCompressionInputs } from './compression-inputs.ts';
import { writeJson } from '@theoria/pi-research/api';
import { cleanupAfterRun } from './cleanup.ts';
import { compressionSkillLabel } from '@theoria/pi-workflows/api';
import { appendPrompt, validatePromptAppend } from './prompt.ts';
import { appendContext, prepareContext, stageContext, verifyContextSnapshot, writeContextSnapshot, type PreparedContext } from './context.ts';

/**
 * Running a benchmark: plan (what would run, on which Lean, at what cost at most), create (a research run of kind
 * benchmark, its trials queued), run (bounded concurrency, each trial a sandboxed session judged by Comparator),
 * resume (trials a stopped runner left), cancel (a file any process can write, so the bot and the terminal can stop
 * each other's runs). Every state change is written before the next step, so a crash loses at most the trials in
 * flight, which `resume` runs again.
 */

const settings = () => config().benchmarks;
export const thinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh'];

export interface PlanOptions {
  cwd?: string;
  compression?: CompressionRequest;
  benchmarkId: string;
  split?: string;
  /** Task ids separated by commas, or a number: the first N tasks of the split. */
  tasks?: string;
  model: string;
  overrides?: Partial<BenchmarkRunConfig>;
  startedFrom: BenchmarkRun['startedFrom'];
  maxTotalCostUsd?: number;
}

export interface Plan {
  context?: PreparedContext;
  compression?: CompressionInputs;
  benchmark: Benchmark;
  split: string;
  tasks: BenchmarkTask[];
  config: BenchmarkRunConfig;
  env: EnvState;
  comparator: boolean;
  maxCostUsd: number | null;
  estimateMinutes: number;
  problems: string[];
}

export async function planRun(options: PlanOptions): Promise<Plan> {
  const benchmark = findBenchmark(options.benchmarkId);
  if (!benchmark) throw new Error(`No benchmark ${options.benchmarkId}. /benchmark list shows them.`);
  if (!benchmark.installed()) throw new Error(`${benchmark.title} is not installed: /benchmark install ${benchmark.id}.`);
  const split = options.split ?? settings().splits.defaultRunSplit;
  const splits = splitsFor(benchmark);
  const all = benchmark.listTasks();
  let tasks = all.filter(task => splits[task.id] === split);
  if (options.tasks && /^\d+$/.test(options.tasks)) tasks = tasks.slice(0, Number(options.tasks));
  else if (options.tasks) {
    const wanted = options.tasks.split(',').map(item => item.trim()).filter(Boolean);
    const unknown = wanted.filter(id => !all.some(task => task.id === id));
    if (unknown.length) throw new Error(`No such tasks in ${benchmark.id}: ${unknown.join(', ')}.`);
    const outside = wanted.filter(id => splits[id] !== split);
    if (outside.length) throw new Error(`${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not in the ${split} split (${outside.map(id => `${id}: ${splits[id]}`).join(', ')}).`);
    tasks = all.filter(task => wanted.includes(task.id));
  }
  const defaults = settings().defaults;
  const harness = options.overrides?.harness ?? config().harness.default;
  if (!findProfile(harness)) throw new Error(`No harness profile ${harness}. Profiles: ${profiles().map(profile => profile.name).join(', ')}.`);
  const cfg: BenchmarkRunConfig = {
    model: options.model, harness, thinking: defaults.thinking, repetitions: defaults.repetitions, concurrency: defaults.concurrency,
    timeoutMinutes: benchmark.timeoutMinutes ?? defaults.timeoutMinutes, maxTurns: defaults.maxTurns, maxCostUsd: defaults.maxCostUsd,
    retries: defaults.retries, feedbackRounds: defaults.feedbackRounds, continueRounds: defaults.continueRounds, ...options.overrides,
  };
  const limits = settings().limits;
  if (!thinkingLevels.includes(cfg.thinking)) throw new Error(`thinking must be one of ${thinkingLevels.join(', ')}, not ${cfg.thinking}.`);
  cfg.concurrency = Math.min(limits.concurrency.max, Math.max(limits.concurrency.min, cfg.concurrency));
  if (cfg.timeoutMinutes !== null) cfg.timeoutMinutes = Math.min(limits.timeoutMinutes.max, Math.max(limits.timeoutMinutes.min, cfg.timeoutMinutes));
  const promptAppend = cfg.promptAppend ?? options.compression?.promptAppend;
  const skipVerification = cfg.skipVerification ?? options.compression?.skipVerification;
  if (skipVerification !== undefined) cfg.skipVerification = skipVerification;
  validatePromptAppend(promptAppend);
  if (promptAppend !== undefined) cfg.promptAppend = promptAppend;
  const context = cfg.contextDir !== undefined ? prepareContext(options.cwd ?? process.cwd(), cfg.contextDir) : undefined;
  if (context) cfg.context = context.manifest;
  else if (cfg.context) throw new Error('A new run needs context-dir to prepare its context snapshot.');
  const compression = options.compression ? prepareCompressionInputs(options.cwd ?? process.cwd(), benchmark, tasks,
    { ...options.compression, ...(promptAppend !== undefined ? { promptAppend } : {}), ...(skipVerification !== undefined ? { skipVerification } : {}) }) : undefined;
  if (skipVerification && !compression) throw new Error('skip-verification requires compression mode.');
  if (cfg.mode === 'compress' && !compression) throw new Error('Compression mode needs frozen corpus and skill inputs.');
  if (compression) cfg.mode = 'compress';
  if (compression && context) compression.contextHash = context.manifest.sha256;
  const spec = compression?.lean ?? benchmark.lean();
  const env = await envState(spec);
  const problems = [
    ...(tasks.length ? [] : [`no tasks in the ${split} split${options.tasks ? ` matching "${options.tasks}"` : ''}`]),
    ...(!env.ready && !/prepared on the first run/.test(env.reason) ? [env.reason] : []),
  ];
  for (const name of findProfile(cfg.harness)!.leanExtras) {
    const problem = extraProblem(name, spec);
    if (problem) problems.push(problem);
  }
  const trialsCount = tasks.length * cfg.repetitions;
  const maxCost = trialsCount * limit(cfg.maxCostUsd);
  if (options.maxTotalCostUsd !== undefined && maxCost > options.maxTotalCostUsd) {
    problems.push(`at most $${maxCost.toFixed(2)} (${trialsCount} trials × $${cfg.maxCostUsd}) is above the cap of $${options.maxTotalCostUsd}; choose fewer tasks or a lower per-trial cap`);
  }
  return {
    benchmark, split, tasks, config: cfg, env, comparator: comparatorReady(spec.toolchain), maxCostUsd: storedLimit(maxCost), ...(compression ? { compression } : {}),
    ...(context ? { context } : {}),
    estimateMinutes: Math.ceil(trialsCount / cfg.concurrency) * Math.min(defaults.estimateMinutesPerTask, limit(cfg.timeoutMinutes)), problems,
  };
}

export function planLines(plan: Plan): string[] {
  const spec = plan.compression?.lean ?? plan.benchmark.lean();
  return [
    `${plan.benchmark.title} · ${plan.split} split · ${plan.tasks.length} task(s)${plan.config.repetitions > 1 ? ` × ${plan.config.repetitions}` : ''}`,
    ...(plan.compression ? [`Mode: compression · ${plan.compression.rounds} rounds · skill ${compressionSkillLabel(plan.compression.skill)}`] : []),
    ...(plan.config.promptAppend !== undefined ? [`Prompt append: ${JSON.stringify(plan.config.promptAppend)}`] : []),
    ...(plan.config.skipVerification ? ['Original verification: skipped (matching cached measurements reused; uncached originals measured once). Candidates still fully verified.'] : []),
    ...(plan.context ? [`Reference context: ${plan.context.manifest.sourceDirectory} · ${plan.context.manifest.files.length} files · ${plan.context.manifest.files.reduce((sum, file) => sum + file.bytes, 0)} bytes · ${plan.context.manifest.sha256.slice(0, 12)}`] : []),
    `Lean ${spec.toolchain.split(':').pop()}${spec.mathlibRev ? ` · Mathlib ${spec.mathlibTag ?? ''} @ ${spec.mathlibRev.slice(0, 12)}` : ' · no Mathlib'}: ${plan.env.ready ? 'matching environment ready' : plan.env.reason}`,
    `Judge: Comparator ${plan.comparator ? 'built' : 'built on the first run'}`,
    `Harness ${plan.config.harness} (${findProfile(plan.config.harness)!.description}) · tools ${findProfile(plan.config.harness)!.trialTools.join(', ')}`,
    `Model ${plan.config.model} · thinking ${plan.config.thinking} · ${plan.config.concurrency} at a time · per trial: ${showLimit(plan.config.timeoutMinutes)} min, ${showLimit(plan.config.maxTurns)} turns, ${showLimit(plan.config.maxCostUsd, n => `$${n}`)}`,
    `${showLimit(plan.maxCostUsd, n => `At most $${n.toFixed(2)}`)} in total; about ${plan.estimateMinutes} min`,
    ...(plan.split === 'test' ? ['Test split: report-only. Its trials are sealed, not for tuning prompts.'] : []),
    ...plan.problems.map(problem => `Cannot run: ${problem}`),
  ];
}

export function createBenchmarkRun(cwd: string, plan: Plan, harness: Harness, maxTotalCostUsd: number | null, startedFrom: BenchmarkRun['startedFrom']): BenchmarkRun {
  if (plan.config.context?.sha256 !== plan.context?.manifest.sha256) throw new Error('Prepared context does not match the run configuration.');
  const research = createRun(cwd, {
    kind: 'benchmark', harness: { ...harness, model: plan.config.model, profile: plan.config.harness },
    goal: { objective: `Evaluate ${plan.config.model} with the ${plan.config.harness} harness on ${plan.benchmark.title}, ${plan.split} split (${plan.tasks.length} tasks)`, successCriteria: ['Every trial judged by Comparator'] },
    benchmark: { benchmarkId: plan.benchmark.id, benchmarkVersion: plan.benchmark.version, split: plan.split },
  });
  const at = new Date().toISOString();
  const queued: BenchmarkTrial[] = plan.tasks.flatMap(task => Array.from({ length: plan.config.repetitions }, (_, index) => ({
    id: plan.config.repetitions > 1 ? `${task.id}#${index + 1}` : task.id, runId: research.id, taskId: task.id, replicate: index + 1, split: plan.split,
    status: 'queued' as const, errors: 0, metrics: {}, artifactIds: [], feedbackIds: [], sealed: plan.split === 'test', updatedAt: at,
  })));
  const run: BenchmarkRun = {
    runId: research.id, benchmarkId: plan.benchmark.id, benchmarkVersion: plan.benchmark.version, split: plan.split,
    taskIds: plan.tasks.map(task => task.id), config: plan.config, trialIds: queued.map(trial => trial.id), status: 'queued',
    startedFrom, sealed: plan.split === 'test', maxTotalCostUsd, createdAt: at, updatedAt: at,
  };
  if (plan.context) writeContextSnapshot(benchRunDir(cwd, run.runId), plan.context);
  if (plan.compression) {
    writeJson(join(benchRunDir(cwd, run.runId), 'inputs/compression.json'), plan.compression);
    run.config = { ...run.config, mode: 'compress', compression: { inputHash: inputHash(plan.compression), rounds: plan.compression.rounds } };
  }
  writeBenchRun(cwd, run);
  for (const trial of queued) saveTrial(cwd, trial);
  return run;
}

/** Whether a run's runner is alive: its heartbeat is recent. */
export function runnerAlive(run: BenchmarkRun): boolean {
  if (!run.runner || Date.now() - Date.parse(run.runner.heartbeatAt) >= settings().staleAfterSeconds * 1000) return false;
  // A recent heartbeat from a process that has since exited (killed, crashed) is not a live runner.
  try { process.kill(run.runner.pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export interface RunnerEvents {
  trialStarted?: (trial: BenchmarkTrial) => void;
  trialFinished?: (trial: BenchmarkTrial) => void;
  progress?: (line: string) => void;
  finished?: (aggregate: Aggregate, run: BenchmarkRun) => void;
}

/** Runs a benchmark run's queued trials (and those a stopped runner left) to the end, or until cancelled. */
export class BenchmarkRunner {
  private compressionController?: AbortController;
  private stopped = false;
  private sessions = new Set<TrialSession>();
  private heartbeat: NodeJS.Timeout | undefined;

  private readonly cwd: string;
  readonly runId: string;
  private readonly sessionEnv: () => Promise<NodeJS.ProcessEnv>;
  private readonly events: RunnerEvents;

  constructor(cwd: string, runId: string, sessionEnv: () => Promise<NodeJS.ProcessEnv>, events: RunnerEvents = {}) {
    this.cwd = cwd;
    this.runId = runId;
    this.sessionEnv = sessionEnv;
    this.events = events;
  }

  cancel() {
    this.stopped = true;
    this.compressionController?.abort();
    for (const session of this.sessions) { void session.abort(); void session.stop(); }
  }

  async run(): Promise<Aggregate> {
    let run = readBenchRun(this.cwd, this.runId);
    if (!run) throw new Error(`No benchmark run ${this.runId}.`);
    if (run.status === 'completed' || run.status === 'cancelled') { cleanupAfterRun(this.cwd, run.runId); return aggregate(this.cwd, run); }
    if (runnerAlive(run) && run.runner!.pid !== process.pid) throw new Error(`${this.runId} is already running (pid ${run.runner!.pid}).`);
    if (run.config.mode === 'compress') {
      clearCancel(this.cwd, this.runId);
      this.compressionController = new AbortController();
      const { runCompressionBenchmark } = await import('./compression-runner.ts');
      return runCompressionBenchmark(this.cwd, run, this.sessionEnv, this.events, this.compressionController.signal);
    }
    if (run.config.mode && run.config.mode !== 'prove') throw new Error(`Unsupported benchmark mode: ${run.config.mode}`);
    const benchmark = findBenchmark(run.benchmarkId);
    if (!benchmark) throw new Error(`Benchmark ${run.benchmarkId} is not known any more.`);
    const spec = benchmark.lean();
    clearCancel(this.cwd, this.runId);
    const sessionStart = Date.now();
    run = { ...run, status: 'running', startedAt: run.startedAt ?? new Date(sessionStart).toISOString(), runner: { pid: process.pid, heartbeatAt: new Date().toISOString(), startedAt: new Date(sessionStart).toISOString() } };
    writeBenchRun(this.cwd, run);
    appendRunEvent(this.cwd, run.runId, 'benchmark.started', { benchmark: run.benchmarkId, split: run.split, trials: run.trialIds.length });
    this.heartbeat = setInterval(() => {
      const current = readBenchRun(this.cwd, this.runId);
      if (current) writeBenchRun(this.cwd, { ...current, runner: { ...current.runner, pid: process.pid, heartbeatAt: new Date().toISOString() } });
      if (cancelRequested(this.cwd, this.runId)) this.cancel();
    }, settings().heartbeatSeconds * 1000);
    this.heartbeat.unref();
    const awake = settings().awake.preventSleep && process.platform === 'darwin'
      ? spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' }) : undefined;
    awake?.on('error', () => this.notify('progress', 'caffeinate could not start; the Mac may sleep during the run.'));
    try {
      verifyContextSnapshot(benchRunDir(this.cwd, run.runId), run.config.context);
      this.notify('progress', 'Preparing the Lean environment…');
      const env = await ensureEnv(spec, line => this.notify('progress', line));
      if (!env.ready) throw new Error(env.reason);
      const extra = trialExtra(run, spec);
      await buildComparator(spec.toolchain, line => this.notify('progress', line));
      const tasks = new Map(benchmark.listTasks().map(task => [task.id, task]));
      // Trials a stopped runner left in flight run again.
      for (const trial of trials(this.cwd, this.runId)) if (trial.status === 'running') saveTrial(this.cwd, { ...trial, status: 'queued' });
      const queue = () => trials(this.cwd, this.runId).filter(trial => trial.status === 'queued');
      const workers = Array.from({ length: run.config.concurrency }, async () => {
        for (;;) {
          if (this.stopped) return;
          if (!await this.waitForNetwork()) return;
          const spent = trials(this.cwd, this.runId).reduce((sum, trial) => sum + (trial.metrics.costUsd ?? 0), 0);
          if (spent >= limit(run!.maxTotalCostUsd)) { this.notify('progress', `Stopping: $${spent.toFixed(2)} spent reaches the cap of $${run!.maxTotalCostUsd}.`); this.stopped = true; return; }
          const next = queue().find(trial => !this.claimed.has(trial.id));
          if (!next) return;
          this.claimed.add(next.id);
          const task = tasks.get(next.taskId);
          if (!task) { saveTrial(this.cwd, { ...next, status: 'error', metrics: { reason: 'the task is no longer in the benchmark' } }); continue; }
          await this.trial(run!, next, task, spec, env.mathlib, extra);
        }
      });
      await Promise.all(workers);
    } catch (error) {
      this.notify('progress', `Benchmark run ${this.runId} stopped: ${error instanceof Error ? error.message : String(error)}`);
      appendRunEvent(this.cwd, this.runId, 'benchmark.error', { reason: error instanceof Error ? error.message : String(error) });
    } finally {
      clearInterval(this.heartbeat);
      awake?.kill();
    }
    const final = readBenchRun(this.cwd, this.runId)!;
    const left = trials(this.cwd, this.runId).filter(trial => trial.status === 'queued' || trial.status === 'running');
    const cancelled = this.stopped || cancelRequested(this.cwd, this.runId);
    if (cancelled) for (const trial of left) saveTrial(this.cwd, { ...trial, status: 'cancelled' });
    const status: BenchmarkRun['status'] = cancelled ? 'cancelled' : left.length ? 'queued' : 'completed';
    const done = { ...final, status, runner: undefined, finishedAt: new Date().toISOString(), wallClockMs: (final.wallClockMs ?? 0) + (Date.now() - sessionStart) };
    writeBenchRun(this.cwd, done);
    const result = aggregate(this.cwd, done);
    appendRunEvent(this.cwd, this.runId, status === 'completed' ? 'benchmark.completed' : status === 'cancelled' ? 'benchmark.cancelled' : 'benchmark.paused', result);
    if (status !== 'queued') setStatus(this.cwd, this.runId, status === 'completed' ? 'completed' : 'cancelled');
    cleanupAfterRun(this.cwd, this.runId, text => this.notify('progress', text));
    this.notify('finished', result, done);
    return result;
  }

  private claimed = new Set<string>();
  /** While the model cannot be reached: when workers may start trials again. */
  private networkUntil = 0;
  private networkWaitedMs = 0;
  private networkStep = 0;
  private networkGaveUp = false;

  /** Waits out an outage; false when the run should pause instead (`benchmarks.network.waitMaxMinutes`). */
  private async waitForNetwork(): Promise<boolean> {
    if (this.networkGaveUp) return false;
    if (Date.now() < this.networkUntil) await sleep(this.networkUntil - Date.now());
    return !this.networkGaveUp && !this.stopped;
  }

  /** Called when a trial could not reach the model at all. */
  private networkDown() {
    const net = settings().network;
    if (Date.now() < this.networkUntil) return;
    const wait = (net.backoffSeconds[Math.min(this.networkStep, net.backoffSeconds.length - 1)] ?? 60) * 1000;
    this.networkStep += 1;
    this.networkWaitedMs += wait;
    if (this.networkWaitedMs > net.waitMaxMinutes * 60_000) {
      this.networkGaveUp = true;
      this.notify('progress', `The model has been unreachable for more than ${net.waitMaxMinutes} min; pausing the run. /benchmark resume continues it.`);
      return;
    }
    this.networkUntil = Date.now() + wait;
    this.notify('progress', `The model cannot be reached (network down, or the Mac asleep); trying again in ${Math.round(wait / 1000)}s.`);
  }

  private networkUp() { this.networkStep = 0; this.networkWaitedMs = 0; }

  /** Calls a listener; one that fails (its session was reloaded or closed) never stops the run. */
  private notify<K extends keyof RunnerEvents>(name: K, ...args: Parameters<NonNullable<RunnerEvents[K]>>) {
    try { (this.events[name] as ((...values: unknown[]) => void) | undefined)?.(...args); } catch { /* the listener's problem, not the run's */ }
  }

  private async trial(run: BenchmarkRun, trial: BenchmarkTrial, task: BenchmarkTask, spec: ReturnType<Benchmark['lean']>, mathlib: string | undefined, extra?: ExtraWorkspace) {
    const workspace = trialDir(this.cwd, run.runId, trial.id);
    rmSync(workspace, { recursive: true, force: true });
    makeLakeProject(workspace, spec, mathlib, { name: 'theoria_trial', libs: ['Solution'], ...(extra ? { extra } : {}) });
    // The trial is a project of its own: its plan and Lean's results for it stay in its folder.
    mkdirSync(join(workspace, '.theoria'), { recursive: true });
    writeFileSync(join(workspace, 'Solution.lean'), task.challenge);
    const readOnly = stageContext(benchRunDir(this.cwd, run.runId), workspace, run.config.context);
    const started = Date.now();
    const commit = theoriaCommitNow();
    let current = saveTrial(this.cwd, {
      ...trial, status: 'running', startedAt: new Date(started).toISOString(), metrics: {},
      harness: { profile: run.config.harness ?? config().harness.default, ...(commit ? { theoriaCommit: commit } : {}) },
    });
    appendRunEvent(this.cwd, run.runId, 'benchmark.trial.started', { trial: trial.id, task: task.id });
    this.notify('trialStarted', current);
    const metrics: TrialMetrics = { turns: 0, costUsd: 0, tokens: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, firstTurnInputTokens: 0, durationMs: 0, rounds: 0 };
    let session: TrialSession | undefined;
    let outcome: { status: BenchmarkTrial['status']; reason: string; comparator?: TrialMetrics['comparator']; network?: boolean };
    try {
      session = new TrialSession(workspace, run.config.model, await this.sessionEnv(), run.config.harness ?? config().harness.default, run.config.thinking ?? settings().defaults.thinking, undefined, readOnly);
      this.sessions.add(session);
      await session.start();
      outcome = await this.drive(session, run, task, spec, mathlib, metrics, workspace, trial, extra);
    } catch (error) {
      outcome = { status: 'error', reason: error instanceof Error ? error.message : String(error) };
      metrics.stoppedBy = 'error';
    } finally {
      if (session) { await session.stop(); this.sessions.delete(session); }
    }
    metrics.durationMs = Date.now() - started;
    metrics.reason = outcome.reason;
    if (outcome.comparator) metrics.comparator = outcome.comparator;
    if (this.stopped && outcome.status !== 'passed') outcome.status = 'cancelled';
    // The model unreachable from the start: not the trial's fault; it waits for the network and runs again, uncounted.
    const unreachable = outcome.status === 'error' && outcome.network === true;
    if (unreachable) this.networkDown(); else if (metrics.tokens > 0) this.networkUp();
    const errors = current.errors + (outcome.status === 'error' && !unreachable ? 1 : 0);
    // An infrastructure error is tried again, within benchmarks.defaults.retries; a failed proof is final.
    const retry = outcome.status === 'error' && (unreachable || errors <= run.config.retries) && !this.stopped;
    if (retry) this.claimed.delete(trial.id);
    current = saveTrial(this.cwd, {
      ...current, status: retry ? 'queued' : outcome.status, errors, artifactIds: this.artifacts(workspace, run.runId, trial.id),
      // A retried attempt keeps its spend on the record; the next attempt starts its own metrics.
      ...(retry ? { metrics: {}, previousAttempts: [...(current.previousAttempts ?? []), metrics] } : { metrics }),
      ...(retry ? {} : { completedAt: new Date().toISOString() }),
    });
    appendRunEvent(this.cwd, run.runId, 'benchmark.trial.completed', { trial: trial.id, status: current.status, reason: outcome.reason, costUsd: metrics.costUsd });
    if (!retry) this.notify('trialFinished', current);
  }

  /** Prompt, wait, judge; on a rejection Comparator's message goes back, within the limits. */
  private async drive(session: TrialSession, run: BenchmarkRun, task: BenchmarkTask, spec: ReturnType<Benchmark['lean']>, mathlib: string | undefined, metrics: TrialMetrics, workspace: string, trial: BenchmarkTrial, extra?: ExtraWorkspace) {
    const deadline = Date.now() + limit(run.config.timeoutMinutes) * 60_000;
    let stop: TrialMetrics['stoppedBy'];
    let settled: (() => void) | undefined;
    let modelError: string | undefined;
    let reconnects = 0;
    let lastJudged: string | undefined;
    let unchangedRounds = 0;
    // Goal mode (benchmarks.escalation): from the start, or after a first attempt that failed.
    const mode = findProfile(run.config.harness ?? config().harness.default)?.trialEscalation ?? 'none';
    const escalation = settings().escalation;
    let phase: 'task' | 'goal' = mode === 'always' ? 'goal' : 'task';
    let turnLimit = phase === 'goal' ? escalation.maxTurns : limit(run.config.maxTurns);
    const started = Date.now();
    const snapshot = () => ({ costUsd: metrics.costUsd, tokensIn: metrics.tokensIn + metrics.cacheRead + metrics.cacheWrite, tokensOut: metrics.tokensOut, turns: metrics.turns, durationMs: Date.now() - started });
    let taskPhase: ReturnType<typeof snapshot> | undefined;
    let agentStartedAt = 0;
    const finish = <T extends { status: BenchmarkTrial['status'] }>(outcome: T, kind?: TrialMetrics['failureKind']): T => {
      const end = snapshot();
      metrics.escalated = phase === 'goal';
      metrics.phases = phase === 'goal'
        ? [...(taskPhase ? [{ phase: 'task' as const, ...taskPhase }] : []), { phase: 'goal' as const, costUsd: end.costUsd - (taskPhase?.costUsd ?? 0), tokensIn: end.tokensIn - (taskPhase?.tokensIn ?? 0), tokensOut: end.tokensOut - (taskPhase?.tokensOut ?? 0), turns: end.turns - (taskPhase?.turns ?? 0), durationMs: end.durationMs - (taskPhase?.durationMs ?? 0) }]
        : [{ phase: 'task', ...end }];
      if (outcome.status === 'failed' && kind) metrics.failureKind = kind;
      return outcome;
    };
    // The plan gate (harness.profiles[].trialPlan = required): no stop with sorry left before a valid proof plan, and
    // with one, the plan's next nodes until they are proved, its angles are abandoned, or it stalls.
    const planMode = findProfile(run.config.harness ?? config().harness.default)?.trialPlan ?? 'none';
    const planSettings = config().plan;
    let planRequests = 0;
    let planStalls = 0;
    let lastProgress = -1;
    let planEnd: string | undefined;
    let planWasValid = false;
    const planKind = (fallback: NonNullable<TrialMetrics['failureKind']>): NonNullable<TrialMetrics['failureKind']> =>
      planMode === 'required' ? (planWasValid ? 'planned' : 'no-plan') : fallback;
    const planGate = async (): Promise<string | undefined> => {
      if (planMode !== 'required' || stop || Date.now() >= deadline) return undefined;
      const check = await checkPlan(workspace, undefined, { refresh: true, target: { file: 'Solution.lean', name: task.theorems[0]! } });
      metrics.plan = { exists: check.exists, valid: check.valid, angles: readPlan(workspace)?.angles.length ?? 0, nodes: check.views.length, proved: check.proved, total: check.total };
      const left = `About ${showLimit(run.config.timeoutMinutes, () => String(Math.max(0, Math.floor((deadline - Date.now()) / 60_000))))} min and ${showLimit(run.config.maxCostUsd, n => `$${Math.max(0, n - metrics.costUsd).toFixed(2)}`)} of this task's budget are left.`;
      // Every angle abandoned, with reasons: the agent's considered end, whatever the skeleton looks like now.
      if (check.exists && check.allAbandoned) {
        planWasValid ||= check.proved > 0 || check.views.some(view => view.node.lean);
        planEnd = 'every attack angle was abandoned';
        return undefined;
      }
      if (!check.valid) {
        if (planRequests >= planSettings.planRounds) { planEnd = `no valid plan after ${planRequests} request(s): ${check.problems[0] ?? ''}`; return undefined; }
        planRequests += 1;
        return [...(check.exists ? [`Your plan is not a valid proof skeleton yet:`, ...check.problems.map(problem => `- ${problem}`)] : planSettings.requestLines), '', left].join('\n');
      }
      planWasValid = true;
      const progress = check.proved * 1000 + check.views.length;
      planStalls = progress > lastProgress ? 0 : planStalls + 1;
      lastProgress = Math.max(lastProgress, progress);
      if (planStalls >= planSettings.stallRounds) { planEnd = `the plan made no progress in ${planStalls} rounds`; return undefined; }
      const current = readPlan(workspace)!;
      return [
        `Plan check (Lean): ${check.proved} of ${check.total} nodes proved${check.objective ? `; ${check.objective.detail}` : ''}.`,
        ...describePlan(current, check).slice(-1),
        'Continue with the next node. If the active angle is blocked, switch to another (plan switch) or abandon it with the reason (plan abandon).',
        left,
      ].join('\n');
    };
    /** Escalates a failed first attempt to goal mode, when the profile does and enough budget is left. */
    const escalate = (): string | undefined => {
      if (mode !== 'on-failure' || phase === 'goal' || stop) return undefined;
      if (deadline - Date.now() < escalation.minMinutesLeft * 60_000 || limit(run.config.maxCostUsd) - metrics.costUsd < escalation.minCostLeftUsd) return undefined;
      taskPhase = snapshot();
      phase = 'goal';
      turnLimit = metrics.turns + escalation.maxTurns;
      unchangedRounds = 0;
      return goalCommand(task, spec, run.config);
    };
    session.on((event: RpcEvent) => {
      if (event.type === 'agent_start') agentStartedAt = Date.now();
      if (event.type === 'turn_end') { metrics.turns += 1; if (metrics.turns >= turnLimit && !stop) { stop = 'turns'; void session.abort(); } }
      if (event.type === 'message_end') {
        const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } } } | undefined;
        if (message?.role === 'assistant' && message.stopReason === 'error') modelError = message.errorMessage ?? 'the model call failed';
        if (message?.role === 'assistant' && message.usage) {
          metrics.costUsd += message.usage.cost?.total ?? 0;
          if (!metrics.tokens) metrics.firstTurnInputTokens = (message.usage.input ?? 0) + (message.usage.cacheRead ?? 0) + (message.usage.cacheWrite ?? 0);
          metrics.tokens += message.usage.totalTokens ?? 0;
          metrics.tokensIn += message.usage.input ?? 0;
          metrics.tokensOut += message.usage.output ?? 0;
          metrics.cacheRead += message.usage.cacheRead ?? 0;
          metrics.cacheWrite += message.usage.cacheWrite ?? 0;
          if (metrics.costUsd >= limit(run.config.maxCostUsd) && !stop) { stop = 'cost'; void session.abort(); }
        }
      }
      if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(String(event.method))) session.refuse(String(event.id));
      if (event.type === 'agent_settled') settled?.();
    });
    const cancelTimer = deadlineTimer(Math.max(0, deadline - Date.now()), () => { stop ??= 'timeout'; void session.abort(); settled?.(); });
    try {
      let message = phase === 'goal' ? goalCommand(task, spec, run.config) : trialPrompt(task, spec, run.config);
      for (let round = 0; ; round += 1) {
        metrics.rounds = round + 1;
        const idle = new Promise<void>(resolve => { settled = resolve; });
        const accepted = await session.prompt(message);
        if (accepted.success === false) throw new Error(String(accepted.error ?? 'the prompt was refused'));
        const exited = session.exited.then(() => { throw new Error(`the trial session exited: ${session.stderr.trim().split('\n').slice(-3).join(' ')}`); });
        await Promise.race([idle, exited]);
        // In goal mode pi-goal-x starts the next turn itself shortly after the session settles. Each time the goal
        // pauses with a changed Solution.lean, Comparator judges it at once: a pass ends the trial there (the goal's
        // own continuations would only cost more), anything else lets the goal go on.
        while (phase === 'goal' && !stop && Date.now() < deadline) {
          const current = readSolution(workspace);
          const hash = current ? createHash('sha256').update(current).digest('hex') : undefined;
          if (current && hash !== lastJudged && current !== task.challenge) {
            lastJudged = hash;
            const early = await judge(evalDir(this.cwd, run.runId, trial.id), spec, mathlib, task, current, extra);
            if (early.verdict === 'passed') {
              void session.abort();
              metrics.stoppedBy = 'agent';
              return finish({ status: 'passed' as const, reason: early.reason, comparator: early.verdict });
            }
          }
          const settledAt = Date.now();
          const next = new Promise<void>(resolve => { settled = resolve; });
          await sleep(escalation.settleGraceSeconds * 1000);
          if (agentStartedAt < settledAt) break;
          await Promise.race([next, exited]);
        }
        if (this.stopped) { stop = 'cancelled'; return { status: 'cancelled' as const, reason: 'cancelled' }; }
        // The model could not be reached: an infrastructure error, not the agent failing the task.
        if (modelError && metrics.tokens === 0) { metrics.stoppedBy = 'error'; return { status: 'error' as const, reason: `the model could not be reached: ${modelError}`, network: true }; }
        // The connection dropped mid-trial: the same conversation continues, after a pause, a few times.
        if (modelError) {
          if (reconnects >= settings().network.reconnectRounds || stop || Date.now() >= deadline) {
            metrics.stoppedBy = 'error';
            return { status: 'error' as const, reason: `the connection to the model dropped ${reconnects + 1} times: ${modelError}` };
          }
          reconnects += 1;
          const wait = (settings().network.backoffSeconds[Math.min(reconnects - 1, settings().network.backoffSeconds.length - 1)] ?? 60) * 1000;
          await sleep(Math.min(wait, Math.max(0, deadline - Date.now())));
          modelError = undefined;
          message = 'The connection to the model dropped. Continue where you left off; Solution.lean is as you left it.';
          round -= 1;
          continue;
        }
        const solution = readSolution(workspace);
        if (!solution) return { status: 'failed' as const, reason: 'Solution.lean is missing' };
        // An unchanged file has the verdict it had (or, untouched, the challenge's own sorry): Comparator is not run
        // again, and the agent is told how much budget is left instead of the same rejection once more.
        const hash = createHash('sha256').update(solution).digest('hex');
        const untouched = solution === task.challenge;
        if (untouched || hash === lastJudged) {
          const why = untouched ? 'Solution.lean is still the untouched challenge, with its sorry' : 'Solution.lean has not changed since Comparator rejected it';
          // A plan first, when the profile requires one; then goal mode, when it escalates.
          const planned = await planGate();
          if (planned) { message = planned; round -= 1; unchangedRounds = 0; continue; }
          const goal = escalate();
          if (goal) { message = goal; round -= 1; continue; }
          if (planMode !== 'required' && !stop && unchangedRounds < (run.config.continueRounds ?? settings().defaults.continueRounds) && Date.now() < deadline) {
            unchangedRounds += 1;
            round -= 1;
            const minutesLeft = Math.max(0, Math.floor((deadline - Date.now()) / 60_000));
            message = `${why}, so it was not checked again. About ${showLimit(run.config.timeoutMinutes, () => String(minutesLeft))} min and ${showLimit(run.config.maxCostUsd, n => `$${Math.max(0, n - metrics.costUsd).toFixed(2)}`)} of this task's budget are left. Continue working on the proof, or say that you are stopping.`;
            continue;
          }
          metrics.stoppedBy = stop ?? 'agent';
          return finish({ status: 'failed' as const, reason: `gave up: ${why}${stop ? ` (stopped: ${stop})` : ''}${planEnd ? ` (${planEnd})` : ''}`, comparator: untouched ? undefined : 'rejected' as const }, stop ? 'limit' : planKind('gave-up'));
        }
        lastJudged = hash;
        unchangedRounds = 0;
        // A file that still uses sorry cannot pass: Comparator is not run on it (a sorry only in a comment is still counted).
        const sorries = sorryCount(solution);
        const judgement = sorries
          ? { verdict: 'rejected' as const, reason: `Solution.lean still uses sorry (${sorries} place${sorries === 1 ? '' : 's'}); Comparator was not run`, log: '' }
          : await judge(evalDir(this.cwd, run.runId, trial.id), spec, mathlib, task, solution, extra);
        if (judgement.verdict === 'unavailable') return { status: 'error' as const, reason: judgement.reason, comparator: judgement.verdict };
        if (judgement.verdict === 'passed') { metrics.stoppedBy = stop ?? 'agent'; return finish({ status: 'passed' as const, reason: judgement.reason, comparator: judgement.verdict }); }
        // With sorry left, the plan decides what comes next (when the profile requires one).
        if (sorries && planMode === 'required') {
          const planned = await planGate();
          if (planned) { message = planned; round = -1; continue; }
          metrics.stoppedBy = stop ?? 'agent';
          return finish({ status: 'failed' as const, reason: `${judgement.reason}${stop ? ` (stopped: ${stop})` : ''}${planEnd ? ` (${planEnd})` : ''}`, comparator: judgement.verdict }, stop ? 'limit' : planKind('incomplete'));
        }
        if (stop || round >= run.config.feedbackRounds || Date.now() >= deadline) {
          const goal = escalate();
          if (goal) { message = `Comparator rejected Solution.lean: ${judgement.reason}\n\n${goal}`; round = -1; continue; }
          metrics.stoppedBy = stop ?? 'agent';
          return finish({ status: 'failed' as const, reason: `${judgement.reason}${stop ? ` (stopped: ${stop})` : ''}`, comparator: judgement.verdict }, stop ? 'limit' : sorries ? 'incomplete' : 'rejected');
        }
        message = sorries
          ? `${judgement.reason}. Prove what is left, or say that you are stopping.`
          : `Comparator rejected Solution.lean: ${judgement.reason}\n\nIts output ended with:\n${judgement.log.split('\n').slice(-12).join('\n')}\n\nFix Solution.lean and check it again. The statement of ${task.theorems.join(', ')} and the definitions it uses must stay exactly as given.`;
      }
    } finally {
      cancelTimer();
    }
  }

  /** The trial's solution, Comparator's log and the transcript, as artifacts of the benchmark run. */
  private artifacts(workspace: string, runId: string, trialId: string): string[] {
    const files: { path: string; kind: 'benchmark-result' | 'result' | 'trajectory' }[] = [{ path: join(workspace, 'Solution.lean'), kind: 'benchmark-result' }];
    const log = join(evalDir(this.cwd, runId, trialId), 'comparator.log');
    if (existsSync(log)) files.push({ path: log, kind: 'result' });
    const sessions = join(workspace, 'session');
    try { for (const name of readdirSync(sessions).filter(entry => entry.endsWith('.jsonl'))) files.push({ path: join(sessions, name), kind: 'trajectory' }); } catch { /* none */ }
    return files.flatMap(file => {
      try { return [registerArtifact(this.cwd, { path: file.path, kind: file.kind, runId, metadata: { trial: trialId } }).artifact.id]; } catch { return []; }
    });
  }
}

/**
 * The task as the trial agent gets it: the same words under every harness. What tools a harness has, and how to use
 * them, is the harness's own business (its system prompt), so a comparison measures the harness, not the task text.
 */
export function trialPrompt(task: BenchmarkTask, spec: ReturnType<Benchmark['lean']>, cfg: BenchmarkRunConfig): string {
  return appendPrompt(appendContext([
    `This folder is a Lean 4 project (${spec.toolchain.split(':').pop()}${spec.mathlibRev ? `, Mathlib ${spec.mathlibTag ?? spec.mathlibRev.slice(0, 12)}` : ', no Mathlib'}). Solution.lean states ${task.theorems.length === 1 ? 'a theorem' : 'theorems'} with \`sorry\`:`,
    ...task.theorems.map(name => `- ${name}`),
    '',
    'Replace the sorry with a complete proof. Rules, checked by Comparator afterwards:',
    '- keep the statement and every definition it uses exactly as given; you may add your own definitions and lemmas before it;',
    '- no sorry, no new axioms, no metaprogramming that adds declarations, only the standard axioms;',
    '- check your work with `lake lean Solution.lean` in this folder (it applies the project\'s Lean options);',
    `Task limits: ${showLimit(cfg.timeoutMinutes)} minutes, ${showLimit(cfg.maxCostUsd, n => `$${n}`)}. When Solution.lean checks, stop and say DONE.`,
    ...(task.informal ? ['', 'Informal statement:', task.informal] : []),
    '', '```lean', task.challenge.trim(), '```',
  ].join('\n'), cfg.context), cfg.promptAppend);
}

/**
 * The message that starts goal mode: pi-goal-x's `/goal-direct` with the task and `benchmarks.escalation.goalLines`
 * (the last a verification contract pi-goal-x reads). Comparator remains the judge: the goal's own completion is not
 * success.
 */
export function goalCommand(task: BenchmarkTask, spec: ReturnType<Benchmark['lean']>, cfg: BenchmarkRunConfig): string {
  return `/goal-direct ${[trialPrompt(task, spec, cfg), '', ...settings().escalation.goalLines].join('\n')}`;
}

/** Why a harness profile's Lean add-on cannot run on this benchmark's Mathlib, if it cannot. */
export function extraProblem(name: string, spec: ReturnType<Benchmark['lean']>): string | undefined {
  const version = spec.mathlibTag;
  if (!version || !spec.mathlibRev) return `the add-on ${name} needs Mathlib, which this benchmark does not use`;
  const state = extraState(name, version);
  if (!state.ready) return state.problem;
  const head = spawnSync('git', ['-C', join(state.dir, '.lake', 'packages', 'mathlib'), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  if (head !== spec.mathlibRev) return `${state.title}'s Mathlib is at ${head.slice(0, 12)}, the benchmark's at ${spec.mathlibRev.slice(0, 12)}`;
  if (readFileSync(join(state.dir, 'lean-toolchain'), 'utf8').trim() !== spec.toolchain) return `${state.title}'s Lean toolchain does not match the benchmark's ${spec.toolchain}`;
  if (spec.manifest) {
    const expected = JSON.parse(spec.manifest).packages as { name: string; rev?: string }[];
    const actual = JSON.parse(readFileSync(join(state.dir, 'lake-manifest.json'), 'utf8')).packages as { name: string; rev?: string }[];
    for (const dependency of expected) {
      if (actual.find(entry => entry.name === dependency.name)?.rev !== dependency.rev) return `${state.title}'s ${dependency.name} dependency differs from the benchmark's pin`;
    }
  }
  return undefined;
}

/** The add-on workspace a run's trials and judge build on. Never silently fall back when it is unavailable. */
export function trialExtra(run: BenchmarkRun, spec: ReturnType<Benchmark['lean']>): ExtraWorkspace | undefined {
  const profile = findProfile(run.config.harness ?? config().harness.default);
  if (!profile) throw new Error(`The run's harness profile ${run.config.harness} is no longer configured.`);
  const name = profile.leanExtras[0];
  if (!name) return undefined;
  const problem = extraProblem(name, spec);
  if (problem) throw new Error(problem);
  const definition = extraSpec(name)!;
  const rev = definition.versions.find(entry => entry.mathlib === spec.mathlibTag)!.rev;
  return { dir: extraDir(name, spec.mathlibTag!), package: definition.package, repo: definition.repo, rev };
}

/** The uses of `sorry` in Lean source outside comments and strings. */
export function sorryCount(source: string): number {
  const code = source.replace(/\/-[\s\S]*?-\//g, '').replace(/--.*$/gm, '').replace(/"(?:[^"\\]|\\.)*"/g, '""');
  return (code.match(/\bsorry\b/g) ?? []).length;
}

export const benchmarkDir = benchRunDir;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
