import { randomUUID } from 'node:crypto';
import { check, formatCheck, label, resolve as resolveEnvironment, type CheckResult, type Environment, type LeanDeclaration } from '@theoria/pi-lean/api';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { read, standardAxioms, type Verdict } from './gate.ts';
import { blank, declarations, isTheorem, significantLines } from './lean-source.ts';
import { compressionMetrics, compressionMetricsText, measurement, selectCandidate, sourceHash, type CompressionMeasurement, type CompressionPolicy } from './compression-metrics.ts';
import { config, expandHome } from '@theoria/shared/config';
import { baselineCache, readBaselineCache, writeBaselineCache } from './compression-baseline-cache.ts';

export interface CompressionInput {
  cwd: string;
  file: string;
  before: string;
  /** Omitted for a whole-file target. */
  theorem?: string;
  allowedAxioms: string[];
  timeoutSeconds: number;
  signal?: AbortSignal;
  policy?: CompressionPolicy;
  /** Reuse a matching measured baseline instead of checking the original again. */
  skipVerification?: boolean;
  /** Host-only cache location and pinned environment identity for benchmark workspaces. */
  cacheRoot?: string;
  cacheIdentity?: string;
}

export interface CompressionBaseline {
  input: CompressionInput;
  examplePrefix: string;
  declarations: LeanDeclaration[];
  protected: LeanDeclaration[];
  targets: LeanDeclaration[];
  lines: number;
  measurement: CompressionMeasurement;
  policy: CompressionPolicy;
  compatibilityTargets: { id: string; environment: Environment }[];
  cacheHit?: boolean;
}

const generated = (entry: LeanDeclaration) => entry.userName.split('.').some(part => part.startsWith('_'));
const display = (entry: LeanDeclaration, prefix: string) => entry.userName.includes(prefix)
  ? `example ${Number(entry.userName.split(prefix)[1]) + 1}` : entry.userName;

export const compressionDetails = (baseline: CompressionBaseline) => ({
  scope: baseline.input.theorem ? 'theorem' : 'file',
  ...(baseline.input.theorem ? { theorem: baseline.input.theorem } : {}),
  theorems: baseline.targets.map(entry => display(entry, baseline.examplePrefix)),
  targetCount: baseline.targets.length,
  baselineLines: baseline.lines,
  baselineHeartbeats: baseline.measurement.heartbeats,
  baselineTokens: baseline.measurement.tokens,
  tokenizer: baseline.measurement.tokenizer,
  baselineDeclarations: baseline.measurement.declarations,
  versionsPassed: baseline.measurement.versionsPassed,
  versionsChecked: baseline.measurement.versionsChecked,
  dependencies: baseline.measurement.dependencies,
  skipVerification: !!baseline.input.skipVerification,
  baselineCacheHit: !!baseline.cacheHit,
});

/** Examples disappear from Lean's environment. Name only the verification copy so their types/axioms are visible. */
function instrumentExamples(source: string, prefix: string): string {
  const examples = declarations(source).filter(entry => entry.kind === 'example');
  const masked = blank(source).replace(/«[^»]*»/g, name => ' '.repeat(name.length));
  // Refuse layouts the source scanner cannot track rather than overlooking an anonymous proof.
  if ([...masked.matchAll(/\bexample\b/g)].length !== examples.length) throw new Error('Unsupported example layout: place each anonymous example in its own top-level command.');
  let copy = source;
  for (let index = examples.length - 1; index >= 0; index -= 1) {
    const entry = examples[index]!;
    const keyword = /\bexample\b/.exec(masked.slice(entry.start, entry.bodyAt));
    if (!keyword) throw new Error('Could not locate an anonymous example for verification.');
    const at = entry.start + keyword.index;
    copy = `${copy.slice(0, at)}noncomputable def ${prefix}${index}${copy.slice(at + 'example'.length)}`;
  }
  return copy;
}

function failed(summary: string, details: Record<string, unknown> = {}, result?: CheckResult): Verdict {
  const outcome = result?.status === 'timeout' ? 'timeout' : result?.status === 'unavailable' ? 'unavailable' : details.outcome ?? 'rejected';
  return { ok: false, summary, diagnostics: result ? `${summary}\n\n${formatCheck(result)}` : summary, details: { ...details, outcome }, ...(result ? { check: result } : {}) };
}

