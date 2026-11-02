import { config } from '@theoria/shared/config';
import { appendRunEvent } from '@theoria/shared/events';
import { readInventory, refreshInventory } from '@theoria/pi-workflows/api';
import { artifactChanged, artifactFile, getArtifact, type Artifact } from './artifacts.ts';
import { noteInRun } from './runs.ts';
import { readColumns } from './data.ts';
import { binomialTest, oneSampleT, pairedT, sigmaOf, welchT, type TestResult } from './statistics.ts';
import { appendJsonl, nextId, now, projectId, readJsonl, researchPath, sha256, withLock } from './store.ts';

/**
 * Claims: statements the project's research makes, at the project level, so later runs build on them. Every change
 * is a new version in `research.claimsFile`; a claim's current state is its last version.
 *
 * `verified` is never set by the agent or by a person, only by Theoria, in one of two ways:
 * - formal (`verifyClaim`): a linked Lean artifact, at its current content, has the named theorem proved (no `sorry`,
 *   the standard axioms) as Lean's theorem inventory reports it;
 * - statistical (`testClaim`): Theoria's own test on the raw values of a linked data artifact reaches
 *   `research.statistical.sigma`, after correcting for every test tried on the claim. Evidence, not proof.
 * When the linked file changes the claim goes back to `supported`, marked stale, until it is checked again.
 */

export const relations = ['supports', 'refutes', 'verifies', 'derived-from'] as const;
export type Relation = (typeof relations)[number];
/** A link to an artifact. A `verifies` link names either a Lean theorem (formal) or a statistical test (statistical). */
export interface ArtifactRelation { artifactId: string; relation: Relation; theorem?: string; test?: string }

export type ClaimStatus = 'hypothesis' | 'supported' | 'verified' | 'refuted';
/** What the agent or a person may set. */
export const settableStatuses = ['hypothesis', 'supported', 'refuted'] as const;

/**
 * How a claim was verified, by Theoria. formal: Lean proved the theorem. statistical: Theoria's own test on the data
 * reached the configured significance after correcting for every test tried on the claim.
 */
export type Verification = { artifactId: string; contentHash: string; checkedAt: string; stale?: boolean } & (
  | { kind: 'formal'; theorem: string }
  | { kind: 'statistical'; test: string; method: string; pValue: number; adjustedP: number; sigma: number; threshold: number; attempts: number; correction: string; n: number[]; effect: number; detail: string }
);

