import { terminalWorkerEnv } from '@theoria/pi-telegram/credentials';
import { config } from '@theoria/shared/config';
import { listRuns, setStatus, type Harness } from '@theoria/pi-research/api';
import { comparatorReady, buildComparator } from './comparator.ts';
import { ensureEnv, envState } from './env.ts';
import { benchmarks, findBenchmark } from './registry.ts';
import { BenchmarkRunner, createBenchmarkRun, planLines, planRun, runnerAlive, type Plan, type PlanOptions, type RunnerEvents } from './runner.ts';
import { splitCounts, splitsFor } from './splits.ts';
import { aggregate, benchRunDir, readBenchRun, requestCancel, saveTrial, trialDir, trials, writeBenchRun, type Aggregate } from './store.ts';
import { appendRunEvent } from '@theoria/shared/events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchmarkRun, BenchmarkRunConfig } from './types.ts';
import { sourceHash } from '@theoria/pi-workflows/api';
import { splitArgs, compressionSkillArgs } from '@theoria/pi-workflows/api';
import { formatRunStatus, statusReader } from './live-status.ts';
import { duration, money, tokens } from './status-format.ts';
import { validatePromptAppend } from './prompt.ts';
export { money, tokens, duration, trialUsage, usageLines } from './status-format.ts';

/**
 * The benchmark operations behind `/benchmark` in the terminal and in the bot: the same text grammar and results for
 * both, so Telegram and the terminal show the same thing. The runner runs in the process that started it; a run whose
 * runner stopped (the terminal closed, the bot restarted) is resumed with `resume`.
 */

export const benchmarkUsage = '/benchmark list · install <id> · run <id> [train|val|test] [N | task,task] [harness=<profile>] [thinking=<level>] [repeat=k] [cost=$] [concurrency=c] [timeout=min] [context-dir=<directory>] [prompt-append="additional instructions"] [mode=compress corpus=<manifest> [skill=<file>|none] rounds=2 skip-verification=true] · status [run] · compare <run> <run> · resume [run] · cancel [run] · corpus import <id> <source> <manifest>';

const active = new Map<string, BenchmarkRunner>();
export const activeRunners = () => [...active.keys()];

export async function listText(): Promise<string> {
  const lines: string[] = [];
  for (const benchmark of benchmarks) {
    if (!benchmark.installed()) { lines.push(`${benchmark.id} — ${benchmark.title}: not installed (/benchmark install ${benchmark.id})`, `  ${benchmark.description}`); continue; }
    const counts = splitCounts(splitsFor(benchmark));
    const spec = benchmark.lean();
    const env = await envState(spec);
    lines.push(
      `${benchmark.id} — ${benchmark.title} @ ${benchmark.version}: ${benchmark.listTasks().length} tasks (${Object.entries(counts).map(([split, count]) => `${split} ${count}`).join(', ')})`,
      `  ${benchmark.description}`,
      `  Lean ${spec.toolchain.split(':').pop()}${spec.mathlibRev ? ` · Mathlib ${spec.mathlibTag ?? ''} @ ${spec.mathlibRev.slice(0, 12)}` : ''}${Object.keys(spec.leanOptions).length ? ` · options ${Object.entries(spec.leanOptions).map(([key, value]) => `${key}=${value}`).join(', ')}` : ''}`,
      `  ${env.ready ? 'Environment ready' : `Environment: ${env.reason}`} · Comparator ${comparatorReady(spec.toolchain) ? 'built' : 'not built yet'}`,
      ...(benchmark.reference ? [`  Reference: ${benchmark.reference}`] : []),
    );
  }
  return lines.join('\n');
}

export async function install(id: string, onLine?: (line: string) => void): Promise<string> {
  const benchmark = findBenchmark(id);
  if (!benchmark) throw new Error(`No benchmark ${id}. Known: ${benchmarks.map(entry => entry.id).join(', ')}.`);
  await benchmark.install(onLine);
  const counts = splitCounts(splitsFor(benchmark));
  const spec = benchmark.lean();
  const env = await ensureEnv(spec, onLine);
  await buildComparator(spec.toolchain, onLine);
  return `${benchmark.title} @ ${benchmark.version}: ${benchmark.listTasks().length} tasks, splits frozen (${Object.entries(counts).map(([split, count]) => `${split} ${count}`).join(', ')}). `
    + `${env.ready ? 'Lean environment ready' : `Lean environment not ready: ${env.reason}`}; Comparator built for ${spec.toolchain.split(':').pop()}.`;
}

