import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { label, type Environment } from '@theoria/pi-lean/api';
import { config } from '@theoria/shared/config';
import { projectPath } from '@theoria/shared/paths';
import { checkCompressedFile, compressionDetails, type CompressionBaseline, type CompressionVerdict } from './compression-gate.ts';
import { compressionMetrics, compressionMetricsText, compressionScore, dominates, sourceHash, type CompressionMeasurement } from './compression-metrics.ts';
import { read } from './gate.ts';
import { render, type Emphasis, type WorkflowPrompt } from './prompt.ts';
import { compressionSkillLabel, type CompressionSkill } from './compress-skill.ts';
import type { WorkflowRuntime } from './runtime.ts';

interface Candidate { round: number; file: string; source: string; measurement: CompressionMeasurement; checkDurationMs?: number }
interface AttemptRecord { round: number; attempt: number; file?: string; verified: boolean; accepted: boolean; reason: string; measurement?: CompressionMeasurement; compress_score: number | null }
interface RoundSummary { round: number; status: string; compress_score: number; scoreGain: number }

export interface CompressionHost<C> {
  signal?: AbortSignal;
  shown(ctx: C, path: string): string;
  status(ctx: C, text: string | undefined): void;
  turn(ctx: C, text: string): Promise<{ aborted: boolean; reply: string; error?: string; limit?: 'cost' | 'turns' | 'timeout' }>;
  promptNote(ctx: C, prompt: WorkflowPrompt): string;
  baseVars: WorkflowRuntime['baseVars'];
  progressCard: WorkflowRuntime['progressCard'];
  card: WorkflowRuntime['card'];
}

export interface CompressionExecution {
  skill?: CompressionSkill;
  verification?: 'preservation' | 'comparator';
  onProgress?: (progress: { stage: 'working' | 'checking'; round: number; rounds: number; candidate: number }) => void;
  directory?: string;
  /** Hash of the frozen skill, prompt, model and policy. Reject incompatible resumes. */
  key?: string;
  resume?: boolean;
  evaluate?: (source: string, best: CompressionMeasurement) => Promise<CompressionVerdict>;
}

