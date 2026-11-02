import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { elaborate, label, ready, resolve as resolveEnvironment, type Environment } from '@theoria/pi-lean/api';
import { config } from '@theoria/shared/config';
import { projectPath, projectRoot } from '@theoria/shared/paths';
import { standardAxioms } from './gate.ts';
import { declarations, isTheorem } from './lean-source.ts';
import { leanFiles } from './target.ts';

/**
 * Every theorem in a project, as Lean sees it now: whether its statement is well-formed, and whether its proof is
 * proved, open (a `sorry`, its own or a dependency's) or has errors. One Lean run per file, with a script appended
 * that reports the axioms of every theorem the file declares; errors are placed in a theorem's statement or proof
 * by their line. Results are cached per file and rechecked only when the file or the Lean environment changes.
 */

export type ProofState = 'proved' | 'open' | 'error';

export interface TheoremState {
  name: string;
  file: string;
  /** Lean reported an error in the statement, or did not accept the declaration at all. */
  statementError: boolean;
  /** Undefined when the statement itself does not elaborate. */
  proof?: ProofState;
  /** Why it is not proved. */
  reason?: string;
}

interface FileEntry { stamp: string; environment: string; checkedAt: string; theorems: TheoremState[]; problem?: string }
interface Cache { files: Record<string, FileEntry> }
const cacheVersion = 2; // Names are now resolved from namespace scopes, not ambiguous basename matching.

export interface Inventory {
  theorems: TheoremState[];
  /** Oldest check among the files, when every file has been checked. */
  checkedAt?: string;
  /** A file changed, appeared or was never checked, or the Lean environment changed. */
  stale: boolean;
  problems: string[];
}

const marker = 'THEORIA_THM';
const settings = () => config().workflows.inventory;
const cachePath = (dir: string) => projectPath(dir, settings().cacheFile);

/** Reports every theorem the file declares (not those it imports), with its axioms. */
const script = `
open Lean Elab Command in
#eval show CommandElabM Unit from do
  let env ← getEnv
  for (n, ci) in env.constants.map₂.toList do
    if let .thmInfo info := ci then
      if !n.isInternal then
        let axs ← collectAxioms n
        let direct := info.value.getUsedConstants.contains \`\`sorryAx
        logInfo m!"${marker} {n} | {direct} | {axs.toList}"
`;

function readCache(dir: string): Cache {
  try {
    const value = JSON.parse(readFileSync(cachePath(dir), 'utf8')) as Cache & { version?: number };
    return value.version === cacheVersion ? value : { files: {} };
  } catch { return { files: {} }; }
}

