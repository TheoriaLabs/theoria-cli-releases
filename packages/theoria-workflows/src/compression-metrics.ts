import { createHash } from 'node:crypto';
import { config } from '@theoria/shared/config';
import type { HeartbeatReport } from '@theoria/pi-lean/api';
import { blank, declarations, isTheorem, significantLines } from './lean-source.ts';
import { proofTokens, type ProofTokenizer } from './compression-tokens.ts';

/** Optional fields keep frozen two-axis policies readable without changing their scores. */
export interface ScoreWeights { loc: number; heartbeats: number; tokens?: number; compatibility?: number }
export interface CompressionPolicy {
  minImprovementPercent: number; maxHeartbeatRegressionPercent: number; scoreWeights: ScoreWeights;
  tokenizer?: string; compatibilityProjects?: string[];
}

export interface CompressionMeasurement {
  sourceHash: string;
  lines: number;
  heartbeats: number;
  tokens?: number;
  tokenizer?: string;
  declarations: { name: string; lines: number; heartbeats?: number; sharedCommand?: boolean }[];
  versionsPassed: string[];
  /** Fixed denominator, including failed checks; absent in historical measurements. */
  versionsChecked?: string[];
  dependencies: string[];
}

export const sourceHash = (source: string) => createHash('sha256').update(source).digest('hex');
export const reduction = (before: number, after: number) => before > 0 ? 100 * (before - after) / before : after === 0 ? 0 : -100;

export function measurement(source: string, profile: HeartbeatReport, environment: string,
  policy: CompressionPolicy = config().workflows.compression, original = source): CompressionMeasurement {
  const proofs = declarations(source).filter(entry => isTheorem(entry) || entry.kind === 'example');
  const lineAt = (offset: number) => source.slice(0, offset).split('\n').length;
  let example = 0;
  const metrics = proofs.map(entry => {
    const line = lineAt(entry.start);
    const headerEnd = lineAt(entry.bodyAt);
    const command = profile.commands.find(row => row.line <= headerEnd && row.endLine >= line);
    const shared = command && proofs.filter(proof => lineAt(proof.start) >= command.line && lineAt(proof.start) <= command.endLine).length > 1;
    return { name: entry.kind === 'example' ? `example ${++example}` : entry.name, lines: significantLines(entry.text),
      ...(command ? { heartbeats: command.heartbeats, ...(shared ? { sharedCommand: true } : {}) } : {}) };
  });
  const imports = [...blank(source).matchAll(/^\s*(?:public\s+)?(?:meta\s+)?import\s+([^\n]+)/gm)]
    .flatMap(match => match[1]!.trim().split(/\s+/)).filter(name => name !== 'all');
  return { sourceHash: sourceHash(source), lines: significantLines(source), heartbeats: profile.total, declarations: metrics,
    ...(policy.tokenizer ? { tokens: proofTokens(source, policy.tokenizer as ProofTokenizer, original), tokenizer: policy.tokenizer } : {}),
    versionsPassed: [environment], versionsChecked: [environment], dependencies: [...new Set(imports)] };
}

export const compatibilityPercent = (value: Pick<CompressionMeasurement, 'versionsChecked' | 'versionsPassed'>): number => {
  const checked = [...new Set(value.versionsChecked ?? [])];
  return checked.length ? 100 * checked.filter(version => value.versionsPassed.includes(version)).length / checked.length : 0;
};

function tokenReduction(original: CompressionMeasurement, candidate: CompressionMeasurement): number {
  if (original.tokens === undefined || candidate.tokens === undefined || !original.tokenizer || original.tokenizer !== candidate.tokenizer)
    throw new Error('Token objective requires baseline and candidate counts from the same recorded tokenizer.');
  return original.tokens > 0 ? 100 * (original.tokens - candidate.tokens) / original.tokens : 0;
}

export function scoreComponents(original: CompressionMeasurement, candidate: CompressionMeasurement,
  weights: ScoreWeights = config().workflows.compression.scoreWeights) {
  return {
    loc: weights.loc ? weights.loc * reduction(original.lines, candidate.lines) : 0,
    tokens: weights.tokens ? weights.tokens * tokenReduction(original, candidate) : 0,
    heartbeats: weights.heartbeats ? weights.heartbeats * (original.heartbeats > 0 ? reduction(original.heartbeats, candidate.heartbeats) : 0) : 0,
    compatibility: (weights.compatibility ?? 0) * compatibilityPercent(candidate),
  };
}

export const compressionScore = (original: CompressionMeasurement, candidate: CompressionMeasurement,
  weights: ScoreWeights = config().workflows.compression.scoreWeights) => Object.values(scoreComponents(original, candidate, weights)).reduce((sum, value) => sum + value, 0);

