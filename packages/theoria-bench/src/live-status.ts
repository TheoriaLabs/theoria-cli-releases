import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@theoria/shared/config';
import { showLimit } from '@theoria/shared/limits';
import { benchRunDir, summarizeTrials, trialDir, type Aggregate } from './store.ts';
import type { BenchmarkRun, BenchmarkTrial, TrialMetrics } from './types.ts';
import { duration, money, trialUsage, usageLines } from './status-format.ts';

type Activity = { text: string; at: string };
interface Checkpoint { round: number; lines: number; heartbeats: number; compress_score: number }
interface Report { best: Checkpoint; roundsRequested: number; roundsCompleted: number; outcome: string; reason: string }
export interface TrialStatus {
  trial: BenchmarkTrial;
  metrics: Partial<TrialMetrics>;
  activity?: Activity;
  checkpoint?: Checkpoint;
  report?: Report;
  reason?: string;
}
export interface RunStatus {
  run: BenchmarkRun;
  trials: TrialStatus[];
  aggregate: Aggregate;
  owner: string;
  heartbeatAge?: number;
  now: number;
}
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
const age = (at: string | undefined, now: number) => at && Number.isFinite(Date.parse(at)) ? Math.max(0, now - Date.parse(at)) : undefined;
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function owner(pid?: number): string {
  return pid === undefined ? 'not running' : !alive(pid) ? `stopped (pid ${pid})` : pid === process.pid ? `running here (pid ${pid})` : `running in another process (pid ${pid})`;
}

/** A view-local, bounded cache. Only changed files are reparsed; nothing is ever written by a status reader. */
export class StatusReader {
  private cache = new Map<string, { stamp: string; value: unknown }>();
  clear() { this.cache.clear(); }
  private read<T>(file: string, format: 'text' | 'json' | 'jsonl'): T | undefined {
    let stat;
    try { stat = statSync(file); } catch (error) { if (missing(error)) return undefined; throw error; }
    const key = `${format}:${file}`;
    const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = this.cache.get(key);
    if (cached?.stamp === stamp) return cached.value as T;
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch (error) { if (missing(error)) return undefined; throw error; }
    // Append-only logs can be observed between writes. Ignore only their uncommitted trailing line.
    const value = format === 'text' ? text : format === 'json' ? JSON.parse(text)
      : text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line));
    this.cache.delete(key);
    this.cache.set(key, { stamp, value });
    if (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
    return value as T;
  }
  /** Transcript fallback for old proving workers and activity for all workers; never replaces reported compression usage. */
  session(workspace: string, startedAt?: string, now = Date.now()) {
    const metrics: TrialMetrics = { turns: 0, costUsd: 0, tokens: 0, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheWrite: 0, firstTurnInputTokens: 0, durationMs: age(startedAt, now) ?? 0, rounds: 0 };
    let activity: Activity | undefined;
    const dir = join(workspace, 'session');
    let files: string[];
    try { files = readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort(); }
    catch (error) { if (missing(error)) return { metrics, activity }; throw error; }
    for (const name of files) {
      const entries = this.read<{ timestamp?: string; message?: { role?: string; stopReason?: string; errorMessage?: string; toolName?: string;
        usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; totalTokens?: number; cost?: { total?: number } };
        content?: { type: string; name?: string }[] } }[]>(join(dir, name), 'jsonl') ?? [];
      for (const entry of entries) {
        const message = entry.message;
        if (!message) continue;
        if (message.role === 'assistant') {
          const usage = message.usage ?? {};
          if (!metrics.turns) metrics.firstTurnInputTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
          metrics.turns += 1;
          metrics.costUsd += usage.cost?.total ?? 0;
          metrics.tokens += usage.totalTokens ?? 0;
          metrics.tokensIn += usage.input ?? 0;
          metrics.tokensOut += usage.output ?? 0;
          metrics.cacheRead += usage.cacheRead ?? 0;
          metrics.cacheWrite += usage.cacheWrite ?? 0;
          const tool = message.content?.filter(part => part.type === 'toolCall').at(-1)?.name;
          if (entry.timestamp) activity = { at: entry.timestamp, text: message.stopReason === 'error' ? `model error: ${message.errorMessage ?? 'unknown'}` : tool ? `tool: ${tool}` : 'model response received' };
        } else if (message.role === 'toolResult' && entry.timestamp) activity = { at: entry.timestamp, text: `tool finished: ${message.toolName ?? 'tool'}` };
      }
    }
    return { metrics, activity };
  }

  run(cwd: string, id: string, now = Date.now()): RunStatus | undefined {
    if (!/^run-\d+$/.test(id)) throw new Error('Invalid benchmark run ID.');
    const root = benchRunDir(cwd, id);
    const run = this.read<BenchmarkRun>(join(root, 'benchmark.json'), 'json');
    if (!run) return undefined;
    const latest = new Map<string, BenchmarkTrial>();
    for (const trial of this.read<BenchmarkTrial[]>(join(root, 'trials.jsonl'), 'jsonl') ?? []) latest.set(trial.id, trial);
    const list = [...latest.values()].sort((a, b) => a.id.localeCompare(b.id)).map(trial => {
      const base = trialDir(cwd, id, trial.id);
      const active = trial.status === 'running';
      const workspace = run.config.mode === 'compress' ? join(base, `attempt-${trial.attempt ?? 1}`) : base;
      const transcript = active ? this.session(workspace, trial.startedAt, now) : undefined;
      const report = run.config.mode === 'compress' ? this.read<Report>(join(base, 'compression/report.json'), 'json') : undefined;
      // Compression persists usage on every model response. Transcript fallback is for legacy, non-reporting workers.
      const reported = trial.metrics.turns !== undefined || trial.metrics.costUsd !== undefined || trial.metrics.tokens !== undefined;
      const metrics = { ...trial.metrics, ...(active && (run.config.mode !== 'compress' || !reported) && transcript?.metrics.turns ? transcript.metrics : {}) };
      if (active) metrics.durationMs = age(trial.startedAt, now) ?? metrics.durationMs ?? 0;
      const activities = [trial.activity, transcript?.activity].filter((item): item is Activity => !!item);
      const activity = activities.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
      return { trial, metrics, activity, report, checkpoint: report?.best,
        reason: trial.metrics.reason ?? trial.metrics.compression?.reason ?? (['interrupted', 'unavailable', 'timeout', 'cancelled'].includes(report?.outcome ?? '') ? report?.reason : undefined) };
    });
    const summary = summarizeTrials(run, list.map(item => ({ ...item.trial, metrics: item.metrics })), now);
    return { run, trials: list, aggregate: summary, owner: run.status === 'running' ? owner(run.runner?.pid) : run.status,
      heartbeatAge: age(run.runner?.heartbeatAt, now), now };
  }
}

