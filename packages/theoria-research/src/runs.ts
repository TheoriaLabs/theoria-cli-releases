import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { config } from '@theoria/shared/config';
import { appendRunEvent, readRunEvents, runDir, type RunEvent } from '@theoria/shared/events';
import { join } from 'node:path';
import { projectRoot } from '@theoria/shared/paths';
import { now, projectId, readJson, researchPath, withLock, writeJson, nextId } from './store.ts';

/**
 * Research runs: one bounded research effort inside a project, with a persistent goal. The goal lives here, not in a
 * conversation: a run outlives its Pi sessions, and a new session for it is told the goal again. A fork is a new run
 * with `parentRunId`; it shares the project's claims and artifacts, never the parent's transcript.
 */

export interface Goal {
  objective: string;
  context?: string;
  successCriteria?: string[];
  currentFocus?: string;
  notes?: string[];
}

export type RunStatus = 'active' | 'paused' | 'completed' | 'failed' | 'cancelled';

/** What the run was executed with, for reproducibility (a Prompt Profile replaces it later). */
export interface Harness {
  model?: string;
  /** The harness profile (`harness.profiles`). */
  profile?: string;
  piVersion?: string;
  theoriaCommit?: string;
  projectType?: string;
  extensions?: string[];
  systemPromptHash?: string;
}

export interface ResearchRun {
  id: string;
  projectId: string;
  kind: 'research' | 'benchmark';
  goal: Goal;
  status: RunStatus;
  workspace: string;
  harness: Harness;
  parentRunId?: string;
  /** Pi session files that worked on this run, oldest first. */
  sessions: string[];
  /** The pi-goal-x goal working on it autonomously, when there is one. */
  piGoalId?: string;
  createdClaimIds: string[];
  touchedClaimIds: string[];
  artifactIds: string[];
  benchmark?: { benchmarkId: string; benchmarkVersion: string; split: string };
  createdAt: string;
  updatedAt: string;
}

const settings = () => config().research;
const runFile = (cwd: string, id: string) => join(runDir(cwd, id), settings().runFile);

export function listRuns(cwd: string): ResearchRun[] {
  let names: string[] = [];
  try { names = readdirSync(researchPath(cwd, settings().runsDir)); } catch { return []; }
  return names.sort().flatMap(name => { const run = readJson<ResearchRun>(runFile(cwd, name)); return run ? [run] : []; });
}

export const getRun = (cwd: string, id: string) => readJson<ResearchRun>(runFile(cwd, id));