/** `run <id> [split] [N|tasks] [key=value…]` into plan options. */
export function parseRunArgs(args: string, model: string, startedFrom: BenchmarkRun['startedFrom'], cwd = process.cwd()): PlanOptions {
  const { args: words, skill } = compressionSkillArgs(splitArgs(args));
  const [benchmarkId = '', ...rest] = words;
  const overrides: Partial<BenchmarkRunConfig> = {};
  let split: string | undefined;
  let tasks: string | undefined;
  const compression: Record<string, string> = skill === undefined ? {} : { skill };
  const splitNames = [...new Set(['train', 'val', 'test', ...config().benchmarks.splits.shares.map(entry => entry.split)])];
  for (const word of rest) {
    if (word.startsWith('skip-verification=')) {
      if (overrides.skipVerification !== undefined) throw new Error('Specify skip-verification only once.');
      const value = word.slice('skip-verification='.length);
      if (!['true', 'false'].includes(value)) throw new Error('skip-verification must be true or false.');
      overrides.skipVerification = value === 'true';
      continue;
    }
    if (word.startsWith('context-dir=')) {
      if (overrides.contextDir !== undefined) throw new Error('Specify context-dir only once.');
      const path = word.slice('context-dir='.length);
      if (!path.trim()) throw new Error('context-dir must be a nonempty directory path.');
      overrides.contextDir = path;
      continue;
    }
    if (word.startsWith('prompt-append=')) {
      if (overrides.promptAppend !== undefined) throw new Error('Specify prompt-append only once.');
      const text = word.slice('prompt-append='.length);
      validatePromptAppend(text);
      overrides.promptAppend = text;
      continue;
    }
    const special = /^(mode|corpus|rounds)=(.+)$/.exec(word);
    if (special) { compression[special[1]!] = special[2]!; continue; }
    const harness = /^harness=([\w.-]+)$/.exec(word);
    const thinking = /^thinking=(\w+)$/.exec(word);
    const option = /^(repeat|cost|concurrency|timeout|turns)=(\d+(?:\.\d+)?)$/.exec(word);
    if (harness) overrides.harness = harness[1]!;
    else if (thinking) overrides.thinking = thinking[1]!;
    else if (option) {
      const value = Number(option[2]);
      if (option[1] === 'repeat') overrides.repetitions = Math.max(1, Math.floor(value));
      if (option[1] === 'cost') overrides.maxCostUsd = value;
      if (option[1] === 'concurrency') overrides.concurrency = Math.floor(value);
      if (option[1] === 'timeout') overrides.timeoutMinutes = value;
      if (option[1] === 'turns') overrides.maxTurns = Math.floor(value);
    } else if (splitNames.includes(word)) split = word;
    else tasks = word;
  }
  if (compression.mode && !['prove', 'compress'].includes(compression.mode)) throw new Error('mode must be prove or compress.');
  if (compression.mode !== 'compress' && ['corpus', 'skill', 'rounds'].some(key => compression[key])) throw new Error('corpus, skill and rounds require mode=compress.');
  if (compression.mode === 'compress' && !compression.corpus) throw new Error('Compression benchmarks require corpus=<manifest>.');
  if (overrides.skipVerification && compression.mode !== 'compress') throw new Error('skip-verification requires mode=compress.');
  const rounds = compression.rounds === undefined ? config().benchmarks.compression.rounds : Number(compression.rounds);
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error('rounds must be a positive integer.');
  return { benchmarkId, ...(split ? { split } : {}), ...(tasks ? { tasks } : {}), model, overrides, startedFrom, cwd,
    ...(compression.mode === 'compress' ? { compression: { corpus: compression.corpus!, ...(skill !== undefined ? { skill } : {}), rounds } } : {}) };
}

export async function plan(options: PlanOptions): Promise<Plan> { return planRun(options); }
export { planLines };

/** Creates the run and starts its runner in this process, without waiting. */
export function start(cwd: string, planned: Plan, harness: Harness, maxTotalCostUsd: number | null, startedFrom: BenchmarkRun['startedFrom'], env: () => Promise<NodeJS.ProcessEnv>, events: RunnerEvents = {}): BenchmarkRun {
  const run = createBenchmarkRun(cwd, planned, harness, maxTotalCostUsd, startedFrom);
  launch(cwd, run.runId, env, events);
  return run;
}

export function launch(cwd: string, runId: string, env: () => Promise<NodeJS.ProcessEnv>, events: RunnerEvents = {}) {
  if (active.has(runId)) throw new Error(`${runId} is already running here.`);
  const runner = new BenchmarkRunner(cwd, runId, env, events);
  active.set(runId, runner);
  void runner.run().catch(error => events.progress?.(`${runId}: ${error instanceof Error ? error.message : String(error)}`)).finally(() => active.delete(runId));
}