async function inspect(environment: Environment, input: CompressionInput, source: string, prefix: string, inventory = true) {
  const code = inventory ? instrumentExamples(source, prefix) : source;
  return check(environment, { cwd: input.cwd, code, path: input.file, inspect: inventory, measureHeartbeats: true, heartbeatSource: source,
    timeoutSeconds: input.timeoutSeconds, signal: input.signal });
}

async function compatibilityTargets(environment: Environment, input: CompressionInput, policy: CompressionPolicy) {
  const targets: CompressionBaseline['compatibilityTargets'] = [];
  const roots = new Set(environment.projectRoot ? [realpathSync(environment.projectRoot)] : []);
  for (const project of policy.compatibilityProjects ?? []) {
    const root = realpathSync(resolve(input.cwd, expandHome(project)));
    if (roots.has(root)) throw new Error(`Duplicate compatibility project: ${root}`);
    roots.add(root);
    const extra = await resolveEnvironment(root);
    if (extra.source !== 'lean-project' || extra.problem || !extra.projectRoot || realpathSync(extra.projectRoot) !== root)
      throw new Error(`Compatibility project is not a ready Lake project: ${root}${extra.problem ? ` (${extra.problem})` : ''}`);
    targets.push({ id: `${label(extra)} [${root}]`, environment: extra });
  }
  return targets;
}

/** Extra versions affect only compatibility, never the primary verification gate or heartbeat denominator. */
async function measureCompatibility(environment: Environment, input: CompressionInput, source: string, prefix: string,
  targets: CompressionBaseline['compatibilityTargets'], measured: CompressionMeasurement): Promise<CompressionMeasurement> {
  const code = instrumentExamples(source, prefix);
  const theorems = declarations(code).filter(entry => isTheorem(entry) || entry.name.includes(prefix)).map(entry => entry.name);
  const permitted = new Set([...standardAxioms(), ...input.allowedAxioms]);
  for (const target of targets) {
    // Reuse the controller's sandbox and scratch root; an alternate snapshot must not escape isolation.
    const extra = { ...target.environment, sandboxProfile: environment.sandboxProfile, checkTmpDir: environment.checkTmpDir };
    const result = await check(extra, { cwd: input.cwd, code, theorems, timeoutSeconds: input.timeoutSeconds, signal: input.signal });
    if (input.signal?.aborted || result.status === 'unavailable' || result.status === 'timeout')
      throw new Error(`Compatibility check ${target.id}: ${result.detail}`);
    measured.versionsChecked!.push(target.id);
    if (result.status === 'ok' && !result.usesSorry && theorems.every(name => result.axioms[name]?.every(axiom => permitted.has(axiom))))
      measured.versionsPassed.push(target.id);
  }
  return measured;
}

function checkAxioms(result: CheckResult, input: CompressionInput, targets: LeanDeclaration[], previous: LeanDeclaration[]): string | undefined {
  const permitted = new Set([...standardAxioms(), ...input.allowedAxioms]);
  const targetNames = new Set(targets.map(entry => entry.name));
  const old = new Map(previous.map(entry => [entry.name, entry]));
  for (const entry of result.declarations!) {
    // An individual target can live beside unfinished proofs, but cannot introduce new gaps elsewhere to
    // manufacture a file-size reduction. New helpers and previously verified proofs still have to verify.
    const existing = input.theorem && !targetNames.has(entry.name) ? old.get(entry.name)?.axioms ?? [] : [];
    const refused = entry.axioms.filter(axiom => (axiom === 'sorryAx' || !permitted.has(axiom)) && !existing.includes(axiom));
    if (refused.length) return `${entry.userName} depends on ${refused.join(', ')}, which is not permitted.`;
  }
  if (!input.theorem && result.usesSorry) return 'The file contains an incomplete proof (sorry/admit).';
  return undefined;
}

function protectedDeclarations(entries: LeanDeclaration[], source: string, prefix: string) {
  const names = new Set(declarations(source).map(entry => entry.name));
  const proofs = entries.filter(entry => entry.proof).map(entry => `${entry.userName}.`);
  // User-written declarations stay protected; auxiliaries synthesized inside proofs do not.
  return entries.filter(entry => names.has(entry.userName) || entry.source || entry.userName.includes(prefix)
    || (!proofs.some(parent => entry.userName.startsWith(parent))
      && !generated(entry) && !entry.importedParent));
}

function proofTargets(entries: LeanDeclaration[], protectedEntries: LeanDeclaration[], input: CompressionInput, prefix: string) {
  return input.theorem ? entries.filter(entry => entry.userName === input.theorem && entry.proof)
    : protectedEntries.filter(entry => entry.kind === 'theorem' || (entry.proof && entry.userName.includes(prefix)));
}

