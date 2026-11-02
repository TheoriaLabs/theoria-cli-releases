import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from './config.ts';
import { projectPath, projectRoot } from './paths.ts';
import { appendRunEvent } from './events.ts';

/**
 * A project's workflow verdicts: one line per verdict, in `.theoria/<project.verdictsFile>`. It records what the
 * files alone cannot show, such as a proof attempt that failed and was rolled back. Each line is the verdict as
 * Theoria's check gave it; nothing here is re-judged. The research run the verdict belongs to (`runIdEnv`, set by the
 * research extension for the session's current run) is recorded with it, and the verdict is appended to that run's
 * event log.
 */

export interface VerdictEntry {
  at: string;
  workflow: string;
  outcome: string;
  ok: boolean;
  theorem?: string;
  scope?: 'file' | 'theorem';
  theorems?: string[];
  targetCount?: number;
  environment?: string;
  baselineLines?: number;
  lines?: number;
  linesSaved?: number;
  reductionPercent?: number;
  baselineHeartbeats?: number;
  heartbeats?: number;
  heartbeatsSaved?: number;
  heartbeatReductionPercent?: number;
  compress_score?: number;
  scoreWeights?: { loc: number; heartbeats: number; tokens?: number; compatibility?: number };
  scoreComponents?: { loc: number; heartbeats: number; tokens: number; compatibility: number };
  baselineTokens?: number;
  tokens?: number;
  tokensSaved?: number;
  tokenReductionPercent?: number;
  tokenizer?: string;
  versionsChecked?: string[];
  compatibilityPercent?: number;
  roundsRequested?: number;
  roundsCompleted?: number;
  roundsImproved?: number;
  versionsPassed?: string[];
  dependencies?: string[];
  reportPath?: string;
  baselineDeclarations?: { name: string; lines: number; heartbeats?: number; sharedCommand?: boolean }[];
  declarationMetrics?: { name: string; lines: number; heartbeats?: number; sharedCommand?: boolean }[];
  paretoCandidates?: { round: number; file: string; lines: number; heartbeats: number; compress_score: number }[];
  roundSummaries?: { round: number; status: string; compress_score: number; scoreGain: number }[];
  candidateScores?: { round: number; attempt: number; verified: boolean; accepted: boolean; compress_score: number | null }[];
  checkDurationMs?: number;
  interrupted?: boolean;
  /** The file the workflow worked on, relative to the project. */
  file?: string;
  durationMs?: number;
  runId?: string;
}

/** The session's current research run, set by the research extension; read by everything that records into it. */
export const runIdEnv = 'THEORIA_RUN_ID';
/** Run numbers are project-local. An inherited run-001 alone is never enough to bind another project's work. */
export const runProjectEnv = 'THEORIA_RUN_PROJECT';
const canonicalRoot = (cwd: string) => { try { return realpathSync(projectRoot(cwd)); } catch { return resolve(projectRoot(cwd)); } };

export function bindRun(cwd: string, runId?: string) {
  if (!runId) { delete process.env[runIdEnv]; delete process.env[runProjectEnv]; return; }
  process.env[runIdEnv] = runId;
  process.env[runProjectEnv] = canonicalRoot(cwd);
}

export function currentRunId(cwd: string): string | undefined {
  return process.env[runProjectEnv] === canonicalRoot(cwd) ? process.env[runIdEnv] || undefined : undefined;
}


function verdictsPath(cwd: string): string {
  const path = projectPath(cwd, config().project.verdictsFile);
  const legacy = projectPath(cwd, config().project.legacyVerdictsFile);
  if (!existsSync(path) && existsSync(legacy)) { try { renameSync(legacy, path); } catch { return legacy; } }
  return path;
}

export function recordVerdict(cwd: string, entry: Omit<VerdictEntry, 'at' | 'runId'>): void {
  const runId = currentRunId(cwd);
  const full: VerdictEntry = { at: new Date().toISOString(), ...entry, ...(runId ? { runId } : {}) };
  try {
    const path = verdictsPath(cwd);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(full)}\n`, 'utf8');
  } catch { /* a read-only folder keeps no history; the verdict itself was still shown */ }
  if (runId) appendRunEvent(cwd, runId, 'verdict.recorded', full);
}

/** The latest verdicts, newest first. */
export function recentVerdicts(cwd: string, count = config().project.statusRecentVerdicts): VerdictEntry[] {
  let text = '';
  try { text = readFileSync(verdictsPath(cwd), 'utf8'); } catch { return []; }
  return text.trim().split('\n').reverse().flatMap(line => {
    try { return [JSON.parse(line) as VerdictEntry]; } catch { return []; }
  }).slice(0, count);
}

/** "3 min ago", "2 h ago", "4 d ago". */
export function ago(iso: string | Date): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}
