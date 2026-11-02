import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@theoria/shared/config';
import { projectPath } from '@theoria/shared/paths';
import { appendJsonl, readJson, readJsonl, writeJson } from '@theoria/pi-research/api';
import type { BenchmarkRun, BenchmarkTrial } from './types.ts';

/**
 * A benchmark run's files, in the project: `.theoria/<benchmarks.runsDir>/<run>/` with benchmark.json (the run),
 * trials.jsonl (every trial state change; a trial's state is its last line), aggregate.json, and per trial its
 * workspace and evaluation folder. The folder is gitignored: benchmarks ask that solutions are not published.
 */

export const benchRunDir = (cwd: string, runId: string) => projectPath(cwd, config().benchmarks.runsDir, runId);
const runFile = (cwd: string, runId: string) => join(benchRunDir(cwd, runId), 'benchmark.json');
const trialsFile = (cwd: string, runId: string) => join(benchRunDir(cwd, runId), 'trials.jsonl');
export const aggregateFile = (cwd: string, runId: string) => join(benchRunDir(cwd, runId), 'aggregate.json');
export const cancelFile = (cwd: string, runId: string) => join(benchRunDir(cwd, runId), 'cancel-requested');
export const trialDir = (cwd: string, runId: string, trialId: string) => join(benchRunDir(cwd, runId), 'trials', trialId.replace(/[^\w.-]/g, '_'));
export const evalDir = (cwd: string, runId: string, trialId: string) => join(benchRunDir(cwd, runId), 'evals', trialId.replace(/[^\w.-]/g, '_'));

export const readBenchRun = (cwd: string, runId: string) => readJson<BenchmarkRun>(runFile(cwd, runId));
export const writeBenchRun = (cwd: string, run: BenchmarkRun) => writeJson(runFile(cwd, run.runId), { ...run, updatedAt: new Date().toISOString() });

export function trials(cwd: string, runId: string): BenchmarkTrial[] {
  const latest = new Map<string, BenchmarkTrial>();
  for (const trial of readJsonl<BenchmarkTrial>(trialsFile(cwd, runId))) latest.set(trial.id, trial);
  return [...latest.values()];
}

export function saveTrial(cwd: string, trial: BenchmarkTrial): BenchmarkTrial {
  const next = { ...trial, updatedAt: new Date().toISOString() };
  appendJsonl(trialsFile(cwd, trial.runId), next);
  return next;
}

export const requestCancel = (cwd: string, runId: string) => writeFileSync(cancelFile(cwd, runId), new Date().toISOString());
export const cancelRequested = (cwd: string, runId: string) => existsSync(cancelFile(cwd, runId));
export const clearCancel = (cwd: string, runId: string) => rmSync(cancelFile(cwd, runId), { force: true });

export interface Aggregate {
  compression?: { meanScore: number; perTask: Record<string, { meanScore: number; measured: number }> };
  benchmarkId: string; split: string; tasks: number; trials: number;
  passed: number; failed: number; errors: number; cancelled: number; pending: number;
  passRate: number;
  /** Totals over the trials: cost, tokens in and out (and cache), the trials' own time added up. */
  costUsd: number; tokensIn: number; tokensOut: number; cacheRead: number; cacheWrite: number; tokens: number; trialTimeMs: number;
  /** The run's wall-clock time: what the runner spent, from start to finish (resumed runs add up). */
  wallClockMs: number;
  /** Per trial that finished: averages, and cost per solved task. */
  meanCostUsd: number; meanDurationMs: number; costPerPassUsd: number | null;
  perTask: Record<string, { passed: number; trials: number; costUsd: number; durationMs: number }>;
}

/** Pure aggregation for status readers. Only the runner's aggregate() persists a report. */
export function summarizeTrials(run: BenchmarkRun, all: BenchmarkTrial[], now = Date.now()): Aggregate {
  const count = (status: BenchmarkTrial['status']) => all.filter(trial => trial.status === status).length;
  const perTask: Aggregate['perTask'] = {};
  for (const trial of all) {
    const entry = perTask[trial.taskId] ??= { passed: 0, trials: 0, costUsd: 0, durationMs: 0 };
    if (['passed', 'failed', 'error'].includes(trial.status)) entry.trials += 1;
    if (trial.status === 'passed') entry.passed += 1;
    entry.costUsd += trial.metrics.costUsd ?? 0;
    entry.durationMs += trial.metrics.durationMs ?? 0;
  }
  const decided = count('passed') + count('failed');
  // Spend includes attempts that were run again after an infrastructure error.
  const sum = (key: 'costUsd' | 'tokensIn' | 'tokensOut' | 'cacheRead' | 'cacheWrite' | 'tokens' | 'durationMs') => all.reduce((total, trial) =>
    total + (trial.metrics[key] ?? 0) + (trial.previousAttempts ?? []).reduce((prior, attempt) => prior + (attempt[key] ?? 0), 0), 0);
  const finished = all.filter(trial => trial.completedAt && trial.status !== 'running' && trial.status !== 'queued');
  const finishedSum = (key: 'costUsd' | 'durationMs') => finished.reduce((total, trial) => total + (trial.metrics[key] ?? 0)
    + (trial.previousAttempts ?? []).reduce((sum, attempt) => sum + (attempt[key] ?? 0), 0), 0);
  const runningFor = run.runner?.startedAt ? Math.max(0, now - Date.parse(run.runner.startedAt)) : 0;
  const result: Aggregate = {
    benchmarkId: run.benchmarkId, split: run.split, tasks: run.taskIds.length, trials: all.length,
    passed: count('passed'), failed: count('failed'), errors: count('error'), cancelled: count('cancelled'),
    pending: count('queued') + count('running'),
    passRate: decided ? count('passed') / decided : 0,
    costUsd: sum('costUsd'), tokensIn: sum('tokensIn'), tokensOut: sum('tokensOut'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), tokens: sum('tokens'),
    trialTimeMs: sum('durationMs'),
    wallClockMs: (run.wallClockMs ?? 0) + (run.status === 'running' ? runningFor : 0),
    meanCostUsd: finished.length ? finishedSum('costUsd') / finished.length : 0,
    meanDurationMs: finished.length ? finishedSum('durationMs') / finished.length : 0,
    costPerPassUsd: count('passed') ? sum('costUsd') / count('passed') : null,
    perTask,
  };
  if (run.config.mode === 'compress') {
    const perTask: NonNullable<Aggregate['compression']>['perTask'] = {};
    for (const id of run.taskIds) {
      const completed = all.filter(trial => trial.taskId === id && ['passed', 'failed'].includes(trial.status) && trial.metrics.compression?.verified);
      perTask[id] = { meanScore: completed.length ? completed.reduce((sum, trial) => sum + (trial.metrics.compression?.compress_score ?? 0), 0) / completed.length : 0, measured: completed.length };
    }
    const measured = Object.values(perTask).filter(task => task.measured > 0);
    result.compression = { perTask, meanScore: measured.length ? measured.reduce((sum, task) => sum + task.meanScore, 0) / measured.length : 0 };
  }
  return result;
}

export function aggregate(cwd: string, run: BenchmarkRun): Aggregate {
  const result = summarizeTrials(run, trials(cwd, run.runId));
  writeJson(aggregateFile(cwd, run.runId), result);
  return result;
}