function writeCache(dir: string, cache: Cache) {
  const path = cachePath(dir);
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ ...cache, version: cacheVersion }, null, 2)}\n`, 'utf8');
  renameSync(temp, path);
}

const stampOf = (path: string) => { try { const info = statSync(path); return `${info.mtimeMs}:${info.size}`; } catch { return 'missing'; } };

/** Classifies a file's theorems from Lean's output. Exported for tests. */
export function classify(source: string, output: string, shown: string, lineShift: number): TheoremState[] {
  const permitted = new Set(standardAxioms());
  // Lean gives line (1-based) and column (0-based); as offsets into the source, so an error on the line of `:=` is
  // still placed on the right side of it.
  const lineStarts = [0, ...[...source.matchAll(/\n/g)].map(match => match.index! + 1)];
  const errorOffsets = [...output.matchAll(new RegExp(`^${shown.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):(\\d+): error`, 'gm'))]
    .map(match => (lineStarts[Number(match[1]) - 1 - lineShift] ?? source.length) + Number(match[2]));
  const reported = new Map<string, { direct: boolean; axioms: string[] }>();
  for (const match of output.matchAll(new RegExp(`${marker} (\\S+) \\| (true|false) \\| \\[([^\\]]*)\\]`, 'g'))) {
    reported.set(match[1]!, { direct: match[2] === 'true', axioms: match[3]!.split(',').map(entry => entry.trim()).filter(Boolean) });
  }
  return declarations(source).filter(isTheorem).map(declaration => {
    const name = reported.has(declaration.name) ? declaration.name : undefined;
    const base = { name: name ?? declaration.name, file: shown };
    const inStatement = errorOffsets.some(at => at >= declaration.start && at < declaration.bodyAt);
    const inProof = errorOffsets.some(at => at >= declaration.bodyAt && at < declaration.end);
    if (!name || inStatement) return { ...base, statementError: true, reason: name ? 'error in the statement' : 'Lean did not accept the declaration' };
    if (inProof) return { ...base, statementError: false, proof: 'error' as const, reason: 'error in the proof' };
    const { direct, axioms } = reported.get(name)!;
    const refused = axioms.filter(axiom => !permitted.has(axiom));
    if (!refused.length) return { ...base, statementError: false, proof: 'proved' as const };
    const reason = refused.includes('sorryAx') ? (direct ? 'sorry' : 'depends on sorry') : `uses ${refused.join(', ')}`;
    return { ...base, statementError: false, proof: 'open' as const, reason };
  });
}

async function checkFile(dir: string, path: string, environment: Environment): Promise<FileEntry> {
  const shown = relative(projectRoot(dir), path);
  const base = { stamp: stampOf(path), environment: label(environment), checkedAt: new Date().toISOString() };
  let source: string;
  try { source = readFileSync(path, 'utf8'); } catch { return { ...base, theorems: [], problem: `${shown} could not be read` }; }
  if (!declarations(source).some(isTheorem)) return { ...base, theorems: [] };
  // The script needs Lean's meta API; Mathlib brings it, a core-only file gets `import Lean` (one line, shifted back).
  const needsImport = !/^\s*import\s+(Lean|Mathlib)\b/m.test(source);
  const result = await elaborate(environment, {
    cwd: dir, source: `${needsImport ? 'import Lean\n' : ''}${source}\n${script}`, shown, timeoutSeconds: settings().timeoutSeconds,
  });
  if (result.timedOut) return { ...base, theorems: [], problem: `Lean did not finish checking ${shown} in time` };
  if (!result.output.includes(marker) && declarations(source).some(isTheorem)) {
    const first = result.output.split('\n').find(line => / error/.test(line)) ?? result.output.trim().split('\n')[0] ?? '';
    // No theorem reached the environment: an import or the whole file failed. Every theorem is reported as such.
    return { ...base, theorems: classify(source, result.output, shown, needsImport ? 1 : 0), problem: first.slice(0, 200) || undefined };
  }
  return { ...base, theorems: classify(source, result.output, shown, needsImport ? 1 : 0) };
}

/** The project's `.lean` files (as `/prove` finds them), by path relative to the project. */
const projectFiles = (dir: string) => leanFiles(projectRoot(dir)).map(path => ({ path, key: relative(projectRoot(dir), path) }));

/** The cached inventory, and whether it is out of date. Runs nothing. */
export function readInventory(dir: string, environment?: Environment): Inventory {
  const cache = readCache(dir);
  const files = projectFiles(dir);
  const entries = files.map(file => ({ file, entry: cache.files[file.key] }));
  const stale = entries.some(({ file, entry }) => !entry || entry.stamp !== stampOf(file.path) || (environment && entry.environment !== label(environment)));
  const checked = entries.flatMap(({ entry }) => (entry ? [entry.checkedAt] : [])).sort();
  return {
    theorems: entries.flatMap(({ entry }) => entry?.theorems ?? []),
    ...(checked.length === entries.length && checked.length ? { checkedAt: checked[0] } : {}),
    stale,
    problems: entries.flatMap(({ entry }) => (entry?.problem ? [entry.problem] : [])),
  };
}

const inflight = new Map<string, Promise<Inventory>>();

/** Checks every file that changed since its last check, and caches the result. One refresh per project at a time. */
export function refreshInventory(dir: string, environment?: Environment): Promise<Inventory> {
  const key = projectRoot(dir);
  const running = inflight.get(key);
  if (running) return running;
  const work = (async () => {
    const env = environment ?? await resolveEnvironment(dir);
    if (!ready(env)) return { theorems: [], stale: true, problems: [env.problem ?? 'No Lean environment is chosen (/lean).'] };
    const cache = readCache(dir);
    const next: Cache = { files: {} };
    for (const file of projectFiles(dir)) {
      const entry = cache.files[file.key];
      const fresh = entry && entry.stamp === stampOf(file.path) && entry.environment === label(env);
      next.files[file.key] = fresh ? entry : await checkFile(dir, file.path, env);
      writeCache(dir, { files: { ...cache.files, ...next.files } });
    }
    writeCache(dir, next);
    return readInventory(dir, env);
  })().finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}

export const refreshing = (dir: string) => inflight.has(projectRoot(dir));

/** Counts for a summary line. */
export function counts(inventory: Inventory) {
  const theorems = inventory.theorems;
  return {
    statements: theorems.length,
    wellFormed: theorems.filter(entry => !entry.statementError).length,
    statementErrors: theorems.filter(entry => entry.statementError).length,
    proved: theorems.filter(entry => entry.proof === 'proved').length,
    open: theorems.filter(entry => entry.proof === 'open').length,
    proofErrors: theorems.filter(entry => entry.proof === 'error').length,
  };
}
