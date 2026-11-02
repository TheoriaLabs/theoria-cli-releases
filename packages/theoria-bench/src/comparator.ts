import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '@theoria/shared/config';
import { lastLines, run, runWithTemp, seconds } from '@theoria/shared/process';
import { elanBin } from '@theoria/shared/paths';
import { hermeticLeanEnv, makeLakeProject, type ExtraWorkspace } from './env.ts';
import { toolsDir } from './paths.ts';
import type { BenchmarkTask, LeanSpec } from './types.ts';
import { cloneAt } from './benchmarks/git.ts';

/**
 * Comparator (leanprover/comparator) as the judge of every trial: it builds the untouched challenge and the
 * solution, exports both, and accepts only when each listed theorem has the same statement (and every declaration it
 * uses is the same), uses only the permitted axioms, and replays through the Lean kernel. It sandboxes its builds
 * with landrun, which is Linux-only; on macOS Theoria's stand-in (`bin/landrun`) enforces the same command line
 * with sandbox-exec. Built once per Lean minor version, from the tag in `benchmarks.comparator.tags`.
 */

const settings = () => config().benchmarks.comparator;
const landrunDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'bin');
const minor = (toolchain: string) => /v?(\d+\.\d+)/.exec(toolchain)?.[1] ?? '';

export function comparatorTag(toolchain: string): string | undefined {
  return settings().tags.find(entry => entry.lean === minor(toolchain))?.tag;
}

const buildDir = (toolchain: string) => join(toolsDir(), `comparator-${comparatorTag(toolchain)}-${(toolchain.split(':').pop() ?? '').replace(/^v/, '')}`);
const exporterRevision = (toolchain: string) => settings().tags.find(entry => entry.lean === minor(toolchain))?.exporter;
const exporterDir = (toolchain: string) => exporterRevision(toolchain)
  ? join(buildDir(toolchain), `lean4export-${exporterRevision(toolchain)}`)
  : join(buildDir(toolchain), '.lake', 'packages', 'lean4export');
const binaries = (toolchain: string) => ({
  comparator: join(buildDir(toolchain), '.lake', 'build', 'bin', 'comparator'),
  lean4export: join(exporterDir(toolchain), '.lake', 'build', 'bin'),
});

export function comparatorReady(toolchain: string): boolean {
  const bins = binaries(toolchain);
  return existsSync(bins.comparator) && existsSync(join(bins.lean4export, 'lean4export'));
}

/** Clones Comparator at its tag and builds it with the benchmark's exact toolchain (lean4export must read its .oleans). */
export async function buildComparator(toolchain: string, onLine?: (line: string) => void): Promise<void> {
  const tag = comparatorTag(toolchain);
  if (!tag) throw new Error(`No Comparator version is configured for Lean ${minor(toolchain)} (benchmarks.comparator.tags).`);
  if (comparatorReady(toolchain)) return;
  const dir = buildDir(toolchain);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(toolsDir(), { recursive: true });
  onLine?.(`Cloning Comparator ${tag}…`);
  const cloned = await run('git', ['clone', '-q', '--depth=1', '-b', tag, settings().repo, dir], { timeoutMs: seconds(settings().buildTimeoutSeconds) });
  if (cloned.code !== 0) throw new Error(`Cloning Comparator failed: ${lastLines(cloned.stderr, 300, 3)}`);
  writeFileSync(join(dir, 'lean-toolchain'), `${toolchain}\n`);
  onLine?.(`Building Comparator and lean4export for ${toolchain}…`);
  const external = exporterRevision(toolchain);
  const built = await runWithTemp('lake', ['build', 'comparator', ...(external ? [] : ['lean4export'])], { cwd: dir, timeoutMs: seconds(settings().buildTimeoutSeconds), env: hermeticLeanEnv(), replaceEnv: true, ...(onLine ? { onLine } : {}) });
  if (built.code !== 0) throw new Error(`Building Comparator failed: ${lastLines(built.stderr || built.stdout, 400, 4)}`);
  if (external) {
    const exporter = exporterDir(toolchain);
    onLine?.(`Building the separate lean4export ${external} for ${toolchain}…`);
    await cloneAt(settings().exporterRepo, external, exporter, onLine);
    writeFileSync(join(exporter, 'lean-toolchain'), `${toolchain}\n`);
    const exported = await runWithTemp('lake', ['build', 'lean4export'], { cwd: exporter, timeoutMs: seconds(settings().buildTimeoutSeconds), env: hermeticLeanEnv(), replaceEnv: true, ...(onLine ? { onLine } : {}) });
    if (exported.code !== 0) throw new Error(`Building lean4export failed: ${lastLines(exported.stderr || exported.stdout, 400, 4)}`);
  }
  if (!comparatorReady(toolchain)) throw new Error(`Comparator or lean4export is missing after building for ${toolchain}.`);
  if (external) {
    // Old Comparator tags and exporter tags need not speak the same format. Test the actual pair before any trial.
    const task = { id: 'self_test', title: 'Comparator compatibility', challenge: 'theorem comparator_self_test : 1 + 1 = 2 := by sorry\n', theorems: ['comparator_self_test'] };
    const checked = await judge(join(dir, 'self-test'), { toolchain, leanOptions: {} }, undefined, task, task.challenge.replace('sorry', 'rfl'));
    if (checked.verdict !== 'passed') {
      rmSync(join(binaries(toolchain).lean4export, 'lean4export'), { force: true });
      throw new Error(`Comparator/exporter compatibility check failed: ${checked.reason}`);
    }
  }
}