/** Optimization rounds are separate from bounded repair attempts. Only Theoria-verified improvements advance. */
export async function compressionRounds<C extends { cwd: string }>(rt: CompressionHost<C>, ctx: C, prompt: WorkflowPrompt, environment: Environment,
  baseline: CompressionBaseline, rounds: number, emphasis: Emphasis, vars: Record<string, string | number | boolean>, execution: CompressionExecution = {}) {
  const { file, theorem, before } = baseline.input;
  const root = projectPath(ctx.cwd, config().paths.attemptsDir);
  mkdirSync(root, { recursive: true });
  const dir = execution.directory ?? mkdtempSync(join(root, `${basename(file, '.lean')}-compression-`));
  mkdirSync(dir, { recursive: true });
  const reportPath = join(dir, 'report.json');
  const initialPath = join(dir, 'baseline.lean');
  if (!existsSync(initialPath)) writeFileSync(initialPath, before, 'utf8');
  else if (readFileSync(initialPath, 'utf8') !== before) throw new Error('Compression checkpoint baseline mismatch.');
  let best: Candidate = { round: 0, file: initialPath, source: before, measurement: baseline.measurement };
  let frontier: Candidate[] = [best];
  const attempts: AttemptRecord[] = [];
  const roundSummaries: RoundSummary[] = [];
  const notes: string[] = [];
  let completed = 0;
  let improved = 0;
  let outcome = 'not_improved';
  let reason = 'No worthwhile improvement remains.';
  let limit: 'cost' | 'turns' | 'timeout' | undefined;
  let kept: string | undefined;
  const shown = rt.shown(ctx, file);
  const settings = baseline.policy;
  const verification = execution.verification ?? 'preservation';
  const scoreWeights = { ...settings.scoreWeights };
  const score = (value: CompressionMeasurement) => compressionScore(baseline.measurement, value, scoreWeights);
  let activeRound = 0;
  let activeAttempt = 0;
  let roundStartScore = 0;
  if (execution.resume && existsSync(reportPath)) {
    const saved = JSON.parse(readFileSync(reportPath, 'utf8'));
    if (saved.executionKey !== execution.key || saved.baseline.sourceHash !== baseline.measurement.sourceHash) throw new Error('Compression inputs changed; cannot resume.');
    const restoreCandidate = (entry: { round: number; file: string; measurement?: CompressionMeasurement } & Partial<CompressionMeasurement>): Candidate => {
      const path = join(ctx.cwd, entry.file);
      const source = readFileSync(path, 'utf8');
      const measured = entry.measurement ?? entry as CompressionMeasurement;
      if (sourceHash(source) !== measured.sourceHash) throw new Error('Compression checkpoint source hash mismatch.');
      return { round: entry.round, file: path, source, measurement: measured };
    };
    best = restoreCandidate(saved.best);
    completed = saved.roundsCompleted;
    improved = saved.roundsImproved;
    attempts.push(...saved.attempts);
    roundSummaries.push(...saved.roundSummaries);
    notes.push(...saved.transformations);
    frontier = (saved.frontierCheckpoints ?? [saved.best]).map(restoreCandidate);
    writeFileSync(file, best.source, 'utf8');
    const checked = execution.evaluate ? await execution.evaluate(best.source, best.measurement) : await checkCompressedFile(environment, baseline, best.measurement);
    if (!checked.verified) throw new Error(`Saved checkpoint no longer verifies: ${checked.summary}`);
  }
  const recordCandidate = (record: Omit<AttemptRecord, 'compress_score'>) => {
    const compress_score = record.verified && record.measurement ? score(record.measurement) : null;
    attempts.push({ ...record, compress_score });
    rt.progressCard(`/compress · round ${record.round}/${rounds} · candidate ${record.attempt} · ${record.accepted ? 'accepted' : 'not accepted'}`, [
      compress_score === null ? 'compress_score: n/a (candidate not verified and measured).' : compressionMetricsText(compressionMetrics(
        baseline.measurement, record.measurement!, scoreWeights)),
      record.reason.slice(0, config().workflows.card.diagnosticsChars),
    ], { phase: 'candidate', round: record.round, candidate: record.attempt, ok: record.accepted, verified: record.verified, compress_score, scoreWeights });
    writeReport();
  };
  const finishRound = (round: number, status: string) => {
    const summary = { round, status, compress_score: score(best.measurement), scoreGain: score(best.measurement) - roundStartScore };
    roundSummaries.push(summary);
    rt.progressCard(`/compress · round ${round}/${rounds} · ${status}`, [
      `Retained compress_score: ${summary.compress_score.toFixed(2)}% · round gain: ${summary.scoreGain.toFixed(2)} percentage points.`,
      compressionMetricsText(compressionMetrics(baseline.measurement, best.measurement, scoreWeights)),
    ], { phase: 'round', ...summary, scoreWeights, tone: 'accent' });
  };
  const saveDraft = (round: number, attempt: number) => {
    const source = read(file);
    if (source === undefined || source === best.source) return undefined;
    const path = join(dir, `round-${round}-attempt-${attempt}.lean`);
    writeFileSync(path, source, 'utf8');
    kept = path;
    return path;
  };
  const restore = () => { if (read(file) !== best.source) writeFileSync(file, best.source, 'utf8'); };
  const frontierDetails = () => frontier.map(candidate => ({ round: candidate.round, file: rt.shown(ctx, candidate.file),
    ...compressionMetrics(baseline.measurement, candidate.measurement, scoreWeights) }));
  const writeReport = () => {
    const temporary = `${reportPath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({
    executionKey: execution.key,
    verification,
    baselinePreparation: { skipVerification: !!baseline.input.skipVerification, cacheHit: !!baseline.cacheHit },
    ...(execution.skill ? { skill: execution.skill } : {}),
    target: { file: shown, scope: theorem ? 'theorem' : 'file', theorem }, environment: label(environment),
    roundsRequested: rounds, roundsCompleted: completed, roundsImproved: improved,
    baseline: { ...baseline.measurement, compress_score: score(baseline.measurement) }, best: { round: best.round, file: rt.shown(ctx, best.file), ...best.measurement, compress_score: score(best.measurement) },
    frontierCheckpoints: frontier.map(candidate => ({ round: candidate.round, file: rt.shown(ctx, candidate.file), measurement: candidate.measurement })),
    objective: { emphasis, ...settings }, outcome, reason, limit, paretoCandidates: frontierDetails(), attempts, roundSummaries, transformations: notes,
  }, null, 2)}\n`, 'utf8');
    renameSync(temporary, reportPath);
  };
  writeReport();
  rt.progressCard('/compress · verified baseline', [
    ...(baseline.input.skipVerification ? [baseline.cacheHit ? 'Original verification skipped: reused matching baseline measurements.' : 'No matching baseline cache: original measured once for scoring.'] : []),
    ...(execution.skill ? [`Skill: ${compressionSkillLabel(execution.skill)}`] : []),
    compressionMetricsText(compressionMetrics(baseline.measurement, baseline.measurement, scoreWeights)),
    `Weights: tokens ${scoreWeights.tokens ?? 0}, heartbeats ${scoreWeights.heartbeats}, compatibility ${scoreWeights.compatibility ?? 0}, LOC ${scoreWeights.loc}. Reductions are relative to the original; compatibility is an absolute pass percentage.`,
  ], { phase: 'baseline', compress_score: score(baseline.measurement), scoreWeights, tone: 'accent' });
  try {
    roundLoop: for (let round = completed + 1; round <= rounds; round += 1) {
      activeRound = round;
      roundStartScore = score(best.measurement);
      let diagnostics = '';
      const firstAttempt = attempts.filter(entry => entry.round === round).length + 1;
      if (firstAttempt > prompt.settings.maxAttempts) { completed = round; reason = 'The interrupted round exhausted its repair attempts.'; break roundLoop; }
      for (let attempt = firstAttempt; attempt <= prompt.settings.maxAttempts; attempt += 1) {
        activeAttempt = attempt;
        execution.onProgress?.({ stage: 'working', round, rounds, candidate: attempt });
        rt.status(ctx, `/compress ${theorem ?? shown} · round ${round}/${rounds} · attempt ${attempt}/${prompt.settings.maxAttempts}`);
        const roundVars = { ...vars, comparator: verification === 'comparator', file: shown, theorem: theorem ?? '', round, rounds, current_lines: best.measurement.lines,
          current_heartbeats: best.measurement.heartbeats.toFixed(3), baseline_heartbeats: baseline.measurement.heartbeats.toFixed(3),
          current_measurements: JSON.stringify(best.measurement, null, 2), best_snapshot: rt.shown(ctx, best.file),
          heartbeat_regression_limit: settings.maxHeartbeatRegressionPercent, minimum_improvement: settings.minImprovementPercent,
          score_weights: JSON.stringify(scoreWeights), current_score: score(best.measurement).toFixed(2),
          score_formula: `${scoreWeights.tokens ?? 0} × proof-token reduction % + ${scoreWeights.heartbeats} × heartbeat reduction % + ${scoreWeights.compatibility ?? 0} × measured compatibility % + ${scoreWeights.loc} × LOC reduction %`,
          ...rt.baseVars(environment, prompt, attempt, diagnostics) };
        const message = render(attempt === 1 ? prompt.body : prompt.retry, String(vars.request ?? ''), roundVars);
        const turn = await rt.turn(ctx, message);
        const draft = saveDraft(round, attempt);
        if (turn.aborted || turn.error || rt.signal?.aborted) {
          limit = rt.signal?.aborted ? undefined : turn.limit;
          outcome = limit ? 'limited' : rt.signal?.aborted || !turn.error ? 'cancelled' : 'interrupted';
          reason = limit ? `Worker ${limit === 'timeout' ? 'time' : limit === 'turns' ? 'turn' : 'cost'} limit reached; retained the best verified checkpoint.`
            : turn.error ?? 'The workflow was cancelled.';
          recordCandidate({ round, attempt, file: draft ? rt.shown(ctx, draft) : undefined, verified: false, accepted: false, reason });
          restore(); finishRound(round, outcome); break roundLoop;
        }
        const source = read(file);
        if (source === best.source) {
          completed = round;
          reason = 'The round left the best verified source unchanged; no worthwhile improvement remains.';
          recordCandidate({ round, attempt, verified: true, accepted: false, reason, measurement: best.measurement });
          if (turn.reply) notes.push(turn.reply.slice(0, config().workflows.card.replyChars));
          finishRound(round, 'no further improvement'); break roundLoop;
        }
        execution.onProgress?.({ stage: 'checking', round, rounds, candidate: attempt });
        rt.status(ctx, `/compress ${theorem ?? shown} · round ${round}/${rounds} · Lean verification and heartbeats`);
        const verdict: CompressionVerdict = execution.evaluate
          ? await execution.evaluate(source ?? '', best.measurement) : await checkCompressedFile(environment, baseline, best.measurement);
        if (rt.signal?.aborted || ['timeout', 'unavailable'].includes(String(verdict.details.outcome))) {
          outcome = rt.signal?.aborted ? 'cancelled' : String(verdict.details.outcome);
          recordCandidate({ round, attempt, file: draft ? rt.shown(ctx, draft) : undefined, verified: !!verdict.verified,
            accepted: false, reason: verdict.summary, measurement: verdict.measurement });
          reason = verdict.summary; restore(); finishRound(round, outcome); break roundLoop;
        }
        if (verdict.verified && verdict.measurement && verdict.source !== undefined) {
          if (read(file) !== verdict.source || sourceHash(verdict.source) !== verdict.measurement.sourceHash) {
            outcome = 'interrupted'; reason = 'The file changed during verification; the current draft was preserved.';
            const current = read(file);
            if (current !== undefined) { kept = join(dir, `round-${round}-attempt-${attempt}-changed.lean`); writeFileSync(kept, current, 'utf8'); }
            recordCandidate({ round, attempt, file: kept ? rt.shown(ctx, kept) : undefined, verified: false, accepted: false, reason });
            restore(); finishRound(round, outcome); break roundLoop;
          }
          const verifiedPath = draft ?? join(dir, `round-${round}-attempt-${attempt}.lean`);
          writeFileSync(verifiedPath, verdict.source, 'utf8');
          recordCandidate({ round, attempt, file: rt.shown(ctx, verifiedPath), verified: true,
            accepted: verdict.ok, reason: verdict.ok ? 'Verified improvement accepted.' : verdict.diagnostics || verdict.summary, measurement: verdict.measurement });
          const candidate: Candidate = { round, file: verifiedPath, source: verdict.source, measurement: verdict.measurement,
            checkDurationMs: Number(verdict.details.checkDurationMs) };
          if (!frontier.some(entry => entry.measurement.sourceHash === candidate.measurement.sourceHash || dominates(entry.measurement, candidate.measurement, scoreWeights))) {
            frontier = [...frontier.filter(entry => !dominates(candidate.measurement, entry.measurement, scoreWeights)), candidate];
          }
          completed = round;
          if (!verdict.ok) { reason = verdict.summary; restore(); finishRound(round, 'no further improvement'); break roundLoop; }
          best = candidate;
          improved += 1;
          outcome = 'verified';
          reason = `Accepted round ${round}; ${round === rounds ? 'requested round limit reached.' : 'replan from the new verified proof.'}`;
          if (turn.reply) notes.push(turn.reply.slice(0, config().workflows.card.replyChars));
          finishRound(round, 'improved');
          writeReport();
          break; // A new round re-reads and replans from this accepted checkpoint.
        }
        recordCandidate({ round, attempt, file: draft ? rt.shown(ctx, draft) : undefined, verified: false, accepted: false, reason: verdict.diagnostics || verdict.summary });
        diagnostics = `${verdict.diagnostics}\n\nThe rejected draft was saved; ${shown} has been restored to the best verified checkpoint. Replan from that file.`;
        restore();
        writeReport();
        if (attempt === prompt.settings.maxAttempts) {
          completed = round; reason = `No valid improvement after ${attempt} attempt(s) in round ${round}. ${verdict.summary}`;
          finishRound(round, 'no valid improvement'); break roundLoop;
        }
      }
    }
  } catch (error) {
    outcome = 'interrupted'; reason = error instanceof Error ? error.message : String(error);
    saveDraft(activeRound, activeAttempt); restore();
    if (!roundSummaries.some(round => round.round === activeRound)) finishRound(activeRound, outcome);
  }
  const interrupted = ['cancelled', 'interrupted', 'timeout', 'unavailable'].includes(outcome);
  if (!interrupted && !limit) outcome = improved ? 'verified' : 'not_improved';
  writeReport();
  const metrics = compressionMetrics(baseline.measurement, best.measurement, scoreWeights);
  const details = { ...compressionDetails(baseline), ...metrics, verification, outcome, limit, roundsRequested: rounds, roundsCompleted: completed,
    roundsImproved: improved, declarationMetrics: best.measurement.declarations, versionsPassed: best.measurement.versionsPassed,
    dependencies: best.measurement.dependencies, paretoCandidates: frontierDetails(), reportPath: rt.shown(ctx, reportPath),
    checkDurationMs: best.checkDurationMs, roundSummaries,
    candidateScores: attempts.map(({ round, attempt, verified, accepted, compress_score }) => ({ round, attempt, verified, accepted, compress_score })) };
  const heading = limit ? `limit reached · kept verified ${improved ? 'improvement' : 'baseline'}`
    : interrupted ? `${outcome}${improved ? ' · kept verified improvement' : ''}` : improved ? 'improved and verified' : 'no worthwhile improvement';
  rt.card(`/compress · ${heading}`, [
    `Target: ${shown} · ${theorem ?? 'whole-file'} · ${label(environment)}`,
    `Rounds: ${rounds} requested / ${completed} completed; ${improved} improved.`,
    compressionMetricsText(metrics),
    `Compatibility: ${best.measurement.versionsPassed.join('; ')}.`,
    reason.slice(0, config().workflows.card.diagnosticsChars),
    improved ? 'The best verified result is kept in the target file.' : 'The original verified file is retained.',
    notes.length && `Transformations (agent):\n${notes.join('\n')}` || undefined,
    kept && `Candidate snapshots and measurements: ${rt.shown(ctx, dir)}.`,
    `Report: ${rt.shown(ctx, reportPath)}.`, rt.promptNote(ctx, prompt),
  ], { ok: improved > 0, ...(interrupted ? { tone: 'warning' as const } : {}), ...details });
  return { improved: improved > 0, interrupted, details, reportPath, source: best.source, measurement: best.measurement, reason };
}
