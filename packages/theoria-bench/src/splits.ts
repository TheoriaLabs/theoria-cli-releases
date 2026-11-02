import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '@theoria/shared/config';
import { sourceDir } from './paths.ts';
import type { Benchmark } from './types.ts';

/**
 * Train, val and test splits. A task's split is a hash of the seed, the benchmark and the task id, mapped onto the
 * configured shares, so it is the same on every machine; it is then frozen in the benchmark's manifest, so a later
 * change of shares or seed never moves an existing task to another split (and test tasks never leak into training).
 */

const settings = () => config().benchmarks.splits;
export const splitNames = () => settings().shares.map(entry => entry.split);

export function hashSplit(benchmarkId: string, taskId: string, seed = settings().seed, shares = settings().shares): string {
  const digest = createHash('sha256').update(`${seed}:${benchmarkId}:${taskId}`).digest();
  const unit = digest.readUInt32BE(0) / 2 ** 32;
  const total = shares.reduce((sum, entry) => sum + entry.share, 0);
  let edge = 0;
  for (const entry of shares) {
    edge += entry.share / total;
    if (unit < edge) return entry.split;
  }
  return shares.at(-1)!.split;
}

interface Manifest { benchmarkId: string; version: string; seed: string; frozenAt: string; tasks: Record<string, string> }

const manifestPath = (benchmarkId: string) => join(sourceDir(benchmarkId), settings().manifestFile);

/** Every task's split, frozen on first use; tasks added later get theirs and are frozen too. */
export function splitsFor(benchmark: Benchmark): Record<string, string> {
  const tasks = benchmark.listTasks();
  if (benchmark.splitSource) {
    const parent = splitsFor(benchmark.splitSource);
    return Object.fromEntries(tasks.map(task => {
      if (!parent[task.id]) throw new Error(`${task.id} has no split in ${benchmark.splitSource!.id}.`);
      return [task.id, parent[task.id]!];
    }));
  }
  const path = manifestPath(benchmark.id);
  let manifest: Manifest | undefined;
  if (existsSync(path)) { try { manifest = JSON.parse(readFileSync(path, 'utf8')) as Manifest; } catch { manifest = undefined; } }
  manifest ??= { benchmarkId: benchmark.id, version: benchmark.version, seed: settings().seed, frozenAt: new Date().toISOString(), tasks: {} };
  let changed = !existsSync(path);
  for (const task of tasks) {
    if (task.split && manifest.tasks[task.id] && manifest.tasks[task.id] !== task.split) throw new Error(`${benchmark.id}: frozen split for ${task.id} differs from its declared ${task.split} split. Review ${path} before running.`);
    if (manifest.tasks[task.id]) continue;
    manifest.tasks[task.id] = task.split ?? hashSplit(benchmark.id, task.id, manifest.seed);
    changed = true;
  }
  if (changed) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`); }
  return Object.fromEntries(tasks.map(task => [task.id, manifest!.tasks[task.id]!]));
}

export function splitCounts(splits: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = Object.fromEntries(splitNames().map(name => [name, 0]));
  for (const split of Object.values(splits)) out[split] = (out[split] ?? 0) + 1;
  return out;
}