export interface Judgement { verdict: 'passed' | 'rejected' | 'unavailable'; reason: string; log: string }

/**
 * Judges `solution` for `task` in a fresh folder: the challenge from the benchmark, not from the trial, and a Lake
 * build the solution never ran in before (Comparator's own assumption).
 */
export async function judge(dir: string, spec: LeanSpec, mathlib: string | undefined, task: BenchmarkTask, solution: string, extra?: ExtraWorkspace, signal?: AbortSignal): Promise<Judgement> {
  if (!comparatorReady(spec.toolchain)) return { verdict: 'unavailable', reason: `Comparator for ${spec.toolchain} is not built (/benchmark install)`, log: '' };
  rmSync(dir, { recursive: true, force: true });
  makeLakeProject(dir, spec, mathlib, { name: 'theoria_eval', libs: ['Challenge', 'Solution'], ...(extra ? { extra } : {}) });
  writeFileSync(join(dir, 'Challenge.lean'), task.challenge);
  writeFileSync(join(dir, 'Solution.lean'), solution);
  writeFileSync(join(dir, 'config.json'), JSON.stringify({
    challenge_module: 'Challenge', solution_module: 'Solution', theorem_names: task.theorems,
    ...(task.definitions?.length ? { definition_names: task.definitions } : {}),
    permitted_axioms: config().workflows.standardAxioms, enable_nanoda: false,
  }));
  const bins = binaries(spec.toolchain);
  // node runs the landrun stand-in; elan's lake and lean build; git comes from the system.
  const path = [landrunDir, bins.lean4export, dirname(process.execPath), elanBin(), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter);
  const result = await runWithTemp('lake', ['env', bins.comparator, 'config.json'], {
    signal, killGroup: true,
    cwd: dir, timeoutMs: seconds(settings().timeoutSeconds), replaceEnv: true,
    env: { ...hermeticLeanEnv(), PATH: path, COMPARATOR_LANDRUN: join(landrunDir, 'landrun'), COMPARATOR_LEAN4EXPORT: join(bins.lean4export, 'lean4export') },
  });
  const log = `${result.stdout}\n${result.stderr}`.trim();
  writeFileSync(join(dir, 'comparator.log'), `${log}\n`);
  if (signal?.aborted) return { verdict: 'unavailable', reason: 'Comparator was cancelled.', log };
  if (result.timedOut) return { verdict: 'unavailable', reason: `Comparator did not finish within ${settings().timeoutSeconds}s`, log };
  if (result.code === 0 && /Your solution is okay!/.test(log)) return { verdict: 'passed', reason: 'Comparator: same statement, permitted axioms only, accepted by the kernel', log };
  // The untouched challenge did not build: the judge's environment is broken, and the solution was never judged.
  const solutionStarted = /^Building Solution/m.test(log);
  if (!solutionStarted) return { verdict: 'unavailable', reason: `Comparator could not build the untouched challenge, so nothing was judged: ${lastLines(log.split('\n').filter(line => /error|exception/.test(line)).join('\n') || log, 240, 2)}`, log };
  // A program the judge needs could not run (exit 126/127): nothing was judged.
  if (/Child exited with 12[67]\b|No such file or directory|command not found/.test(log) && !/error:/.test(log)) return { verdict: 'unavailable', reason: `Comparator could not run its build: ${lastLines(log, 200, 2)}`, log };
  const reason = /uncaught exception: (.+)/.exec(log)?.[1] ?? /error: (.+)/.exec(log)?.[1] ?? lastLines(log, 300, 2);
  return { verdict: 'rejected', reason: `Comparator: ${reason}`, log };
}

export const readSolution = (workspace: string) => { try { return readFileSync(join(workspace, 'Solution.lean'), 'utf8'); } catch { return undefined; } };
