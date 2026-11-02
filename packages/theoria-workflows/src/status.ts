import { label, ready, resolve as resolveEnvironment, searchState } from '@theoria/pi-lean/api';
import { config } from '@theoria/shared/config';
import { goalLines, openGoals } from '@theoria/shared/goals';
import { projectRoot } from '@theoria/shared/paths';
import { projectRecord, projectType, projectTypes, type ProjectRecord } from '@theoria/shared/project';
import { ago, recentVerdicts } from '@theoria/shared/verdicts';
import { counts, readInventory, refreshing, type TheoremState } from './inventory.ts';
import { progressLines } from './progress.ts';

/**
 * A project's status, the same in the terminal (`/project status`) and on Telegram (`/status`): what Lean says about
 * its theorems, the Lean target's progress, its goals, and its recent runs. Lean's results come from the cache; the
 * caller rechecks in the background when `stale` is set.
 */

const typeName = (record: Partial<ProjectRecord> | undefined) => (record?.type ? projectTypes()[record.type]?.name ?? record.type : 'no type');

function theoremLine(entry: TheoremState): string {
  if (entry.statementError) return `  ⚠ ${entry.name} (${entry.reason})`;
  if (entry.proof === 'proved') return `  ✔ ${entry.name}`;
  return `  ✖ ${entry.name} (${entry.reason})`;
}

const rank = (entry: TheoremState) => (entry.statementError ? 0 : entry.proof === 'error' ? 1 : entry.proof === 'open' ? 2 : 3);

export async function statusLines(dir: string): Promise<{ lines: string[]; stale: boolean }> {
  const record = projectRecord(dir);
  const name = record?.name ?? projectRoot(dir).split('/').pop() ?? dir;
  let usesLean = false;
  try { usesLean = projectType(dir).settings.lean; } catch { /* broken project file */ }
  const lines: string[] = [];
  let stale = false;
  if (usesLean) {
    const environment = await resolveEnvironment(dir);
    lines.push(`${name} · ${typeName(record)} · ${label(environment)}`, '');
    const inventory = readInventory(dir, environment);
    const available = ready(environment);
    // Without Lean nothing can be checked: say so, and do not ask for a recheck that cannot run.
    stale = available && inventory.stale;
    const c = counts(inventory);
    if (!available) {
      lines.push(`Lean unavailable: ${environment.problem ?? 'no Lean environment is chosen'}. Theorems not checked; /lean sets it up.`);
    } else if (!inventory.checkedAt && inventory.stale) {
      // Never checked: no counts rather than zeros that read like a result.
    } else if (!c.statements) {
      lines.push('Formalizations    none yet: /formalize <statement> writes one');
    } else {
      lines.push(
        `Formalizations    ${c.statements} statement(s): ${c.wellFormed} well-formed${c.statementErrors ? ` · ${c.statementErrors} with errors` : ''}`,
        `Proofs            ${c.proved} proved · ${c.open} open${c.proofErrors ? ` · ${c.proofErrors} with errors` : ''}`,
      );
      const sorted = [...inventory.theorems].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
      const shown = sorted.slice(0, config().workflows.inventory.maxShown);
      lines.push(...shown.map(theoremLine), ...(sorted.length > shown.length ? [`  … ${sorted.length - shown.length} more`] : []));
      for (const problem of inventory.problems) lines.push(`  ! ${problem}`);
    }
    if (available) lines.push(inventory.checkedAt
      ? `Checked by Lean ${ago(inventory.checkedAt)}${refreshing(dir) ? ' · rechecking now' : stale ? ' · files changed since; rechecking' : ''}`
      : refreshing(dir) || stale ? 'Lean is checking the files; ask again in a minute.' : '');
    lines.push((await searchState(dir, environment)).line);
    lines.push('', ...progressLines(dir));
  } else {
    lines.push(`${name} · ${typeName(record)}`);
  }
  lines.push('', ...goalLines(dir));
  const runs = recentVerdicts(dir);
  lines.push('', runs.length ? 'Recent verdicts' : 'Recent verdicts: none yet');
  for (const run of runs) {
    lines.push(`  /${run.workflow}${run.theorem ? ` ${run.theorem}` : ''} · ${run.outcome} · ${ago(run.at)}`);
  }
  return { lines: lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')), stale };
}

/** One line for a project in a list: name, type, proofs, open goals, last activity. */
export function projectRow(dir: string, record: Partial<ProjectRecord>, lastActive?: Date | string): string {
  const parts = [record.name ?? projectRoot(dir).split('/').pop() ?? dir, typeName(record)];
  let usesLean = false;
  try { usesLean = projectType(dir).settings.lean; } catch { /* broken */ }
  if (usesLean) {
    const c = counts(readInventory(dir));
    if (c.statements) parts.push(`${c.proved}/${c.statements} proved`);
  }
  const goals = openGoals(dir).length;
  if (goals) parts.push(`${goals} goal${goals === 1 ? '' : 's'} open`);
  const last = lastActive ?? recentVerdicts(dir, 1)[0]?.at ?? record.created;
  if (last) parts.push(ago(last));
  return parts.join(' · ');
}
