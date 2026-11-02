import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config } from '@theoria/shared/config';
import { appendRunEvent } from '@theoria/shared/events';
import { currentRunId, recordVerdict } from '@theoria/shared/verdicts';
import { projectRecord } from '@theoria/shared/project';
import type { TurnResult } from '@theoria/shared/agent-turn';
import { registerArtifact } from '@theoria/pi-research/api';
import { acquire, buildText, compile } from './build.ts';
import { environment } from './environment.ts';
import { collectEvidence, createPaper, draftProblems, paperPrompt, snapshotPaper } from './paper.ts';
import { buildId, paperFiles, paperSettings, projectFile, readState, rootOf, saveState, shown, stateDir, writeJson, type BuildResult } from './state.ts';

export interface PaperWorkflowResult { ok: boolean; status: 'ok' | 'errors' | 'unavailable' | 'cancelled' | 'timeout' | 'budget'; text: string; attempts: number; costUsd: number; build?: BuildResult; snapshot?: string }
export interface PaperWorkflowOptions {
  signal?: AbortSignal;
  progress?: (text: string) => void;
  turn: (prompt: string, signal: AbortSignal, budget: number) => Promise<TurnResult>;
}

/** The compiler/checks decide completion. Provider failures end the workflow, never masquerade as a draft. */
export async function writePaper(cwd: string, mode: 'create' | 'update', request: string, options: PaperWorkflowOptions): Promise<PaperWorkflowResult> {
  const root = rootOf(cwd);
  if (!projectRecord(root)?.name) return { ok: false, status: 'unavailable', text: `No Theoria project is selected at ${root}. Choose the intended project with /project list (or create one with /new-project), then run /latex paper ${mode}.`, attempts: 0, costUsd: 0 };
  const release = acquire(root, 'workflow');
  try { return await executeWorkflow(root, mode, request, options); }
  finally { release(); }
}