/** Establish the trusted file/type snapshot once, before the agent is allowed to edit. */
export async function prepareCompression(environment: Environment, input: CompressionInput): Promise<{ verdict: Verdict; baseline?: CompressionBaseline }> {
  const started = Date.now();
  const settings = config().workflows.compression;
  const policy: CompressionPolicy = structuredClone(input.policy ?? settings);
  const details = { scope: input.theorem ? 'theorem' : 'file', environment: label(environment) };
  if (input.signal?.aborted) return { verdict: failed('Baseline preparation cancelled.', { ...details, outcome: 'cancelled' }) };
  let cache: ReturnType<typeof baselineCache> | undefined;
  try { cache = baselineCache(environment, input, policy); } catch { /* Caching is optional; verification still works. */ }
  const prefix = `TheoriaExample_${randomUUID().replaceAll('-', '')}_`;
  let result: CheckResult;
  let compatible: CompressionBaseline['compatibilityTargets'];
  try {
    compatible = await compatibilityTargets(environment, input, policy);
    const cached = input.skipVerification && cache ? readBaselineCache(cache) : undefined;
    if (cached && !environment.problem && environment.source !== 'none' && cached.measurement.sourceHash === sourceHash(input.before)) {
      const baseline: CompressionBaseline = { ...cached, input, policy, compatibilityTargets: compatible, cacheHit: true };
      return { baseline, verdict: { ok: true, summary: 'Reused a matching measured baseline; original verification skipped.', diagnostics: '',
        details: { ...details, ...compressionDetails(baseline), checkDurationMs: Date.now() - started } } };
    }
    result = await inspect(environment, input, input.before, prefix);
  }
  catch (error) { return { verdict: failed(String(error), { ...details, outcome: 'unavailable' }) }; }
  if (result.status !== 'ok' || !result.declarations || !result.heartbeats) return { verdict: failed(`The original could not be verified and measured: ${result.detail}`, details, result) };
  // Lean may lazily realize imported constants (e.g. congr_simp lemmas) in map₂. They are checked for axioms,
  // but are not declarations of this source and need not survive a change in tactics.
  const protectedEntries = protectedDeclarations(result.declarations, input.before, prefix);
  const targets = proofTargets(result.declarations, protectedEntries, input, prefix);
  if (!targets.length) return { verdict: failed(input.theorem ? `Lean did not resolve the theorem ${input.theorem}.` : 'The file has no theorem, lemma or proposition-valued example to compress.', details, result) };
  if (input.theorem && targets.length !== 1) return { verdict: failed(`The theorem ${input.theorem} resolves to several kernel declarations.`, details, result) };
  // Every source theorem must be accounted for, even if its elaborator generated an unexpected name.
  for (const entry of declarations(input.before).filter(isTheorem)) {
    if (!result.declarations.some(decl => decl.userName === entry.name && decl.kind === 'theorem')) return { verdict: failed(`Unsupported declaration mapping for ${entry.name}.`, details, result) };
  }
  const problem = checkAxioms(result, input, targets, result.declarations);
  if (problem) return { verdict: failed(problem, details, result) };
  let measured: CompressionMeasurement;
  try { measured = await measureCompatibility(environment, input, input.before, prefix, compatible,
    measurement(input.before, result.heartbeats, label(environment), policy)); }
  catch (error) { return { verdict: failed(String(error), { ...details, outcome: 'unavailable' }) }; }
  const baseline: CompressionBaseline = { input, examplePrefix: prefix, declarations: result.declarations, protected: protectedEntries, targets,
    lines: significantLines(input.before), measurement: measured, policy, compatibilityTargets: compatible };
  if (cache) try { writeBaselineCache(cache, baseline); } catch { /* A cache write must not invalidate a verified baseline. */ }
  return { baseline, verdict: { ok: true, summary: `${targets.length} proof target(s) verified.`, diagnostics: '', check: result,
    details: { ...details, ...compressionDetails(baseline), checkDurationMs: Date.now() - started } } };
}

export interface CompressionVerdict extends Verdict { verified?: boolean; measurement?: CompressionMeasurement; source?: string }
/** A host with an independent challenge supplies its correctness judge instead of whole-file preservation. */
export type CompressionVerifier = (source: string) => Promise<Verdict>;