export function cancel(cwd: string, runId: string): string {
  const run = readBenchRun(cwd, runId);
  if (!run) return `No benchmark run ${runId}.`;
  if (run.status === 'completed' || run.status === 'cancelled') return `${runId} is already ${run.status}.`;
  requestCancel(cwd, runId);
  if (active.has(runId)) { active.get(runId)!.cancel(); return `Cancelling ${runId}: trials in flight are stopped and recorded as cancelled.`; }
  if (runnerAlive(run)) return `Cancelling ${runId}: its runner (pid ${run.runner!.pid}) stops it within ${config().benchmarks.heartbeatSeconds}s.`;
  // No runner is working on it (it stopped midway): cancelled here, at once.
  for (const trial of trials(cwd, runId)) if (trial.status === 'queued' || trial.status === 'running') saveTrial(cwd, { ...trial, status: 'cancelled', completedAt: new Date().toISOString() });
  const done = { ...run, status: 'cancelled' as const, runner: undefined, finishedAt: new Date().toISOString() };
  writeBenchRun(cwd, done);
  aggregate(cwd, done);
  appendRunEvent(cwd, runId, 'benchmark.cancelled', { by: 'user', runnerStopped: true });
  setStatus(cwd, runId, 'cancelled', 'cancelled after its runner stopped');
  return `Cancelled ${runId}: its runner had stopped; its unfinished trials are recorded as cancelled.`;
}

/** The benchmark runs of a project, newest first. */
export function benchmarkRuns(cwd: string): BenchmarkRun[] {
  return listRuns(cwd).filter(run => run.kind === 'benchmark').reverse().flatMap(run => { const bench = readBenchRun(cwd, run.id); return bench ? [bench] : []; });
}

/** Runs whose runner stopped with trials left. */
export const stoppedRuns = (cwd: string) => benchmarkRuns(cwd).filter(run => (run.status === 'running' || run.status === 'queued') && !runnerAlive(run) && !active.has(run.runId));

export function statusText(cwd: string, runId?: string): { text: string; aggregate?: Aggregate } {
  const runs = benchmarkRuns(cwd);
  const run = runId ? runs.find(entry => entry.runId === runId) : runs[0];
  if (!run) return { text: runId ? `No benchmark run ${runId}.` : 'No benchmark runs in this project yet. /benchmark run <id> starts one.' };
  const snapshot = statusReader.run(cwd, run.runId)!;
  return { text: formatRunStatus(snapshot), aggregate: snapshot.aggregate };
}

/**
 * Backwards-compatible transcript reader. Compression status uses its persisted metrics and current attempt.
 */
export function liveProgress(workspace: string, trial: { startedAt?: string }): { metrics: import('./types.ts').TrialMetrics; last?: string; idleMs?: number; elapsedMs: number } {
  const { metrics, activity } = statusReader.session(workspace, trial.startedAt);
  return { metrics, last: activity?.text, idleMs: activity ? Math.max(0, Date.now() - Date.parse(activity.at)) : undefined, elapsedMs: metrics.durationMs };
}

/**
 * Two benchmark runs side by side. Refused unless they differ in the harness only: the same benchmark version, split,
 * tasks, model and limits, so what differs in the results is what the harness did.
 */
const goalCost = (list: { metrics: Partial<import('./types.ts').TrialMetrics> }[]) => list.reduce((sum, trial) => sum + (trial.metrics.phases?.find(entry => entry.phase === 'goal')?.costUsd ?? 0), 0);

