import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { config } from '@theoria/shared/config';
import { hermeticLeanEnv, isolatedGitEnv, runWithTemp, seconds, type RunOptions } from '@theoria/shared/process';
import { label, ready, variables, type Environment } from './environment.ts';
import { linkExtraTools } from './extras.ts';
import { randomUUID } from 'node:crypto';
import { inspectionScript, readInspection, type LeanDeclaration } from './inspect.ts';
import { heartbeatArgs, readHeartbeats, type HeartbeatReport } from './heartbeats.ts';
import { elanBin } from '@theoria/shared/paths';

export interface CheckResult {
  status: 'ok' | 'errors' | 'unavailable' | 'timeout';
  environment: string;
  errors: string[];
  warnings: string[];
  usesSorry: boolean;
  /** Per theorem asked about: the axioms it depends on, as Lean reports them. */
  axioms: Record<string, string[]>;
  declarations?: LeanDeclaration[];
  heartbeats?: HeartbeatReport;
  detail: string;
}

export interface CheckInput {
  cwd: string;
  code?: string;
  path?: string;
  theorems?: string[];
  timeoutSeconds?: number;
  signal?: AbortSignal;
  /** Inspect all local kernel declarations, including private constants, for workflow preservation checks. */
  inspect?: boolean;
  /** Profile the unmodified source with Lean's serial command heartbeat counters. */
  measureHeartbeats?: boolean;
  /** Internal: the original source when the verification copy instruments anonymous examples. */
  heartbeatSource?: string;
}

const axiomPattern = /^'(.+)' depends on axioms: \[([^\]]*)\]/;
const noAxiomPattern = /^'(.+)' does not depend on any axioms/;
const messageHeader = /^.+?:\d+:\d+: (error|warning|info)/;
/** Lean writes the warning with backticks or quotes depending on version. */
export const sorryWarning = /declaration uses [`']sorry[`']/;
const theoremName = /^(?:«[^»\r\n]+»|[\p{L}_][\p{L}\p{N}_'!?₀-₉]*)(?:\.(?:«[^»\r\n]+»|[\p{L}_][\p{L}\p{N}_'!?₀-₉]*))*$/u;

/** Keep a module header ahead of the inspector's extra import. */
export function withInspectionImport(source: string): string {
  let at = 0, depth = 0;
  while (at < source.length) {
    if (source.startsWith('/-', at)) { depth++; at += 2; }
    else if (depth && source.startsWith('-/', at)) { depth--; at += 2; }
    else if (depth || /\s/.test(source[at]!)) at++;
    else if (source.startsWith('--', at)) { const end = source.indexOf('\n', at); at = end < 0 ? source.length : end + 1; }
    else break;
  }
  const header = /^module\b/.exec(source.slice(at));
  return header ? `${source.slice(0, at + header[0].length)}\nimport Lean\n${source.slice(at + header[0].length)}` : `import Lean\n${source}`;
}

/** The source to check, and the name shown for it in Lean's messages. */
function sourceOf(input: CheckInput): { source: string; shown: string } | { problem: string } {
  if (input.code !== undefined) return { source: input.code, shown: '<code>' };
  if (!input.path) return { problem: 'Give either code or a path to check.' };
  try {
    return { source: readFileSync(resolvePath(input.cwd, input.path), 'utf8'), shown: input.path };
  } catch (error) {
    return { problem: `Could not read ${input.path}: ${error instanceof Error ? error.message : 'unreadable'}` };
  }
}

/**
 * Runs Lean on a file: through `lake lean` in a Lean project, otherwise with the selected toolchain and Mathlib.
 * `lake lean`, not `lake env lean`: only it applies the project's `leanOptions` (such as `relaxedAutoImplicit` or
 * `maxSynthPendingDepth`), which change what elaborates, so a check agrees with `lake build`.
 */
function runLean(environment: Environment, file: string, input: { cwd: string; signal?: AbortSignal; leanArgs?: string[] }, timeoutMs: number) {
  const execute = (command: string, args: string[], options: RunOptions) => {
    const base = { ...options.env, TMPDIR: dirname(file) };
    if (!environment.sandboxProfile) return runWithTemp(command, args, { ...options, env: base });
    const env = isolatedGitEnv(Object.fromEntries(Object.entries(base).filter(([key]) => !new RegExp(config().sandbox.secretEnvPattern).test(key))));
    return runWithTemp('/usr/bin/sandbox-exec', ['-f', environment.sandboxProfile, join(elanBin(), command), ...args], { ...options, env, replaceEnv: true });
  };
  if (environment.source === 'lean-project') {
    // The project's own toolchain and dependencies: a session's Lean choice in the environment must not reach them.
    return execute('lake', ['lean', file, ...(input.leanArgs?.length ? ['--', ...input.leanArgs] : [])], { cwd: environment.projectRoot, timeoutMs, signal: input.signal, env: hermeticLeanEnv(), replaceEnv: true, killGroup: true });
  }
  for (const extra of environment.extras ?? []) {
    const problem = linkExtraTools(input.cwd, extra);
    if (problem) throw new Error(problem);
  }
  return execute('lean', [...config().lean.check.leanArgs, ...(input.leanArgs ?? []), file], { cwd: input.cwd, env: { ...hermeticLeanEnv(), ...variables(environment) }, replaceEnv: true, timeoutMs, signal: input.signal, killGroup: true });
}