export interface Claim {
  id: string;
  projectId: string;
  version: number;
  statement: string;
  status: ClaimStatus;
  artifactRefs: ArtifactRelation[];
  verification?: Verification;
  createdByRunId?: string;
  lastUpdatedByRunId?: string;
  /** Who made this version: you, the agent, or Theoria's own check. */
  by: 'user' | 'model' | 'theoria';
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export const testUsage = 'mean <col> >|< <mu0> · welch <colA> >|< <colB> · paired <colA> >|< <colB> · binomial <col> >|< <p0>';

/** A test spec as typed: `welch treatment > control`. */
export function parseTest(spec: string): { method: 'mean' | 'welch' | 'paired' | 'binomial'; a: string; direction: 'greater' | 'less'; b: string } {
  const match = /^(mean|welch|paired|binomial)\s+(\S+)\s*(>|<)\s*(\S+)$/.exec(spec.trim());
  if (!match) throw new Error(`A test is one of: ${testUsage}.`);
  return { method: match[1] as 'mean' | 'welch' | 'paired' | 'binomial', a: match[2]!, direction: match[3] === '>' ? 'greater' : 'less', b: match[4]! };
}

const claimsPath = (cwd: string) => researchPath(cwd, config().research.claimsFile);

/** Every version, oldest first. */
const versions = (cwd: string) => readJsonl<Claim>(claimsPath(cwd));

export function listClaims(cwd: string): Claim[] {
  const latest = new Map<string, Claim>();
  for (const claim of versions(cwd)) latest.set(claim.id, claim);
  return [...latest.values()].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
}

export const getClaim = (cwd: string, id: string) => listClaims(cwd).find(claim => claim.id === id.toUpperCase());
export const claimHistory = (cwd: string, id: string) => versions(cwd).filter(claim => claim.id === id.toUpperCase());

function write(cwd: string, claim: Claim, runId: string | undefined, type: string) {
  appendJsonl(claimsPath(cwd), claim);
  if (runId) appendRunEvent(cwd, runId, type, { id: claim.id, version: claim.version, status: claim.status, by: claim.by }, claim.projectId);
}

export function createClaim(cwd: string, input: { statement: string; status?: (typeof settableStatuses)[number]; runId?: string; by: 'user' | 'model'; refs?: ArtifactRelation[] }): Claim {
  const statement = input.statement.trim();
  if (!statement) throw new Error('A claim needs a statement.');
  const created = withLock(cwd, () => {
    const at = now();
    const claim: Claim = {
      id: nextId('C', listClaims(cwd).map(entry => entry.id)), projectId: projectId(cwd), version: 1, statement,
      status: input.status ?? 'hypothesis', artifactRefs: input.refs ?? [], ...(input.runId ? { createdByRunId: input.runId, lastUpdatedByRunId: input.runId } : {}),
      by: input.by, createdAt: at, updatedAt: at,
    };
    write(cwd, claim, input.runId, 'claim.created');
    return claim;
  });
  noteInRun(cwd, input.runId, 'createdClaimIds', created.id);
  return created;
}

/** A new version of a claim. `status` may not be `verified`: only `verifyClaim` sets it. */
export function updateClaim(cwd: string, id: string, change: { statement?: string; status?: (typeof settableStatuses)[number]; addRef?: ArtifactRelation; note?: string }, who: { runId?: string; by: Claim['by'] }): Claim {
  if ((change.status as string) === 'verified') throw new Error('Only Lean verifies a claim: link a Lean file with `verifies <artifact> <theorem>`.');
  const updated = withLock(cwd, () => {
    const current = getClaim(cwd, id);
    if (!current) throw new Error(`No claim ${id}.`);
    const next: Claim = { ...structuredClone(current), version: current.version + 1, by: who.by, updatedAt: now() };
    delete next.note;
    if (who.runId) next.lastUpdatedByRunId = who.runId;
    if (change.statement?.trim()) {
      next.statement = change.statement.trim();
      // A different statement is not what Lean verified.
      if (next.status === 'verified') { next.status = 'supported'; next.verification = { ...next.verification!, stale: true }; }
    }
    if (change.status) {
      next.status = change.status;
      if (next.verification) next.verification = { ...next.verification, stale: true };
    }
    if (change.addRef && !next.artifactRefs.some(ref => ref.artifactId === change.addRef!.artifactId && ref.relation === change.addRef!.relation && ref.theorem === change.addRef!.theorem)) {
      next.artifactRefs.push(change.addRef);
    }
    if (change.note) next.note = change.note;
    write(cwd, next, who.runId, 'claim.updated');
    return next;
  });
  noteInRun(cwd, who.runId, 'touchedClaimIds', updated.id);
  return updated;
}

export interface VerifyResult { verified: boolean; reason: string; claim: Claim }

/**
 * Asks Lean whether the claim's `verifies` link holds: the file is checked (the inventory, from its cache when the
 * file did not change), and the theorem must be in it and proved. Only then is the claim `verified`.
 */
export async function verifyClaim(cwd: string, id: string, runId?: string): Promise<VerifyResult> {
  const claim = getClaim(cwd, id);
  if (!claim) throw new Error(`No claim ${id}.`);
  const links = claim.artifactRefs.filter(ref => ref.relation === 'verifies' && ref.theorem);
  if (!links.length) {
    const tests = claim.artifactRefs.filter(ref => ref.relation === 'verifies' && ref.test);
    if (tests.length) { const last = tests.at(-1)!; return testClaim(cwd, id, last.artifactId, last.test!, runId); }
    return { verified: false, reason: 'it has no `verifies` link to a Lean theorem or a statistical test', claim };
  }
  const inventory = await refreshInventory(cwd);
  if (inventory.problems.length && !inventory.theorems.length) return { verified: false, reason: `Lean could not check the project: ${inventory.problems[0]}`, claim };
  const reasons: string[] = [];
  for (const link of links) {
    const artifact = getArtifact(cwd, link.artifactId);
    if (!artifact) { reasons.push(`${link.artifactId} is not an artifact`); continue; }
    if (!artifact.path.endsWith('.lean')) { reasons.push(`${artifact.path} is not a Lean file`); continue; }
    if (artifactChanged(cwd, artifact)) { reasons.push(`${artifact.path} changed since ${artifact.id} was registered; register it again and link the new version`); continue; }
    const theorem = inventory.theorems.find(entry => entry.file === artifact.path && (entry.name === link.theorem || entry.name.endsWith(`.${link.theorem}`)));
    if (!theorem) { reasons.push(`Lean found no theorem ${link.theorem} in ${artifact.path}`); continue; }
    if (theorem.statementError || theorem.proof !== 'proved') { reasons.push(`Lean: ${theorem.name} is ${theorem.statementError ? 'not well-formed' : theorem.proof} (${theorem.reason ?? 'not proved'})`); continue; }
    const verified = withLock(cwd, () => {
      const current = getClaim(cwd, id)!;
      const next: Claim = {
        ...current, version: current.version + 1, status: 'verified', by: 'theoria', updatedAt: now(),
        verification: { kind: 'formal', artifactId: artifact.id, theorem: theorem.name, contentHash: sha256(artifactFile(cwd, artifact)) ?? '', checkedAt: now() },
        ...(runId ? { lastUpdatedByRunId: runId } : {}),
      };
      delete next.note;
      write(cwd, next, runId, 'claim.verified');
      return next;
    });
    return { verified: true, reason: `Lean: ${theorem.name} in ${artifact.path} is proved with the standard axioms`, claim: verified };
  }
  return { verified: false, reason: reasons.join('; '), claim };
}

/**
 * Claims whose verified file changed go back to `supported`, marked stale. Cheap (hashes only); run before showing
 * claims. Returns the claims that changed.
 */
export function recheckClaims(cwd: string): Claim[] {
  const changed: Claim[] = [];
  for (const claim of listClaims(cwd)) {
    if (claim.status !== 'verified' || !claim.verification) continue;
    const artifact = getArtifact(cwd, claim.verification.artifactId);
    const hash = artifact ? sha256(artifactFile(cwd, artifact)) : undefined;
    if (hash === claim.verification.contentHash) continue;
    const next = withLock(cwd, () => {
      const current = getClaim(cwd, claim.id)!;
      const version: Claim = { ...current, version: current.version + 1, status: 'supported', by: 'theoria', updatedAt: now(), verification: { ...current.verification!, stale: true }, note: 'the verified Lean file changed' };
      write(cwd, version, undefined, 'claim.updated');
      return version;
    });
    changed.push(next);
  }
  return changed;
}

/** Claims linked to a theorem in a file, for re-verification after a workflow changed it. */
export function claimsLinkedTo(cwd: string, file: string): Claim[] {
  return listClaims(cwd).filter(claim => claim.artifactRefs.some(ref => ref.relation === 'verifies' && getArtifact(cwd, ref.artifactId)?.path === file));
}

/** The status as shown: verified only with a current verification; stale and the agent's judgement are said. */
export function statusLabel(claim: Claim): string {
  if (claim.status === 'verified' && claim.verification?.kind === 'statistical') {
    const v = claim.verification;
    return `verified (statistical, ${v.sigma.toFixed(1)}σ ≥ ${v.threshold}σ, ${v.method}${v.attempts > 1 && v.correction !== 'none' ? `, ${v.correction} ×${v.attempts}` : ''})`;
  }
  if (claim.status === 'verified') return 'verified (Lean)';
  if (claim.verification?.stale && claim.status === 'supported') return 'supported (verification stale)';
  if (claim.status === 'refuted') return claim.artifactRefs.some(ref => ref.relation === 'refutes') ? 'refuted (linked evidence)' : 'refuted (judgement, not checked)';
  return claim.status;
}

export const claimLine = (claim: Claim) => `${claim.id} [${statusLabel(claim)}] ${claim.statement.split('\n')[0]!.slice(0, 110)}${claim.createdByRunId ? ` · ${claim.createdByRunId}` : ''}`;

export function claimDetail(cwd: string, claim: Claim): string[] {
  const artifacts = claim.artifactRefs.map(ref => {
    const artifact: Artifact | undefined = getArtifact(cwd, ref.artifactId);
    return `  ${ref.relation} ${ref.artifactId}${artifact ? ` ${artifact.path}` : ' (missing)'}${ref.theorem ? ` : ${ref.theorem}` : ''}${ref.test ? ` · test ${ref.test}` : ''}`;
  });
  const history = claimHistory(cwd, claim.id).map(version => `  v${version.version} ${version.status} by ${version.by}${version.lastUpdatedByRunId ? ` in ${version.lastUpdatedByRunId}` : ''} · ${version.updatedAt.slice(0, 16).replace('T', ' ')}${version.note ? ` · ${version.note}` : ''}`);
  return [
    `${claim.id} [${statusLabel(claim)}]`,
    claim.statement,
    ...(claim.verification && claim.status === 'verified' && claim.verification.kind === 'formal' ? [`Verified by Lean: ${claim.verification.theorem}, checked ${claim.verification.checkedAt.slice(0, 16).replace('T', ' ')}`] : []),
    ...(claim.verification && claim.status === 'verified' && claim.verification.kind === 'statistical' ? [
      `Verified statistically by Theoria: ${claim.verification.method} on ${claim.verification.test}: ${claim.verification.detail}; p = ${claim.verification.pValue.toExponential(2)}${claim.verification.adjustedP !== claim.verification.pValue ? `, ${claim.verification.correction}-corrected ${claim.verification.adjustedP.toExponential(2)}` : ''} (${claim.verification.sigma.toFixed(2)}σ).`,
      'Evidence, not proof: it holds under the test\'s assumptions and as far as the data was produced as recorded.',
    ] : []),
    ...(artifacts.length ? ['Links', ...artifacts] : ['Links: none']),
    'History', ...history,
  ];
}

/**
 * Statistical verification: Theoria runs the test on the data artifact's raw values and the claim is `verified`
 * (statistical) when the one-sided result, corrected for every test tried on this claim, reaches
 * `research.statistical.sigma`. Every attempt is a new version of the claim, so the attempts are counted and seen.
 */
export async function testClaim(cwd: string, id: string, artifactId: string, spec: string, runId?: string): Promise<VerifyResult> {
  const settings = config().research.statistical;
  const claim = getClaim(cwd, id);
  if (!claim) throw new Error(`No claim ${id}.`);
  const artifact = getArtifact(cwd, artifactId);
  if (!artifact) return { verified: false, reason: `${artifactId} is not an artifact`, claim };
  if (artifactChanged(cwd, artifact)) return { verified: false, reason: `${artifact.path} changed since ${artifact.id} was registered; register it again and test the new version`, claim };
  let test: ReturnType<typeof parseTest>;
  let result: TestResult;
  try {
    test = parseTest(spec);
    const columns = readColumns(artifactFile(cwd, artifact));
    const column = (name: string) => { const values = columns[name]; if (!values) throw new Error(`${artifact.path} has no column ${name} (it has ${Object.keys(columns).join(', ') || 'none'})`); return values; };
    const a = column(test.a);
    const b = test.method === 'welch' || test.method === 'paired' ? column(test.b) : undefined;
    const small = [a, ...(b ? [b] : [])].find(values => values.length < settings.minSamples);
    if (small) throw new Error(`a group has ${small.length} values, fewer than research.statistical.minSamples (${settings.minSamples})`);
    const threshold = Number(test.b);
    if (!b && !Number.isFinite(threshold)) throw new Error(`${test.b} is not a number to compare with`);
    result = test.method === 'mean' ? oneSampleT(a, threshold, test.direction)
      : test.method === 'binomial' ? binomialTest(a, threshold, test.direction)
        : test.method === 'welch' ? welchT(a, b!, test.direction) : pairedT(a, b!, test.direction);
  } catch (error) {
    return { verified: false, reason: error instanceof Error ? error.message : String(error), claim };
  }
  const attempts = claimHistory(cwd, id).filter(version => version.note?.startsWith('statistical test')).length + 1;
  const adjustedP = settings.correction === 'bonferroni' ? Math.min(1, result.pValue * attempts) : result.pValue;
  const sigma = sigmaOf(adjustedP);
  const passed = sigma >= settings.sigma;
  const summary = `${result.test} on ${artifact.path} (${spec}): ${result.detail}; p = ${result.pValue.toExponential(2)}${adjustedP !== result.pValue ? `, ${settings.correction} ×${attempts} → ${adjustedP.toExponential(2)}` : ''}, ${Number.isFinite(sigma) ? sigma.toFixed(2) : '∞'}σ`;
  const updated = withLock(cwd, () => {
    const current = getClaim(cwd, id)!;
    const refs = current.artifactRefs.some(ref => ref.artifactId === artifact.id && ref.relation === 'verifies' && ref.test === spec)
      ? current.artifactRefs : [...current.artifactRefs, { artifactId: artifact.id, relation: 'verifies' as const, test: spec }];
    const next: Claim = {
      ...current, version: current.version + 1, by: 'theoria', updatedAt: now(), artifactRefs: refs,
      note: `statistical test ${attempts}: ${summary}${passed ? '' : ` (below ${settings.sigma}σ)`}`,
      ...(runId ? { lastUpdatedByRunId: runId } : {}),
      ...(passed ? {
        status: 'verified' as const,
        verification: {
          kind: 'statistical' as const, artifactId: artifact.id, contentHash: artifact.contentHash ?? '', checkedAt: now(), test: spec, method: result.test,
          pValue: result.pValue, adjustedP, sigma, threshold: settings.sigma, attempts, correction: settings.correction, n: result.n, effect: result.effect, detail: result.detail,
        },
      } : {}),
    };
    write(cwd, next, runId, passed ? 'claim.verified' : 'claim.tested');
    return next;
  });
  return { verified: passed, reason: summary, claim: updated };
}