export function compareRuns(cwd: string, first: string, second: string): { ok: boolean; text: string } {
  const a = readBenchRun(cwd, first);
  const b = readBenchRun(cwd, second);
  if (!a || !b) return { ok: false, text: `No benchmark run ${!a ? first : second}.` };
  if (a.config.mode === 'compress' || b.config.mode === 'compress') return compareCompressionRuns(cwd, a, b);
  const same = (label: string, x: unknown, y: unknown) => (JSON.stringify(x) === JSON.stringify(y) ? [] : [`${label}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`]);
  const differences = [
    ...same('benchmark', `${a.benchmarkId}@${a.benchmarkVersion}`, `${b.benchmarkId}@${b.benchmarkVersion}`),
    ...same('split', a.split, b.split),
    ...same('tasks', [...a.taskIds].sort(), [...b.taskIds].sort()),
    ...same('model', a.config.model, b.config.model),
    ...same('thinking', a.config.thinking ?? 'medium', b.config.thinking ?? 'medium'),
    ...same('appended prompt', a.config.promptAppend, b.config.promptAppend),
    ...same('baseline verification', !!a.config.skipVerification, !!b.config.skipVerification),
    ...same('reference context', a.config.context?.sha256, b.config.context?.sha256),
    ...(['repetitions', 'timeoutMinutes', 'maxTurns', 'maxCostUsd', 'feedbackRounds'] as const).flatMap(key => same(key, a.config[key], b.config[key])),
  ];
  if (differences.length) return { ok: false, text: ['Not comparable: the runs differ in more than the harness.', ...differences.map(line => `  ${line}`)].join('\n') };
  const ra = aggregate(cwd, a);
  const rb = aggregate(cwd, b);
  const ta = trials(cwd, a.runId);
  const tb = trials(cwd, b.runId);
  const firstTurn = (list: typeof ta) => { const values = list.map(trial => trial.metrics.firstTurnInputTokens ?? 0).filter(Boolean); return values.length ? values.reduce((x, y) => x + y, 0) / values.length : 0; };
  const solved = (list: typeof ta) => new Set(list.filter(trial => trial.status === 'passed').map(trial => trial.taskId));
  const sa = solved(ta);
  const sb = solved(tb);
  const ha = a.config.harness ?? config().harness.default;
  const hb = b.config.harness ?? config().harness.default;
  const width = Math.max(ha.length, hb.length, 8);
  const row = (label: string, x: string, y: string) => `${label.padEnd(22)}${x.padEnd(width + 14)}${y}`;
  const pct = (r: Aggregate) => `${r.passed}/${r.passed + r.failed} (${(r.passRate * 100).toFixed(1)}%)`;
  return {
    ok: true,
    text: [
      `${a.benchmarkId} @ ${a.benchmarkVersion} · ${a.split} · ${a.taskIds.length} tasks · ${a.config.model} · judged by Comparator`,
      row('', `${a.runId} ${ha}`, `${b.runId} ${hb}`),
      row('passed', pct(ra), pct(rb)),
      row('errors', String(ra.errors), String(rb.errors)),
      row('cost', money(ra.costUsd), money(rb.costUsd)),
      row('cost per solved task', ra.costPerPassUsd === null ? '—' : money(ra.costPerPassUsd), rb.costPerPassUsd === null ? '—' : money(rb.costPerPassUsd)),
      row('wall-clock', duration(ra.wallClockMs), duration(rb.wallClockMs)),
      row('mean trial time', duration(ra.meanDurationMs), duration(rb.meanDurationMs)),
      row('tokens in', tokens(ra.tokensIn + ra.cacheRead + ra.cacheWrite), tokens(rb.tokensIn + rb.cacheRead + rb.cacheWrite)),
      row('tokens out', tokens(ra.tokensOut), tokens(rb.tokensOut)),
      row('first-call context', tokens(Math.round(firstTurn(ta))), tokens(Math.round(firstTurn(tb)))),
      row('valid plan (failed trials)', String(ta.filter(trial => trial.metrics.plan?.valid).length), String(tb.filter(trial => trial.metrics.plan?.valid).length)),
      row('escalated to a goal', String(ta.filter(trial => trial.metrics.escalated).length), String(tb.filter(trial => trial.metrics.escalated).length)),
      row('goal-phase cost', money(goalCost(ta)), money(goalCost(tb))),
      `Solved only with ${ha}: ${[...sa].filter(task => !sb.has(task)).join(', ') || 'none'}`,
      `Solved only with ${hb}: ${[...sb].filter(task => !sa.has(task)).join(', ') || 'none'}`,
      ...(a.taskIds.length < 30 ? [`With ${a.taskIds.length} tasks, a difference of a few solved tasks is within chance.`] : []),
    ].join('\n'),
  };
}

function compareCompressionRuns(cwd: string, a: BenchmarkRun, b: BenchmarkRun) {
  if (a.config.mode !== 'compress' || b.config.mode !== 'compress') return { ok: false, text: 'Cannot compare proving and compression runs.' };
  const load = (run: BenchmarkRun) => JSON.parse(readFileSync(join(benchRunDir(cwd, run.runId), 'inputs/compression.json'), 'utf8'));
  const x = load(a); const y = load(b);
  const identity = (run: BenchmarkRun, input: typeof x) => sourceHash(JSON.stringify({ ...input, skill: undefined, prompt: input.prompt,
    tasks: [...input.tasks].sort((left, right) => left.task.id.localeCompare(right.task.id)), model: run.config.model,
    config: { ...run.config, compression: undefined }, split: run.split }));
  if (identity(a, x) !== identity(b, y)) return { ok: false, text: 'Compression runs differ in corpus, tasks, environment, model, code, prompts, policy or limits.' };
  const left = aggregate(cwd, a); const right = aggregate(cwd, b);
  return { ok: true, text: `${a.runId}: ${left.compression?.meanScore.toFixed(2)}% · ${left.passed} improved · ${money(left.costUsd)}\n${b.runId}: ${right.compression?.meanScore.toFixed(2)}% · ${right.passed} improved · ${money(right.costUsd)}` };
}

/** The environment a trial gets from a terminal: the credential broker for the AWS profile, API keys from the Keychain. */
export const terminalTrialEnv = terminalWorkerEnv;