const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 400);
const activityText = (activity: Activity, now: number) => `${clean(activity.text)} (${duration(age(activity.at, now) ?? 0)} ago)`;
export function formatRunStatus(snapshot: RunStatus, maxTrials = 30): string {
  const { run, aggregate: result, trials, now } = snapshot;
  const live = trials.filter(item => item.trial.status === 'running');
  const measured = trials.filter(item => ['passed', 'failed'].includes(item.trial.status) && item.metrics.compression?.verified).length;
  const marks: Record<BenchmarkTrial['status'], string> = { running: '…', queued: '·', passed: '✔', failed: '✖', error: '!', cancelled: '–' };
  const lines = [
    `${run.runId} · ${run.benchmarkId} @ ${run.benchmarkVersion} · ${run.split}${run.sealed ? ' (sealed)' : ''} · ${run.status === 'queued' && run.problem ? 'blocked' : snapshot.owner}`,
    ...(snapshot.heartbeatAge === undefined ? [] : [`Heartbeat: ${duration(snapshot.heartbeatAge)} ago${snapshot.heartbeatAge > config().benchmarks.staleAfterSeconds * 1000 ? ' (stale; worker activity shown separately)' : ''}`]),
    ...(run.progress ? [`Stage: ${run.progress.stage} · baselines ${run.progress.completed}/${run.progress.total} verified${run.progress.stage === 'baselines' && run.progress.taskId ? ` · ${run.progress.taskId}: ${run.progress.check === 'comparator' ? 'Comparator' : 'Lean + heartbeats'}` : ''}`]
      : run.config.mode === 'compress' ? ['Baseline progress has not been recorded.'] : []),
    run.config.mode === 'compress' ? `Compression: improved ${result.passed} · no improvement ${result.failed} · errors ${result.errors} · pending ${result.pending} · mean completed score ${measured ? `${result.compression!.meanScore.toFixed(2)}%` : 'n/a'} (${measured}/${trials.length} trials measured)`
      : `Passed ${result.passed} · failed ${result.failed} · errors ${result.errors} · pending ${result.pending} · cancelled ${result.cancelled} · pass rate ${(result.passRate * 100).toFixed(1)}% of judged (Comparator)`,
    ...(run.problem ? [`Run problem: ${clean(run.problem)}`] : []),
    ...usageLines(result),
    ...(live.length ? [`In flight: ${live.length} trial(s), ${money(live.reduce((sum, item) => sum + (item.metrics.costUsd ?? 0), 0))} reported (included above)`] : []),
    `Harness ${run.config.harness} · model ${run.config.model} · thinking ${run.config.thinking} · per trial: ${showLimit(run.config.timeoutMinutes)} min, ${showLimit(run.config.maxTurns)} turns, ${showLimit(run.config.maxCostUsd, money)}`,
  ];
  for (const item of trials.slice(0, maxTrials)) {
    const { trial, metrics, checkpoint } = item;
    const progress = trial.progress;
    lines.push(`  ${marks[trial.status]} ${trial.id} · ${trial.status}${trial.attempt ? ` · worker attempt ${trial.attempt}` : ''}${progress ? ` · ${progress.stage}${progress.round ? ` · round ${progress.round}/${progress.rounds}` : ''}${progress.candidate ? ` · candidate ${progress.candidate}` : ''}` : ''} · ${trialUsage(metrics)}`);
    if (metrics.escalated) lines.push(`      ↑goal${metrics.phases?.map(phase => ` · ${phase.phase}: ${money(phase.costUsd)}, ${phase.turns} turns`).join('') ?? ''}`);
    if (metrics.failureKind) lines.push(`      outcome: ${metrics.failureKind}`);
    if (metrics.plan?.exists) lines.push(`      plan ${metrics.plan.valid ? 'valid' : 'not valid'}, ${metrics.plan.angles} angles, ${metrics.plan.proved}/${metrics.plan.total} proved`);
    if (item.activity) lines.push(`      last: ${activityText(item.activity, now)}`);
    else if (trial.status === 'running') lines.push('      last: no activity reported yet');
    if (checkpoint) lines.push(`      best verified: ${checkpoint.compress_score.toFixed(2)}% · ${checkpoint.lines} LOC · ${checkpoint.heartbeats.toFixed(3)} heartbeats · round ${checkpoint.round}${item.report ? ` (${item.report.roundsCompleted}/${item.report.roundsRequested} rounds completed)` : ''}`);
    if (item.reason) lines.push(`      reason: ${clean(item.reason)}`);
  }
  if (trials.length > maxTrials) lines.push(`  … ${trials.length - maxTrials} more`);
  return lines.join('\n');
}

export const statusReader = new StatusReader();
