import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { benchRunDir, readBenchRun, trials } from './store.ts';

export interface CleanupOptions { runIds?: string[]; exclude?: string[]; dryRun?: boolean }
export interface CleanupResult {
  files: number; bytes: number; runs: string[]; dryRun: boolean;
  skipped: { runId: string; reason: string }[];
  errors: string[];
}

const alive = (pid?: number) => {
  if (!Number.isSafeInteger(pid) || pid! <= 0) return false;
  try { process.kill(pid!, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};
const within = (root: string, file: string) => {
  const path = relative(root, realpathSync(file));
  return path !== '' && path !== '..' && !path.startsWith('../') && !isAbsolute(path);
};

/** Old Lake setup metadata has a distinctive header. Never infer ownership merely from a tmp.* filename. */
function metadata(file: string): { size: number; dev: number; ino: number } | undefined {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return undefined;
    if (stat.size) {
      const prefix = Buffer.alloc(4096);
      const length = readSync(fd, prefix, 0, prefix.length, 0);
      if (!/^\{"dynlibs":\s*\[[\s\S]*?\],\s*"importArts":\s*\{/.test(prefix.toString('utf8', 0, length))) return undefined;
    }
    return { size: stat.size, dev: stat.dev, ino: stat.ino };
  } finally { closeSync(fd); }
}

/** Reclaim only recognized metadata in terminal runs. Proof drafts (including .tmp/*.lean), transcripts,
 * checkpoints, inputs and dependency trees are retained. Symlinks are never followed or removed.
 */
export function cleanupFinishedRuns(cwd: string, options: CleanupOptions = {}): CleanupResult {
  const result: CleanupResult = { files: 0, bytes: 0, runs: [], skipped: [], errors: [], dryRun: !!options.dryRun };
  for (const id of [...options.runIds ?? [], ...options.exclude ?? []]) if (!/^run-\d+$/.test(id)) throw new Error(`Invalid cleanup run ID: ${id}`);
  const parent = benchRunDir(cwd, '');
  if (!existsSync(parent)) return result;
  if (lstatSync(parent).isSymbolicLink()) throw new Error('Refusing a symlinked benchmark directory.');
  const root = realpathSync(parent);
  const ids = options.runIds ?? readdirSync(root).filter(name => /^run-\d+$/.test(name)).sort();
  for (const id of ids) {
    const directory = join(root, id);
    const eligible = (checkWorkers = true): string | undefined => {
      if (options.exclude?.includes(id)) return 'explicitly excluded';
      if (!existsSync(directory) || lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || !within(root, directory)) return 'not a local run directory';
      const run = readBenchRun(cwd, id);
      if (!run || run.runId !== id) return 'missing or invalid run record';
      if (!['completed', 'cancelled'].includes(run.status)) return `run is ${run.status}`;
      if (alive(run.runner?.pid)) return 'runner process is still alive';
      if (checkWorkers && trials(cwd, id).some(trial => trial.status === 'running' || alive(trial.workerPid))) return 'worker may still be active';
      return undefined;
    };
    try {
      const reason = eligible();
      if (reason) { result.skipped.push({ runId: id, reason }); continue; }
      let touched = false;
      const walk = (path: string, inScratch = false) => {
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) continue;
          const file = join(path, entry.name);
          if (entry.isDirectory()) {
            if (['.lake', '.git', 'node_modules', 'inputs', 'session', 'compression'].includes(entry.name)) continue;
            if (within(directory, file) && !lstatSync(file).isSymbolicLink()) walk(file, inScratch || entry.name === '.tmp');
          } else if (inScratch && entry.isFile() && /^tmp\.[A-Za-z0-9_-]+$/.test(entry.name)) {
            if (!within(directory, file)) continue;
            const owned = metadata(file);
            if (!owned) continue;
            // Re-check state and identity immediately before unlinking; cleanup cannot turn a resumed run's
            // working file or a replacement symlink into a deletion target.
            const changed = eligible(false);
            if (changed) throw new Error(`run became ineligible: ${changed}`);
            const current = lstatSync(file);
            if (!current.isFile() || current.dev !== owned.dev || current.ino !== owned.ino || !within(directory, file)) continue;
            if (!options.dryRun) unlinkSync(file);
            result.files += 1; result.bytes += owned.size; touched = true;
          }
        }
      };
      walk(directory);
      if (touched) result.runs.push(id);
    } catch (error) { result.errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return result;
}

export function cleanupSummary(result: CleanupResult): string {
  return `${result.dryRun ? 'Would reclaim' : 'Reclaimed'} ${(result.bytes / 1024 ** 2).toFixed(1)} MiB from ${result.files} temporary metadata files in ${result.runs.length} finished runs.`
    + (result.skipped.length ? `\nSkipped: ${result.skipped.map(entry => `${entry.runId} (${entry.reason})`).join(', ')}.` : '')
    + (result.errors.length ? `\nCleanup errors: ${result.errors.join('; ')}` : '');
}

/** A cache-cleaning error must not discard a verified result or turn a completed benchmark into a failure. */
export function cleanupAfterRun(cwd: string, runId: string, notify?: (text: string) => void): void {
  const report = (text: string) => { try { notify?.(text); } catch { /* a closed UI must not affect the run */ } };
  try {
    const result = cleanupFinishedRuns(cwd, { runIds: [runId] });
    if (result.files || result.errors.length) report(cleanupSummary(result));
  } catch (error) { report(`Metadata cleanup: ${String(error)}`); }
}
