import { existsSync, readFileSync } from 'node:fs';
import { check, formatCheck, leanVersionOf, type CheckResult, type Environment } from '@theoria/pi-lean/api';
import { config } from '@theoria/shared/config';
import { declarations, isTheorem, matchingDeclarations, significantLines, writesSorry, type Declaration } from './lean-source.ts';

/**
 * Theoria's checks. These, not the agent and not the prompt, decide what a workflow produced. Each reads the file
 * as it is on disk after the agent stopped, runs Lean on it, and compares it with the copy taken before the agent
 * started.
 */

/**
 * Axioms every Mathlib proof may rest on (`workflows.standardAxioms`). Anything else, `sorryAx` and
 * `Lean.ofReduceBool` included, is refused unless a prompt file permits it.
 */
export const standardAxioms = () => config().workflows.standardAxioms;

export interface Verdict {
  ok: boolean;
  /** One line for the card. */
  summary: string;
  /** What the agent is told on a retry: what failed, with Lean's own messages. */
  diagnostics: string;
  check?: CheckResult;
  details: Record<string, unknown>;
}

const fail = (summary: string, diagnostics = summary, extra: Partial<Verdict> = {}): Verdict =>
  ({ ok: false, summary, diagnostics, details: {}, ...extra });

export const read = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : undefined);

/**
 * Definitions the statement may rely on (`def`, `structure`, `instance`, …) must be exactly as they were, and no
 * `axiom` may be added: changing what a statement's words mean, or assuming the goal, would make any proof easy.
 */
export function definitionsPreserved(before: string, after: string): string | undefined {
  const normalized = (declaration: Declaration) => declaration.text.replace(/\s+/g, ' ').trim();
  const now = new Map(declarations(after).filter(entry => !isTheorem(entry) && entry.kind !== 'example').map(entry => [`${entry.kind} ${entry.name}`, normalized(entry)]));
  for (const was of declarations(before).filter(entry => !isTheorem(entry) && entry.kind !== 'example')) {
    const key = `${was.kind} ${was.name}`;
    if (!now.has(key)) return `The ${was.kind} ${was.name} was removed. Definitions the statement relies on must stay as they were.`;
    if (now.get(key) !== normalized(was)) return `The ${was.kind} ${was.name} was changed. Definitions the statement relies on must stay as they were.`;
  }
  const beforeAxioms = new Set(declarations(before).filter(entry => entry.kind === 'axiom' || entry.kind === 'opaque').map(entry => entry.name));
  const added = declarations(after).filter(entry => (entry.kind === 'axiom' || entry.kind === 'opaque') && !beforeAxioms.has(entry.name));
  if (added.length) return `New ${added.map(entry => `${entry.kind} ${entry.name}`).join(', ')} declared. A proof may not add axioms.`;
  return undefined;
}

/**
 * `/formalize`: the file elaborates, its new theorem is stated with `sorry` as the only gap, and nothing else is
 * assumed. Several new theorems mean several readings, which the user chooses between before this passes.
 */
export async function checkFormalize(environment: Environment, input: {
  cwd: string; file: string; before?: string; timeoutSeconds: number; signal?: AbortSignal;
}): Promise<Verdict & { readings: Declaration[] }> {
  const after = read(input.file);
  if (after === undefined) return { ...fail(`No file was written at ${input.file}.`), readings: [] };
  const existing = new Set(declarations(input.before ?? '').filter(isTheorem).map(entry => entry.name));
  const readings = declarations(after).filter(entry => isTheorem(entry) && !existing.has(entry.name));
  if (!readings.length) return { ...fail('The file declares no new theorem, so there is no formal statement to check.'), readings };
  const preserved = definitionsPreserved(input.before ?? '', after);
  if (preserved) return { ...fail(preserved), readings };
  const result = await check(environment, { cwd: input.cwd, path: input.file, timeoutSeconds: input.timeoutSeconds, signal: input.signal, theorems: readings.map(entry => entry.name) });
  if (result.status === 'unavailable' || result.status === 'timeout') return { ...fail(`Lean could not check it: ${result.detail}`, formatCheck(result), { check: result }), readings };
  if (result.status === 'errors') return { ...fail('The statement does not elaborate.', formatCheck(result), { check: result }), readings };
  // A statement is checked for being well-typed, not proved: sorry is expected; any other axiom means a gap elsewhere.
  for (const reading of readings) {
    const extra = (result.axioms[reading.name] ?? []).filter(axiom => axiom !== 'sorryAx' && !standardAxioms().includes(axiom));
    if (extra.length) return { ...fail(`${reading.name} relies on ${extra.join(', ')}, which a statement must not assume.`, formatCheck(result), { check: result }), readings };
  }
  return {
    ok: true,
    summary: readings.length === 1 ? `${readings[0]!.name} is well-formed: Lean accepts the statement. Well-formed is not true.` : `${readings.length} readings, each well-formed.`,
    diagnostics: '', check: result, readings, details: { theorems: readings.map(entry => entry.name) },
  };
}