/** One aggregate candidate check: preserve semantics, measure, then compare to the current best. */
export async function checkCompressedFile(environment: Environment, baseline: CompressionBaseline,
  best = baseline.measurement, verify?: CompressionVerifier): Promise<CompressionVerdict> {
  const started = Date.now();
  const { input, examplePrefix } = baseline;
  const details = { ...compressionDetails(baseline), environment: label(environment) };
  const after = read(input.file);
  if (after === undefined) return failed(`${input.file} no longer exists.`, details);
  if (!verify) {
    const current = new Set(declarations(after).filter(isTheorem).map(entry => entry.name));
    for (const was of declarations(input.before).filter(isTheorem)) {
      if (!current.has(was.name)) return failed(`The theorem ${was.name} is no longer in the file.`, details);
    }
  }
  let result: CheckResult;
  try { result = await inspect(environment, input, after, examplePrefix, !verify); }
  catch (error) { return failed(String(error), { ...details, outcome: 'unavailable' }); }
  if (result.status !== 'ok' || !result.heartbeats || (!verify && !result.declarations)) return failed(`Lean could not verify and measure the candidate: ${result.detail}`, details, result);
  if (verify) {
    const verdict = await verify(after);
    if (!verdict.ok) return { ...verdict, check: result, details: { ...details, ...verdict.details } };
  } else {
    const now = new Map(result.declarations!.map(entry => [entry.name, entry]));
    const sourceDeclarations = declarations(input.before);
    // Name the statement to restore, as written in the original source, so a retry knows exactly what to keep.
    const original = (was: LeanDeclaration) => {
      const matches = sourceDeclarations.filter(entry => entry.name === was.userName);
      return matches.length === 1 ? ` It must stay exactly:\n${matches[0]!.header}` : '';
    };
    for (const was of baseline.protected) {
      const entry = now.get(was.name);
      const name = display(was, examplePrefix);
      if (!entry) return failed(`The declaration ${name} was removed or moved to another namespace.`, details, result);
      if (entry.kind !== was.kind || entry.type !== was.type || JSON.stringify(entry.levels) !== JSON.stringify(was.levels)) return failed(`The statement or context of ${name} was changed.${original(was)}`, details, result);
      const exampleProof = was.proof && was.userName.includes(examplePrefix);
      if (was.kind !== 'theorem' && !exampleProof && entry.value !== was.value) return failed(`The definition of ${name} was changed.`, details, result);
    }
    const previous = new Set(baseline.declarations.map(entry => entry.name));
    const addedAxiom = result.declarations!.find(entry => ['axiom', 'opaque'].includes(entry.kind) && !previous.has(entry.name));
    if (addedAxiom) return failed(`New ${addedAxiom.kind} ${addedAxiom.userName} declared. A proof may not add axioms.`, details, result);
    const problem = checkAxioms(result, input, baseline.targets.map(entry => now.get(entry.name)!), baseline.declarations);
    if (problem) return failed(problem, details, result);
  }
  let measured: CompressionMeasurement;
  try { measured = await measureCompatibility(environment, input, after, examplePrefix, baseline.compatibilityTargets,
    measurement(after, result.heartbeats, label(environment), baseline.policy, input.before)); }
  catch (error) { return failed(String(error), { ...details, outcome: 'unavailable' }); }
  const selected = selectCandidate(baseline.measurement, best, measured, baseline.policy);
  // A retained result can become the original of a subsequent /compress invocation.
  if (selected.accepted && result.declarations) try {
    const nextInput = { ...input, before: after };
    const protectedEntries = protectedDeclarations(result.declarations, after, examplePrefix);
    writeBaselineCache(baselineCache(environment, nextInput, baseline.policy), { ...baseline, input: nextInput,
      declarations: result.declarations, protected: protectedEntries,
      targets: proofTargets(result.declarations, protectedEntries, nextInput, examplePrefix),
      lines: significantLines(after), measurement: measured });
  } catch { /* Optional cache storage never changes the candidate verdict. */ }
  const checkedDetails = { ...details, ...compressionMetrics(baseline.measurement, measured, baseline.policy.scoreWeights),
    declarationMetrics: measured.declarations, checkDurationMs: Date.now() - started };
  return { ok: selected.accepted, verified: true, measurement: measured, source: after,
    summary: `${selected.reason} ${compressionMetricsText(checkedDetails)}.`,
    diagnostics: selected.accepted ? '' : selected.reason, check: result, details: { ...checkedDetails, outcome: selected.accepted ? 'verified' : 'not_improved' } };
}