/** Research and benchmark storage share one run-ID namespace, even for manually created or incomplete runs. */
function reserveRunId(cwd: string, kind: ResearchRun['kind']): string {
  const researchRoot = researchPath(cwd, settings().runsDir);
  const benchmarkRoot = researchPath(cwd, config().benchmarks.runsDir);
  const roots = [...new Set([researchRoot, benchmarkRoot])];
  const reserve = [...new Set([researchRoot, ...(kind === 'benchmark' ? [benchmarkRoot] : [])])];
  for (const root of reserve) mkdirSync(root, { recursive: true });
  const entries = (root: string): string[] => {
    try { return readdirSync(root); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error; // An unreadable run store must not be mistaken for an empty one.
    }
  };
  for (;;) {
    const id = nextId('run-', roots.flatMap(entries), 3);
    try {
      // Exclusive mkdir also catches a directory/file/link created after scanning. Partial reservations stay
      // reserved on collision or failure: gaps are preferable to deleting or overwriting somebody else's files.
      for (const root of reserve) mkdirSync(join(root, id));
      return id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
}

export function createRun(cwd: string, input: { goal: Goal; kind?: ResearchRun['kind']; parentRunId?: string; harness: Harness; benchmark?: ResearchRun['benchmark'] }): ResearchRun {
  return withLock(cwd, () => {
    const id = reserveRunId(cwd, input.kind ?? 'research');
    const at = now();
    const run: ResearchRun = {
      id, projectId: projectId(cwd), kind: input.kind ?? 'research', goal: input.goal, status: 'active',
      workspace: projectRoot(cwd), harness: input.harness, ...(input.parentRunId ? { parentRunId: input.parentRunId } : {}),
      sessions: [], createdClaimIds: [], touchedClaimIds: [], artifactIds: [],
      ...(input.benchmark ? { benchmark: input.benchmark } : {}), createdAt: at, updatedAt: at,
    };
    writeJson(runFile(cwd, id), run);
    appendRunEvent(cwd, id, input.parentRunId ? 'run.forked' : 'run.created', { goal: input.goal, parentRunId: input.parentRunId, kind: run.kind }, run.projectId);
    return run;
  });
}

/** Changes a run under the lock; records `event` when given. */
export function updateRun(cwd: string, id: string, change: (run: ResearchRun) => ResearchRun | void, event?: { type: string; payload?: unknown }): ResearchRun {
  return withLock(cwd, () => {
    const current = getRun(cwd, id);
    if (!current) throw new Error(`No research run ${id} in this project.`);
    const draft = structuredClone(current);
    const next = change(draft) ?? draft;
    next.updatedAt = now();
    writeJson(runFile(cwd, id), next);
    if (event) appendRunEvent(cwd, id, event.type, event.payload ?? {}, current.projectId);
    return next;
  });
}

export function setStatus(cwd: string, id: string, status: RunStatus, reason?: string): ResearchRun {
  return updateRun(cwd, id, run => { run.status = status; }, { type: `run.${status === 'active' ? 'resumed' : status}`, payload: reason ? { reason } : {} });
}

export const runEvents = (cwd: string, id: string): RunEvent[] => readRunEvents(cwd, id);

/** The run and its ancestors, nearest first. */
export function lineage(cwd: string, id: string): ResearchRun[] {
  const out: ResearchRun[] = [];
  const seen = new Set<string>();
  for (let run = getRun(cwd, id); run && !seen.has(run.id); run = run.parentRunId ? getRun(cwd, run.parentRunId) : undefined) {
    seen.add(run.id);
    out.push(run);
  }
  return out;
}

/** Adds an id to one of the run's lists (outside any other lock). */
export function noteInRun(cwd: string, runId: string | undefined, field: 'createdClaimIds' | 'touchedClaimIds' | 'artifactIds', id: string) {
  if (!runId || !getRun(cwd, runId)) return;
  updateRun(cwd, runId, run => { if (!run[field].includes(id)) run[field].push(id); });
}

/** The newest session file of a run that still exists. */
export const lastSession = (run: ResearchRun) => [...run.sessions].reverse().find(path => existsSync(path));

/** A run in one line: id, status, objective, lineage. */
export function runLine(run: ResearchRun): string {
  const objective = run.goal.objective.split('\n')[0]!.slice(0, 90);
  return `${run.id} [${run.status}${run.kind === 'benchmark' ? ', benchmark' : ''}]${run.parentRunId ? ` ← ${run.parentRunId}` : ''} ${objective}`;
}

/** The text a pi-goal-x goal for this run starts with, so the two can be matched. */
export const goalMarker = (run: ResearchRun) => `${settings().goalPrefix} ${run.id}:`;

/** The objective given to pi-goal-x: the marker, the goal and its success criteria. */
export function goalObjective(run: ResearchRun): string {
  const goal = run.goal;
  return [
    `${goalMarker(run)} ${goal.objective}`,
    ...(goal.successCriteria?.length ? ['Success criteria:', ...goal.successCriteria.map(item => `- ${item}`)] : []),
    ...(goal.currentFocus ? [`Current focus: ${goal.currentFocus}`] : []),
    'Record findings as claims and register files as artifacts with the theoria tool; a claim is verified only when Lean checks a linked theorem.',
  ].join('\n');
}