export function compressionMetrics(original: CompressionMeasurement, candidate: CompressionMeasurement,
  scoreWeights: ScoreWeights = config().workflows.compression.scoreWeights) {
  const { lines: baselineLines, heartbeats: baselineHeartbeats } = original;
  const { lines, heartbeats } = candidate;
  const linesSaved = baselineLines - lines;
  return { baselineLines, lines, linesSaved, reductionPercent: reduction(baselineLines, lines),
    baselineHeartbeats, heartbeats, heartbeatsSaved: baselineHeartbeats - heartbeats,
    heartbeatReductionPercent: baselineHeartbeats > 0 ? reduction(baselineHeartbeats, heartbeats) : 0,
    ...(original.tokens !== undefined && candidate.tokens !== undefined ? { baselineTokens: original.tokens, tokens: candidate.tokens,
      tokensSaved: original.tokens - candidate.tokens, tokenReductionPercent: tokenReduction(original, candidate), tokenizer: candidate.tokenizer } : {}),
    versionsChecked: candidate.versionsChecked, versionsPassed: candidate.versionsPassed, compatibilityPercent: compatibilityPercent(candidate),
    scoreWeights, scoreComponents: scoreComponents(original, candidate, scoreWeights), compress_score: compressionScore(original, candidate, scoreWeights) };
}

const change = (percent: number) => `${Math.abs(percent) > 0 && Math.abs(percent) < 0.1 ? '<0.1' : Math.abs(percent).toFixed(1)}% ${percent < 0 ? 'increase' : 'reduction'}`;

/** The same measured reduction in the verdict card and the agent-facing action result. */
export function compressionMetricsText(value: { baselineLines?: number; lines?: number; baselineHeartbeats?: number; heartbeats?: number; compress_score?: number;
  baselineTokens?: number; tokens?: number; tokenReductionPercent?: number; tokenizer?: string; compatibilityPercent?: number; versionsChecked?: string[] }): string {
  if (value.baselineLines === undefined || value.lines === undefined) return '';
  const { baselineLines, lines } = value;
  const linesSaved = baselineLines - lines;
  const reductionPercent = reduction(baselineLines, lines);
  const loc = `${baselineLines} → ${lines} significant LOC · ${Math.abs(linesSaved)} lines ${linesSaved < 0 ? 'added' : 'saved'} · ${change(reductionPercent)}`;
  let metrics = value.baselineTokens === undefined || value.tokens === undefined ? loc
    : `${value.baselineTokens} → ${value.tokens} proof tokens (${value.tokenizer}; ${change(value.tokenReductionPercent ?? 0)}) · ${loc}`;
  metrics = value.baselineHeartbeats === undefined || value.heartbeats === undefined ? metrics
    : `${metrics} · ${value.baselineHeartbeats.toFixed(3)} → ${value.heartbeats.toFixed(3)} heartbeats (${change(value.baselineHeartbeats > 0 ? reduction(value.baselineHeartbeats, value.heartbeats) : 0)})`;
  if (value.versionsChecked?.length) metrics += ` · compatibility: ${value.compatibilityPercent?.toFixed(1)}% (${value.versionsChecked.length} checked)`;
  return value.compress_score === undefined ? metrics : `${metrics} · compress_score: ${value.compress_score.toFixed(2)}%`;
}

export function dominates(a: CompressionMeasurement, b: CompressionMeasurement, weights: ScoreWeights = config().workflows.compression.scoreWeights): boolean {
  const axes: [number, number][] = [];
  if (weights.loc) axes.push([a.lines, b.lines]);
  if (weights.tokens) {
    tokenReduction(a, b); // Reject incomparable encodings or missing counts.
    axes.push([a.tokens!, b.tokens!]);
  }
  if (weights.heartbeats) axes.push([a.heartbeats, b.heartbeats]);
  if (weights.compatibility) axes.push([-compatibilityPercent(a), -compatibilityPercent(b)]);
  return axes.every(([left, right]) => left <= right) && axes.some(([left, right]) => left < right);
}

/** Quantitative selection is independent of the agent's claims; robustness is also enforced by the proof gate. */
export function selectCandidate(original: CompressionMeasurement, best: CompressionMeasurement, candidate: CompressionMeasurement,
  settings: CompressionPolicy = config().workflows.compression) {
  const score = (value: CompressionMeasurement) => compressionScore(original, value, settings.scoreWeights);
  if (candidate.sourceHash === best.sourceHash) return { accepted: false, reason: 'The source is unchanged; it is not shorter or lower-heartbeat.', score: score(candidate) };
  if (candidate.heartbeats > Math.min(original.heartbeats, best.heartbeats) * (1 + settings.maxHeartbeatRegressionPercent / 100)) {
    return { accepted: false, reason: `Heartbeat regression exceeds ${settings.maxHeartbeatRegressionPercent}%; retain the best verified proof.`, score: score(candidate) };
  }
  if (dominates(best, candidate, settings.scoreWeights) || score(candidate) - score(best) < settings.minImprovementPercent) {
    return { accepted: false, reason: `No worthwhile objective improvement (minimum score gain ${settings.minImprovementPercent} percentage points).`, score: score(candidate) };
  }
  return { accepted: true, reason: 'Verified objective improvement.', score: score(candidate) };
}