/**
 * `/prove`: the theorem's statement is exactly the one before the agent started, Lean reports no error, and the
 * theorem depends only on the standard axioms (plus any the prompt permits).
 */
export interface ProofInput {
  cwd: string;
  file: string;
  theorem: string;
  /** The file as it was before the agent started. */
  before: string;
  allowedAxioms: string[];
  timeoutSeconds: number;
  signal?: AbortSignal;
}

export async function checkProof(environment: Environment, input: ProofInput): Promise<Verdict> {
  const after = read(input.file);
  if (after === undefined) return fail(`${input.file} no longer exists.`);
  const originals = matchingDeclarations(declarations(input.before).filter(isTheorem), input.theorem);
  if (originals.length > 1) return fail(`The theorem name ${input.theorem} is ambiguous. Use one of: ${originals.map(entry => entry.name).join(', ')}.`);
  const was = originals[0];
  if (!was) return fail(`The original theorem ${input.theorem} was not found in the file.`);
  const theorem = was.name;
  const now = declarations(after).find(entry => isTheorem(entry) && entry.name === theorem);
  if (!now) return fail(`The theorem ${theorem} is no longer in the file.`);
  if (now.header !== was.header) {
    return fail(`The statement of ${theorem} was changed. It must stay exactly:\n${was.header}`, undefined, { details: { expected: was.header, found: now.header } });
  }
  const preserved = definitionsPreserved(input.before, after);
  if (preserved) return fail(preserved);
  const result = await check(environment, { cwd: input.cwd, path: input.file, theorems: [theorem], timeoutSeconds: input.timeoutSeconds, signal: input.signal });
  if (result.status === 'unavailable' || result.status === 'timeout') return fail(`Lean could not check it: ${result.detail}`, formatCheck(result), { check: result });
  if (result.status === 'errors') return fail(`Lean reports ${result.errors.length} error(s).`, formatCheck(result), { check: result });
  const axioms = result.axioms[theorem];
  if (!axioms) return fail(`Lean did not report the axioms of ${theorem}.`, formatCheck(result), { check: result });
  const permitted = new Set([...standardAxioms(), ...input.allowedAxioms]);
  const refused = axioms.filter(axiom => !permitted.has(axiom));
  if (refused.length) {
    const why = refused.includes('sorryAx') ? `${theorem} still depends on sorry.` : `${theorem} depends on ${refused.join(', ')}, which is not permitted.`;
    return fail(why, formatCheck(result), { check: result, details: { axioms } });
  }
  return {
    ok: true,
    summary: `${theorem} is verified by Lean${environment.toolchain ? ` ${leanVersionOf(environment.toolchain)}` : ''}, with the statement unchanged. Axioms: ${axioms.length ? axioms.join(', ') : 'none'}.`,
    diagnostics: '', check: result, details: { axioms },
  };
}

/** `/compress`: the proof still verifies under the same statement, and the file is strictly shorter. */
export async function checkCompression(environment: Environment, input: ProofInput & { baselineLines: number }): Promise<Verdict> {
  const proof = await checkProof(environment, input);
  if (!proof.ok) return proof;
  const lines = significantLines(read(input.file) ?? '');
  if (lines >= input.baselineLines) {
    return fail(`The proof still verifies but is not shorter: ${lines} lines against ${input.baselineLines} before (helper lemmas count).`, undefined, { check: proof.check, details: { lines, baselineLines: input.baselineLines } });
  }
  return { ...proof, summary: `${proof.summary} ${input.baselineLines} → ${lines} lines.`, details: { ...proof.details, lines, baselineLines: input.baselineLines } };
}

/** Theorems in a file that still have a written `sorry`: what `/prove` on a file without a theorem name works on. */
export const openTheorems = (source: string) => declarations(source).filter(entry => isTheorem(entry) && writesSorry(entry));