function axiomsIn(output: string): Record<string, string[]> {
  const axioms: Record<string, string[]> = {};
  for (const line of output.split('\n').map(entry => entry.trim())) {
    const depends = axiomPattern.exec(line);
    if (depends) axioms[depends[1]!] = depends[2]!.split(',').map(entry => entry.trim()).filter(Boolean);
    const none = noAxiomPattern.exec(line);
    if (none) axioms[none[1]!] = [];
  }
  return axioms;
}

/**
 * Elaborates Lean source in a temporary file and returns Lean's raw output, with the temporary file's path replaced
 * by `shown`. For callers that read their own output, such as a script appended to the source; `check` reads the
 * usual messages.
 */
export async function elaborate(environment: Environment, input: { cwd: string; source: string; shown: string; timeoutSeconds?: number; signal?: AbortSignal; leanArgs?: string[] }) {
  const dir = mkdtempSync(join(environment.checkTmpDir ?? tmpdir(), 'theoria-lean-check-'));
  const file = join(dir, 'Check.lean');
  try {
    writeFileSync(file, input.source, 'utf8');
    const timeoutMs = seconds(input.timeoutSeconds ?? config().lean.check.defaultTimeoutSeconds);
    const result = await runLean(environment, file, input, timeoutMs);
    return { ...result, timeoutMs, output: `${result.stdout}\n${result.stderr}`.split(file).join(input.shown) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Elaborates Lean source against the session's environment and reports what Lean said.
 *
 * Errors, the `sorry` warning and `#print axioms` output are read from Lean's own messages; nothing is inferred.
 * An environment that cannot be used is reported as `unavailable`, never as a failed check, since nothing was checked.
 */
export async function check(environment: Environment, input: CheckInput): Promise<CheckResult> {
  const started = Date.now();
  const limits = config().lean.check;
  const base = { environment: label(environment), errors: [], warnings: [], usesSorry: false, axioms: {} };
  if (!ready(environment)) {
    return { ...base, status: 'unavailable', detail: environment.problem ?? 'No Lean environment is selected; the user chooses one with /lean.' };
  }
  if (environment.source !== 'lean-project') for (const extra of environment.extras ?? []) {
    const problem = linkExtraTools(input.cwd, extra);
    if (problem) return { ...base, status: 'unavailable', detail: problem };
  }
  const read = sourceOf(input);
  if ('problem' in read) return { ...base, status: 'unavailable', detail: read.problem };
  const theorems = (input.theorems ?? []).filter(name => theoremName.test(name)).map(name => name.replace(/^_root_\./, ''));
  const marker = input.inspect ? `THEORIA_${randomUUID().replaceAll('-', '')}` : undefined;
  const needsImport = !!marker && !/^\s*import\s+(Lean|Mathlib)\s*(?:--[^\n]*)?$/m.test(read.source);
  const remainingSeconds = () => (input.timeoutSeconds ?? limits.defaultTimeoutSeconds) - (Date.now() - started) / 1000;
  let heartbeats: HeartbeatReport | undefined;
  if (input.measureHeartbeats) {
    if (remainingSeconds() <= 0) return { ...base, status: 'timeout', detail: 'The heartbeat check exhausted its time budget.' };
    const profile = await elaborate(environment, { cwd: input.cwd, source: input.heartbeatSource ?? read.source, shown: read.shown,
      timeoutSeconds: remainingSeconds(), signal: input.signal, leanArgs: heartbeatArgs });
    if (input.signal?.aborted) return { ...base, status: 'unavailable', detail: 'Heartbeat measurement was cancelled.' };
    if (profile.timedOut) return { ...base, status: 'timeout', detail: 'Lean heartbeat measurement timed out.' };
    const measured = readHeartbeats(profile.output);
    if (measured.errors.length) return { ...base, status: 'errors', errors: measured.errors, detail: 'The source did not elaborate during heartbeat measurement.' };
    if (profile.code !== 0) return { ...base, status: 'unavailable', detail: profile.output.trim().slice(0, limits.maxRawOutputChars) || `Lean profiling exited with ${profile.code}.` };
    if (!measured.report) return { ...base, status: 'unavailable', detail: measured.problem ?? 'Lean did not return heartbeat measurements.' };
    heartbeats = measured.report;
  }
  // The inspector needs Lean's meta API. Check a core-only file unmodified first, so the added import cannot
  // accidentally make an otherwise invalid source elaborate. Both runs share the caller's time budget.
  if (needsImport && !heartbeats) {
    const original = await check(environment, { ...input, code: read.source, inspect: false });
    if (original.status !== 'ok') return original;
  }

  {
    const source = [needsImport ? withInspectionImport(read.source) : read.source, '', ...theorems.map(name => `#print axioms _root_.${name}`), marker ? inspectionScript(marker) : ''].join('\n');
    const remaining = remainingSeconds();
    if (remaining <= 0) return { ...base, status: 'timeout', detail: 'Lean inspection exhausted its time budget.' };
    const result = await elaborate(environment, { cwd: input.cwd, source, shown: read.shown, timeoutSeconds: remaining, signal: input.signal });
    if (result.timedOut) return { ...base, status: 'timeout', detail: `Lean did not finish within ${result.timeoutMs / 1000}s.` };
    if (input.signal?.aborted) return { ...base, status: 'unavailable', detail: 'Lean check was cancelled.' };
    if (result.code === null) return { ...base, status: 'unavailable', detail: result.output.trim().slice(0, limits.maxRawOutputChars) || 'Lean exited without a result.' };

    const output = result.output;
    const messages = splitMessages(marker ? output.split('\n').filter(line => !line.startsWith(`${marker} `)).join('\n') : output, limits.maxMessageChars);
    const errors = messages.filter(message => messageHeader.exec(message)?.[1] === 'error');
    const warnings = messages.filter(message => messageHeader.exec(message)?.[1] === 'warning');
    const axioms = axiomsIn(output);
    const declarations = marker ? readInspection(output, marker) : undefined;
    const failed = errors.length > 0 || result.code !== 0;
    const scriptLine = read.source.split('\n').length + (needsImport ? 1 : 0) + 2;
    if (marker && !declarations && errors.length && errors.every(message => {
      const line = /^.+?:(\d+):\d+: error/.exec(message)?.[1];
      return line !== undefined && Number(line) >= scriptLine;
    })) return { ...base, status: 'unavailable', detail: `Lean declaration inspection failed: ${errors.join('\n').slice(0, limits.maxRawOutputChars)}` };
    if (marker && !failed && !declarations) return { ...base, status: 'unavailable', detail: 'Lean did not return a complete declaration inventory (unsupported inspection or truncated output).' };
    if (declarations) for (const declaration of declarations) axioms[declaration.name] = declaration.axioms;
    // A proof that failed to elaborate is filled with `sorry` internally, so `sorryAx` then means the error, not a
    // written `sorry`, and is not reported as one.
    const usesSorry = warnings.some(warning => sorryWarning.test(warning)) || (!failed && Object.values(axioms).some(list => list.includes('sorryAx')));
    const leftover = failed && !errors.length ? [output.trim().slice(0, limits.maxRawOutputChars) || `lean exited with ${result.code}`] : [];
    return {
      ...base,
      status: failed ? 'errors' : 'ok',
      errors: [...errors, ...leftover].slice(0, limits.maxMessages),
      warnings: warnings.slice(0, limits.maxMessages),
      usesSorry,
      axioms,
      ...(declarations ? { declarations } : {}),
      ...(heartbeats ? { heartbeats } : {}),
      detail: failed ? `${errors.length || 1} error(s).` : `Elaborated with no errors${usesSorry ? ', but it uses sorry' : ''}.`,
    };
  }
}

/** Lean prints one message per `file:line:col:` header; continuation lines belong to the message above. */
function splitMessages(output: string, maxChars: number): string[] {
  const messages: string[] = [];
  for (const line of output.split('\n')) {
    if (messageHeader.test(line)) messages.push(line);
    else if (messages.length && line.trim() && !axiomPattern.test(line.trim()) && !noAxiomPattern.test(line.trim())) {
      messages[messages.length - 1] += `\n${line}`;
    }
  }
  return messages.map(message => message.slice(0, maxChars));
}

export function formatCheck(result: CheckResult): string {
  const lines = [`Lean check: ${result.status} (${result.environment}). ${result.detail}`];
  if (result.heartbeats) {
    lines.push(`Heartbeats: ${result.heartbeats.total.toFixed(3)} (serial command elaboration; 1000 internal ticks = 1 heartbeat).`);
    for (const command of [...result.heartbeats.commands].sort((a, b) => b.heartbeats - a.heartbeats).slice(0, config().lean.check.maxHeartbeatCommands)) {
      lines.push(`  Line ${command.line}: ${command.heartbeats.toFixed(3)} — ${command.command.split('\n')[0]!.slice(0, config().lean.check.maxMessageChars)}`);
    }
  }
  if (result.errors.length) lines.push('', 'Errors:', ...result.errors);
  if (result.usesSorry) lines.push('', 'The source uses sorry, so it is not a complete proof.');
  if (result.status === 'errors' && Object.keys(result.axioms).length) {
    lines.push('', 'Axiom lists below are of the declarations as Lean recorded them after the errors, so they are not evidence.');
  }
  for (const [name, axioms] of Object.entries(result.axioms)) {
    lines.push(`Axioms of ${name}: ${axioms.length ? axioms.join(', ') : 'none'}`);
  }
  const otherWarnings = result.warnings.filter(warning => !sorryWarning.test(warning));
  if (otherWarnings.length) lines.push('', 'Warnings:', ...otherWarnings.slice(0, config().lean.check.maxWarningsShown));
  return lines.join('\n');
}
