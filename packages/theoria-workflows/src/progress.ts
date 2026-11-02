import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { elaborate, resolve as resolveEnvironment, type Environment } from '@theoria/pi-lean/api';
import { config } from '@theoria/shared/config';
import { projectPath, projectRoot } from '@theoria/shared/paths';
import { projectRecord, projectType, type ProjectGoal } from '@theoria/shared/project';
import { standardAxioms } from './gate.ts';

/**
 * How far a project is from its goal, measured by Lean.
 *
 * The goal is one theorem. Lean walks the constants its proof uses, keeps the theorems declared in the goal's own
 * file, and reports the axioms each rests on. One counts as verified when those are only `workflows.standardAxioms`;
 * a `sorry`, written or left by an error, shows up as `sorryAx`. The goal itself is one of the items, so the bar
 * reaches 100% only when the goal is verified. It measures the current proof plan, not distance to a solution.
 */

export interface ProgressItem {
  name: string;
  verified: boolean;
  /** Why not verified: its own `sorry`, a dependency's, or another axiom. */
  reason?: string;
}

export interface Progress {
  goal: ProjectGoal;
  items: ProgressItem[];
  verified: number;
  total: number;
  percent: number;
  goalVerified: boolean;
  checkedAt: string;
  environment?: string;
  /** Why no measurement could be made; then items is empty. */
  problem?: string;
}

const marker = 'THEORIA_ITEM';
const missingMarker = 'THEORIA_MISSING';

/** The Lean script appended to the goal's file. It prints one line per theorem the goal depends on, the goal included. */
function script(theorem: string): string {
  return `
open Lean Elab Command in
#eval show CommandElabM Unit from do
  let env ← getEnv
  let goal : Name := ${JSON.stringify(theorem)}.toName
  let isLocal (n : Name) : Bool := (env.getModuleIdxFor? n).isNone
  if (env.find? goal).isNone then
    logInfo m!"${missingMarker} {goal}"
    return
  let mut seen : NameSet := {}
  let mut stack : Array Name := #[goal]
  while !stack.isEmpty do
    let n := stack.back!
    stack := stack.pop
    if seen.contains n then continue
    seen := seen.insert n
    if let some ci := env.find? n then
      for c in ci.getUsedConstantsAsSet do
        if isLocal c && !seen.contains c then stack := stack.push c
  for n in seen.toList do
    if let some (.thmInfo info) := env.find? n then
      if !n.isInternal then
        let axs ← collectAxioms n
        let direct := info.value.getUsedConstants.contains \`\`sorryAx
        logInfo m!"${marker} {n} | {direct} | {axs.toList}"
`;
}

/** The script needs Lean's meta API: Mathlib brings it, and a core-only file gets `import Lean` added. */
function withLeanImport(source: string): string {
  return /^\s*import\s+(Lean|Mathlib)\b/m.test(source) ? source : `import Lean\n${source}`;
}

/** Parses the script's lines. */
export function parseItems(output: string, goal: string): ProgressItem[] | undefined {
  if (output.includes(`${missingMarker} `)) return undefined;
  const permitted = new Set(standardAxioms());
  const items: ProgressItem[] = [];
  for (const match of output.matchAll(new RegExp(`${marker} (\\S+) \\| (true|false) \\| \\[([^\\]]*)\\]`, 'g'))) {
    const axioms = match[3]!.split(',').map(entry => entry.trim()).filter(Boolean);
    const refused = axioms.filter(axiom => !permitted.has(axiom));
    const verified = refused.length === 0;
    const reason = verified ? undefined
      : refused.includes('sorryAx') ? (match[2] === 'true' ? 'sorry' : 'depends on sorry')
        : `uses ${refused.join(', ')}`;
    items.push({ name: match[1]!, verified, ...(reason ? { reason } : {}) });
  }
  // The goal first, then unverified items, then verified ones, each alphabetically.
  return items.sort((a, b) => Number(b.name === goal) - Number(a.name === goal) || Number(a.verified) - Number(b.verified) || a.name.localeCompare(b.name));
}

const cachePath = (dir: string) => projectPath(dir, config().workflows.progress.cacheFile);