async function executeWorkflow(cwd: string, mode: 'create' | 'update', request: string, options: PaperWorkflowOptions): Promise<PaperWorkflowResult> {
  const settings = paperSettings(cwd);
  const main = projectFile(cwd, settings.main);
  if (mode === 'create' && existsSync(main)) throw new Error('A paper already exists. Use /latex paper update.');
  if (mode === 'update' && !existsSync(main)) throw new Error('No paper exists yet. Use /latex paper create.');
  const env = await environment(cwd);
  if (env.problem) return { ok: false, status: 'unavailable', text: env.problem, attempts: 0, costUsd: 0 };
  const limits = config().latex.workflow;
  const timeout = AbortSignal.timeout(limits.timeoutMinutes * 60_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const runId = currentRunId(cwd);
  const started = Date.now();
  const attemptDir = join(stateDir(cwd), 'attempts', buildId());
  mkdirSync(attemptDir, { recursive: true });
  const evidence = collectEvidence(cwd);
  const evidenceFile = join(attemptDir, 'evidence.json');
  writeJson(evidenceFile, evidence);
  const previousEvidence = readState(cwd).workflow?.evidence;
  const snapshot = mode === 'update' ? join(attemptDir, 'before') : undefined;
  if (snapshot) snapshotPaper(cwd, snapshot);
  else createPaper(cwd);
  const result: PaperWorkflowResult = { ok: false, status: 'errors', text: '', attempts: 0, costUsd: 0, ...(snapshot ? { snapshot: shown(cwd, snapshot) } : {}) };
  const prompt = paperPrompt(cwd, mode);
  const contract = `CURRENT PROJECT: ${evidence.projectName}\nProject root: ${cwd}\nProject paper: ${main}\nPaper source folder: ${dirname(main)}\nUse only this project's research material; parent/sibling projects and unrelated conversation history are not evidence for this paper.\nCompiler: ${settings.engine}\nRequest: ${request || (mode === 'create' ? 'Write a research draft from the project material.' : 'Update the paper using current project evidence.')}\nEvidence snapshot: ${evidenceFile}${previousEvidence ? `\nPrevious evidence snapshot: ${projectFile(cwd, previousEvidence)}` : ''}\nYou have at most ${limits.maxAttempts} checked attempts in this workflow.`;
  let nextPrompt = `${prompt.text}\n\n${contract}\n\nPROJECT MATERIAL (bounded excerpts; inspect source files for full context):\n${evidence.text}`;
  if (runId) appendRunEvent(cwd, runId, 'latex.started', { mode, request, evidence: shown(cwd, evidenceFile) });
  const persist = (status: string) => saveState(cwd, { workflow: { mode, at: new Date().toISOString(), status, request, snapshot: result.snapshot, evidence: shown(cwd, evidenceFile), costUsd: result.costUsd } });
  persist('running');
  try {
    for (let attempt = 1; attempt <= limits.maxAttempts; attempt += 1) {
      if (signal.aborted) break;
      result.attempts = attempt;
      options.progress?.(`${mode === 'create' ? 'Writing' : 'Updating'} ${evidence.projectName} · attempt ${attempt}/${limits.maxAttempts}`);
      const turn = await options.turn(nextPrompt, signal, limits.maxCostUsd - result.costUsd);
      result.costUsd += turn.costUsd;
      if (result.costUsd >= limits.maxCostUsd) { result.status = 'budget'; result.text = 'The paper workflow reached its cost limit. Draft changes are preserved.'; break; }
      if (turn.error) { result.status = 'unavailable'; result.text = `The model could not complete the writing turn: ${turn.error}`; break; }
      if (turn.aborted || signal.aborted) { result.status = 'cancelled'; break; }
      options.progress?.('Checking and compiling the paper…');
      const build = await compile(cwd, { signal, environment: env, runId });
      result.build = build;
      const problems = draftProblems(cwd);
      problems.push(...build.warnings.filter(warning => /undefined|citation.*not found|reference.*not found/i.test(warning)));
      if (build.status === 'ok' && !problems.length) {
        for (const file of paperFiles(cwd).filter(path => /\.(tex|bib|md)$/.test(path))) registerArtifact(cwd, { path: file, kind: 'paper', runId, description: `Paper ${mode}`, metadata: { evidence: shown(cwd, evidenceFile), buildId: build.id } });
        registerArtifact(cwd, { path: evidenceFile, kind: 'note', runId, description: 'Paper evidence snapshot' });
        result.ok = true; result.status = 'ok'; result.text = `Paper ${mode === 'create' ? 'created' : 'updated'} and compiled.\n${buildText(build)}\nContent is an evidence-based draft; the compiler checks the document, not its scientific claims.`;
        break;
      }
      result.status = build.status === 'ok' ? 'errors' : build.status;
      result.text = [buildText(build), ...problems].join('\n');
      if (build.status === 'unavailable' || build.status === 'cancelled' || build.status === 'timeout') break;
      nextPrompt = `Repair this paper after Theoria's check, preserving its content and the original writing request.\n${contract}\n\n${result.text}\n\nDo not alter compiler settings or build records. Edit the paper sources and finish your turn.`;
    }
    if (signal.aborted || result.status === 'cancelled') {
      result.status = timeout.aborted ? 'timeout' : 'cancelled';
      result.text = `Paper workflow ${result.status}. Draft changes and the previous source snapshot are preserved.`;
    }
    return result;
  } catch (error) {
    result.status = signal.aborted ? timeout.aborted ? 'timeout' : 'cancelled' : 'errors';
    result.text = error instanceof Error ? error.message : String(error);
    return result;
  } finally {
    persist(result.status);
    writeJson(join(attemptDir, 'result.json'), result);
    recordVerdict(cwd, { workflow: `latex-${mode}`, outcome: result.status, ok: result.ok, file: settings.main, durationMs: Date.now() - started });
    if (runId) appendRunEvent(cwd, runId, 'latex.completed', { mode, status: result.status, attempts: result.attempts, costUsd: result.costUsd, buildId: result.build?.id });
  }
}
