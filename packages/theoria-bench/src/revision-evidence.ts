import { createReadStream, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { isAbsolute, join, relative } from 'node:path';
import { sourceHash, type ScoreWeights } from '@theoria/pi-workflows/api';
import { readBenchRun, trialDir, trials } from './store.ts';
import type { TrialMetrics } from './types.ts';
import type { CompressionInputs } from './compression-types.ts';

/** The evaluations a supervisor (/autoresearch) has completed, in the shape revision evidence reads. */
export interface EvidenceSource {
  id: string;
  sequence: number;
  manifestHash: string;
  skills: { version: number; sha256: string }[];
  operations: { id: string; kind: 'evaluate' | 'revise'; status: 'running' | 'completed' | 'interrupted'; runId?: string; score?: number }[];
}
/** The frozen inputs and splits those evaluations ran with, and the evidence size limit. */
export interface EvidenceScope {
  inputs: CompressionInputs;
  splits: Record<string, string>;
  developmentSplits: string[];
  finalSplit: string;
  evidenceChars: number;
}

interface Measurement { sourceHash?: string; lines: number; heartbeats: number; tokens?: number; tokenizer?: string; versionsChecked?: string[]; versionsPassed?: string[] }
interface Report {
  baseline?: Measurement; best?: Measurement;
  roundsRequested?: number; roundsCompleted?: number;
  roundSummaries?: { round: number; status: string; compress_score: number; scoreGain: number }[];
  attempts?: { round: number; attempt: number; accepted: boolean; verified: boolean; reason: string }[];
  transformations?: string[];
}
interface Excerpt { kind: string; [key: string]: unknown }
interface TrajectoryStats {
  toolCalls: number; toolErrors: number; profiledChecks: number; unprofiledChecks: number;
  repeatedSearches: number; malformedLines: number; files: number; tools: Record<string, number>;
}
export interface RevisionEvidence {
  schemaVersion: 1;
  sourceSequence: number;
  manifestHash: string;
  benchmarkId: string;
  benchmarkVersion: string;
  executionCodeHash: string;
  environment: { toolchain: string; mathlibRev?: string };
  scoreWeights: ScoreWeights;
  skills: { version: number; sha256: string }[];
  developmentSplits: string[];
  budget: { limitChars: number; usedChars: number };
  coverage: { evaluations: number; trials: number; excerptsAvailable: number; excerptsIncluded: number };
  evaluations: { id: string; runId: string; split: string; score?: number; model: string; thinking: string; repetitions: number; rounds?: number; timeoutMinutes: number | null; maxTurns: number | null; maxCostUsd: number | null }[];
  trials: {
    evaluationId: string; runId: string; trialId: string; task: string; split: string; replicate: number;
    status: string; reason?: string; original?: Measurement; best?: Measurement; compress_score: number;
    usage: { costUsd: number; turns: number; tokens: number; durationMs: number; attempts: number; errors: number; stoppedBy?: string };
    rounds: NonNullable<Report['roundSummaries']>;
    trajectory: { file: string; stats: TrajectoryStats; excerptsAvailable: number; excerptsIncluded: number };
  }[];
}
interface Detail { schemaVersion: 1; runId: string; trialId: string; excerpts: Excerpt[]; omittedExcerpts: number }
export interface EvidenceBundle {
  evidence: RevisionEvidence;
  text: string;
  files: { path: string; text: string }[];
  sha256: string;
}

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, Math.ceil(limit / 2))}\n[... omitted ...]\n${text.slice(-Math.floor(limit / 2))}` : text;
const serialize = (value: unknown) => `${JSON.stringify(value)}\n`;
const measurement = (value?: Measurement): Measurement | undefined => value && ({ sourceHash: value.sourceHash, lines: value.lines, heartbeats: value.heartbeats,
  ...(value.tokens !== undefined ? { tokens: value.tokens, tokenizer: value.tokenizer } : {}),
  ...(value.versionsChecked ? { versionsChecked: value.versionsChecked, versionsPassed: value.versionsPassed } : {}) });
const sumUsage = (metrics: Partial<TrialMetrics>[], key: 'costUsd' | 'turns' | 'tokens' | 'durationMs') => metrics.reduce((sum, item) => sum + (item[key] ?? 0), 0);

/** All optional reads remain within the selected development trial, including after symlink resolution. */
function scoped(root: string, file: string): boolean {
  if (!existsSync(file) || lstatSync(root).isSymbolicLink()) return false;
  const path = relative(realpathSync(root), realpathSync(file));
  return !isAbsolute(path) && path !== '..' && !path.startsWith('../');
}

async function summarizeTrajectory(root: string, signal?: AbortSignal) {
  const stats: TrajectoryStats = { toolCalls: 0, toolErrors: 0, profiledChecks: 0, unprofiledChecks: 0, repeatedSearches: 0, malformedLines: 0, files: 0, tools: {} };
  const errors: Excerpt[] = [], searches: Excerpt[] = [], messages: Excerpt[] = [];
  const seenSearches = new Set<string>();
  const remember = (list: Excerpt[], value: Excerpt, capacity: number) => {
    if (list.length === capacity) list.splice(1, 1); // keep the first and most recent records, not just a prefix.
    list.push(value);
  };
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return { stats, excerpts: [] as Excerpt[] };
  for (const attempt of readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && /^attempt-\d+$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const dir = join(root, attempt.name, 'session');
    if (!scoped(root, dir)) continue;
    for (const name of readdirSync(dir).filter(name => name.endsWith('.jsonl')).sort()) {
      const file = join(dir, name);
      if (!scoped(root, file)) continue;
      stats.files++;
      const pending = new Map<string, { name: string; query?: string; at?: string }>();
      const stream = createReadStream(file, { encoding: 'utf8', signal });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          signal?.throwIfAborted();
          if (!line.trim()) continue;
          let entry;
          try { entry = JSON.parse(line); } catch { stats.malformedLines++; continue; }
          const msg = entry.message;
          if (!msg) continue;
          if (msg.role === 'assistant') {
            if (msg.stopReason === 'error') remember(errors, { kind: 'model_error', at: entry.timestamp, text: clip(String(msg.errorMessage ?? 'Unknown provider error'), 400) }, 6);
            for (const part of Array.isArray(msg.content) ? msg.content : []) {
              if (part.type === 'text' && typeof part.text === 'string') remember(messages, { kind: 'agent_note', at: entry.timestamp, text: clip(part.text, 600) }, 4);
              if (part.type !== 'toolCall') continue;
              const tool = String(part.name).slice(0, 100);
              stats.toolCalls++;
              stats.tools[tool] = (stats.tools[tool] ?? 0) + 1;
              const args = part.arguments ?? {};
              const query = tool.startsWith('mcp__') && typeof args.query === 'string' ? clip(args.query, 240) : undefined;
              pending.set(part.id, { name: tool, query, at: entry.timestamp });
              if (tool === 'lean_check') args.measureHeartbeats === true ? stats.profiledChecks++ : stats.unprofiledChecks++;
              if (query) { const key = `${tool}:${query}`; if (seenSearches.has(key)) stats.repeatedSearches++; seenSearches.add(key); }
            }
          } else if (msg.role === 'toolResult') {
            const call = pending.get(msg.toolCallId);
            pending.delete(msg.toolCallId);
            if (!call) continue;
            const text = (Array.isArray(msg.content) ? msg.content : []).filter((part: { type: string }) => part.type === 'text').map((part: { text: string }) => part.text).join('\n');
            const failed = msg.isError === true || /Lean check: (errors|timeout|unavailable)/.test(text);
            if (failed) {
              stats.toolErrors++;
              remember(errors, { kind: 'tool_error', tool: call.name, at: entry.timestamp, query: call.query, text: clip(text, 600) }, 6);
            }
            if (call.query) {
              let result;
              try { result = JSON.parse(text); } catch { /* errors can be plain text */ }
              const items = result?.items ?? result?.results ?? [];
              const names = Array.isArray(items) ? items.slice(0, 10).map(item => String(item.name ?? item.formal_name ?? '').slice(0, 120)).filter(Boolean) : [];
              remember(searches, { kind: 'search_result', tool: call.name, at: entry.timestamp, query: call.query, failed, names,
                index: typeof result?.index === 'string' ? result.index.slice(0, 80) : undefined,
                elapsedMs: call.at ? Math.max(0, Date.parse(entry.timestamp) - Date.parse(call.at)) : undefined }, 8);
            }
          }
        }
      } finally { lines.close(); stream.destroy(); }
    }
  }
  return { stats, excerpts: [...errors, ...searches, ...messages] };
}

/** Compact every completed development trial; allocate optional excerpts after reserving all required summaries. */
export async function buildRevisionEvidence(cwd: string, state: EvidenceSource, manifest: EvidenceScope, signal?: AbortSignal): Promise<EvidenceBundle> {
  const evidence: RevisionEvidence = {
    schemaVersion: 1, sourceSequence: state.sequence, manifestHash: state.manifestHash,
    benchmarkId: manifest.inputs.benchmarkId, benchmarkVersion: manifest.inputs.benchmarkVersion, executionCodeHash: manifest.inputs.codeHash,
    environment: { toolchain: manifest.inputs.lean.toolchain, mathlibRev: manifest.inputs.lean.mathlibRev },
    scoreWeights: manifest.inputs.policy.scoreWeights, skills: state.skills.map(skill => ({ version: skill.version, sha256: skill.sha256 })),
    developmentSplits: manifest.developmentSplits, budget: { limitChars: manifest.evidenceChars, usedChars: 0 },
    coverage: { evaluations: 0, trials: 0, excerptsAvailable: 0, excerptsIncluded: 0 }, evaluations: [], trials: [],
  };
  const details: { path: string; data: Detail; candidates: Excerpt[] }[] = [];
  for (const op of state.operations.filter(op => op.kind === 'evaluate' && op.status === 'completed').sort((a, b) => a.id.localeCompare(b.id))) {
    signal?.throwIfAborted();
    if (!op.runId || !/^run-\d+$/.test(op.runId)) throw new Error(`Revision evidence: evaluation ${op.id} has no valid run.`);
    const run = readBenchRun(cwd, op.runId);
    if (!run) throw new Error(`Revision evidence: missing evaluation ${op.runId}.`);
    if (run.split === manifest.finalSplit || !manifest.developmentSplits.includes(run.split)) continue;
    if (run.sealed) throw new Error('Revision evidence cannot include sealed evaluations.');
    const expected = new Set(manifest.inputs.tasks.filter(entry => manifest.splits[entry.task.id] === run.split).map(entry => entry.task.id));
    const all = trials(cwd, op.runId).sort((a, b) => a.id.localeCompare(b.id));
    if (!all.length || all.length !== expected.size * run.config.repetitions || all.length !== run.trialIds.length)
      throw new Error(`Revision evidence: incomplete trial coverage for ${op.runId}.`);
    for (const task of expected) if (all.filter(trial => trial.taskId === task).length !== run.config.repetitions)
      throw new Error(`Revision evidence: missing repetitions for ${task}.`);
    evidence.evaluations.push({ id: op.id, runId: op.runId, split: run.split, score: op.score, model: run.config.model, thinking: run.config.thinking,
      repetitions: run.config.repetitions, rounds: run.config.compression?.rounds, timeoutMinutes: run.config.timeoutMinutes, maxTurns: run.config.maxTurns, maxCostUsd: run.config.maxCostUsd });
    for (const trial of all) {
      if (!expected.has(trial.taskId) || trial.split !== run.split || trial.sealed || !['passed', 'failed'].includes(trial.status)
        || !trial.metrics.compression?.verified || !Number.isFinite(trial.metrics.compression.compress_score))
        throw new Error(`Revision evidence: ${op.runId}/${trial.id} is not a completed verified development trial.`);
      const root = trialDir(cwd, op.runId, trial.id);
      const reportPath = join(root, 'compression/report.json');
      const report: Report = scoped(root, reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
      const trajectory = await summarizeTrajectory(root, signal);
      const candidates: Excerpt[] = [];
      const original = report.baseline ?? trial.metrics.compression.baseline;
      const best = report.best ?? trial.metrics.compression.best;
      const source = manifest.inputs.tasks.find(entry => entry.task.id === trial.taskId)!.source;
      const proofPath = join(root, 'Solution.lean');
      if (best?.sourceHash && scoped(root, proofPath)) {
        const proof = readFileSync(proofPath, 'utf8');
        if (sourceHash(proof) === best.sourceHash && proof !== source) {
          let start = 0, end = 0;
          while (start < source.length && start < proof.length && source[start] === proof[start]) start++;
          while (end < source.length - start && end < proof.length - start && source[source.length - 1 - end] === proof[proof.length - 1 - end]) end++;
          candidates.push({ kind: 'verified_source_change_excerpt', originalHash: original?.sourceHash, bestHash: best.sourceHash,
            before: clip(source.slice(start, source.length - end), 1200), after: clip(proof.slice(start, proof.length - end), 1200) });
        }
      }
      for (const note of (report.transformations ?? []).slice(-3)) candidates.push({ kind: 'agent_transformation_report', text: clip(note, 1000) });
      for (const attempt of (report.attempts ?? []).filter(attempt => !attempt.accepted).slice(-3)) candidates.push({ kind: 'candidate_rejection',
        round: attempt.round, attempt: attempt.attempt, verified: attempt.verified, reason: clip(attempt.reason, 600) });
      candidates.push(...trajectory.excerpts);
      const path = `trajectories/${op.runId}-${sourceHash(trial.id).slice(0, 16)}.json`;
      const usage = [trial.metrics, ...trial.previousAttempts ?? []];
      evidence.trials.push({ evaluationId: op.id, runId: op.runId, trialId: trial.id, task: trial.taskId, split: run.split, replicate: trial.replicate,
        status: trial.status, reason: clip(trial.metrics.compression.reason, 240), original: measurement(original), best: measurement(best), compress_score: trial.metrics.compression.compress_score,
        usage: { costUsd: sumUsage(usage, 'costUsd'), turns: sumUsage(usage, 'turns'), tokens: sumUsage(usage, 'tokens'), durationMs: sumUsage(usage, 'durationMs'),
          attempts: trial.attempt ?? 1, errors: trial.errors, stoppedBy: trial.metrics.stoppedBy },
        rounds: report.roundSummaries ?? [], trajectory: { file: path, stats: trajectory.stats, excerptsAvailable: candidates.length, excerptsIncluded: 0 } });
      details.push({ path, data: { schemaVersion: 1, runId: op.runId, trialId: trial.id, excerpts: [], omittedExcerpts: candidates.length }, candidates });
    }
  }
  if (!evidence.trials.length) throw new Error('Revision evidence: no completed development trials; refusing an evidence-free revision.');
  evidence.coverage.evaluations = evidence.evaluations.length;
  evidence.coverage.trials = evidence.trials.length;
  evidence.coverage.excerptsAvailable = details.reduce((sum, item) => sum + item.candidates.length, 0);

  const pack = () => {
    evidence.coverage.excerptsIncluded = details.reduce((sum, item) => sum + item.data.excerpts.length, 0);
    for (let i = 0; i < details.length; i++) {
      evidence.trials[i]!.trajectory.excerptsIncluded = details[i]!.data.excerpts.length;
      details[i]!.data.omittedExcerpts = details[i]!.candidates.length - details[i]!.data.excerpts.length;
    }
    const files = details.map(item => ({ path: item.path, text: serialize(item.data) }));
    let text = serialize(evidence);
    for (let i = 0; i < 5; i++) {
      const used = text.length + files.reduce((sum, file) => sum + file.text.length, 0);
      if (used === evidence.budget.usedChars) break;
      evidence.budget.usedChars = used;
      text = serialize(evidence);
    }
    return { text, files, used: text.length + files.reduce((sum, file) => sum + file.text.length, 0) };
  };
  let packed = pack();
  if (packed.used > manifest.evidenceChars) throw new Error(`Revision evidence: required summaries for ${evidence.trials.length} trials need ${packed.used} characters, above evidenceChars=${manifest.evidenceChars}. Increase the evidence budget; no revision was dispatched.`);
  // Equal turns across tasks: one large early trace cannot displace the other tasks.
  const maximum = Math.max(...details.map(item => item.candidates.length));
  for (let index = 0; index < maximum; index++) for (const detail of details) {
    const item = detail.candidates[index];
    if (!item) continue;
    detail.data.excerpts.push(item);
    const candidate = pack();
    if (candidate.used <= manifest.evidenceChars) packed = candidate;
    else { detail.data.excerpts.pop(); packed = pack(); }
  }
  return { evidence, text: packed.text, files: packed.files, sha256: sourceHash(JSON.stringify([{ path: 'evidence.json', text: packed.text }, ...packed.files])) };
}