/** The last measurement, without running Lean. */
export function readProgress(dir: string): Progress | undefined {
  try { return JSON.parse(readFileSync(cachePath(dir), 'utf8')) as Progress; } catch { return undefined; }
}

function save(dir: string, progress: Progress): Progress {
  mkdirSync(dirname(cachePath(dir)), { recursive: true });
  writeFileSync(cachePath(dir), `${JSON.stringify(progress, null, 2)}\n`, 'utf8');
  return progress;
}

/** Whether a project measures progress at all: its type does, and it has a goal. */
export function progressMeasure(dir: string): { goal: ProjectGoal } | { none: string } {
  let type;
  try { type = projectType(dir); } catch (error) { return { none: error instanceof Error ? error.message : String(error) }; }
  if (type.settings.progress === 'none') return { none: `No progress measure for ${type.settings.name} projects yet.` };
  const goal = projectRecord(dir)?.goal;
  return goal ? { goal } : { none: 'Lean progress: no target theorem yet; the first theorem /formalize writes becomes it.' };
}

/** Measures progress with Lean and caches it. */
export async function measureProgress(dir: string, environment?: Environment, signal?: AbortSignal): Promise<Progress | { none: string }> {
  const measure = progressMeasure(dir);
  if ('none' in measure) return measure;
  const { goal } = measure;
  const base = { goal, items: [], verified: 0, total: 0, percent: 0, goalVerified: false, checkedAt: new Date().toISOString() };
  const env = environment ?? await resolveEnvironment(dir);
  let source: string;
  try { source = readFileSync(join(projectRoot(dir), goal.file), 'utf8'); } catch {
    return save(dir, { ...base, problem: `The goal's file ${goal.file} is missing.` });
  }
  const result = await elaborate(env, {
    cwd: dir, source: `${withLeanImport(source)}\n${script(goal.theorem)}`, shown: goal.file,
    timeoutSeconds: config().workflows.progress.timeoutSeconds, signal,
  });
  if (result.timedOut) return save(dir, { ...base, problem: 'Lean did not finish measuring progress in time.' });
  const items = parseItems(result.output, goal.theorem);
  if (!items) return save(dir, { ...base, problem: `The goal ${goal.theorem} is not in ${goal.file} as Lean reads it.` });
  if (!items.length) return save(dir, { ...base, problem: `Lean could not measure progress: ${result.output.trim().split('\n').slice(0, 3).join(' ').slice(0, 300)}` });
  const verified = items.filter(item => item.verified).length;
  return save(dir, {
    ...base, items, verified, total: items.length,
    percent: Math.floor((verified / items.length) * 100),
    goalVerified: items.some(item => item.name === goal.theorem && item.verified),
  });
}

/** `████████████░░░░░░░░  60%  3 of 5 verified`. A bar never shows 100% unless the goal is verified. */
export function progressBar(progress: Progress): string {
  const width = config().workflows.progress.barWidth;
  const percent = progress.goalVerified ? 100 : Math.min(progress.percent, 99);
  const filled = Math.round((percent / 100) * width);
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}  ${percent}%  ${progress.verified} of ${progress.total} verified`;
}

/** The progress section of a status message, as plain text lines. */
export function progressLines(dir: string): string[] {
  const measure = progressMeasure(dir);
  if ('none' in measure) return [measure.none];
  const progress = readProgress(dir);
  const head = `Lean target: ${measure.goal.theorem} (${measure.goal.file})`;
  if (!progress || progress.goal.theorem !== measure.goal.theorem) return [head, 'Not measured yet.'];
  if (progress.problem) return [head, progress.problem, `Checked ${age(progress.checkedAt)}`];
  const shown = progress.items.slice(0, config().workflows.progress.maxItemsShown);
  return [
    head,
    progressBar(progress),
    ...shown.map(item => `  ${item.verified ? '✔' : '✖'} ${item.name}${item.reason ? ` (${item.reason})` : ''}`),
    ...(progress.items.length > shown.length ? [`  … ${progress.items.length - shown.length} more`] : []),
    `Checked ${age(progress.checkedAt)}${progress.goalVerified ? '' : ' · measures the current proof plan, not distance to a solution'}`,
  ];
}

function age(iso: string): string {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}
