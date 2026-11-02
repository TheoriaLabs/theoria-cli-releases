import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { config } from '@theoria/shared/config';
import { agentDir } from '@theoria/shared/paths';
import { hermeticLeanEnv, lastLines, run, runWithTemp, seconds } from '@theoria/shared/process';
import type { Checkout } from './discovery.ts';

/**
 * Lean add-ons (`lean.extras`, LeanHammer for now): built once per Mathlib version as a Lake workspace in Theoria's
 * agent folder. The workspace's Mathlib is a copy-on-write clone of the checkout already on this machine (APFS
 * `cp -c`: existing build files share disk blocks), the add-on is required before it so the dependencies they share keep
 * Mathlib's versions, and Lake fetches only what the add-on adds. Sessions then use the workspace's `LEAN_PATH`
 * instead of the checkout's, so `import Hammer` works wherever Mathlib does.
 */

export interface ExtraSpec {
  name: string;
  title: string;
  package: string;
  repo: string;
  target: string;
  versions: readonly { mathlib: string; rev: string }[];
  tools: readonly { path: string; link: string }[];
  installTimeoutSeconds: number;
  instructions: readonly string[];
}

export const extraSpecs = (): readonly ExtraSpec[] => config().lean.extras;
export const extraSpec = (name: string) => extraSpecs().find(spec => spec.name === name);

export const extraDir = (name: string, mathlib: string) => join(agentDir(), config().lean.extrasDir, `${name}-${mathlib}`);
const readyMarker = (dir: string) => join(dir, '.theoria-extra-ready');

export type ExtraState = { name: string; title: string; ready: true; dir: string } | { name: string; title: string; ready: false; problem: string };

/** Whether `name` can be used with this Mathlib version, without changing anything. */
export function extraState(name: string, mathlib: string): ExtraState {
  const spec = extraSpec(name);
  if (!spec) return { name, title: name, ready: false, problem: `${name} is not a Lean add-on Theoria knows (lean.extras)` };
  const version = spec.versions.find(entry => entry.mathlib === mathlib);
  if (!version) {
    return { name, title: spec.title, ready: false, problem: `${spec.title} has no version for Mathlib ${mathlib} (it has ${spec.versions.map(entry => entry.mathlib).join(', ')})` };
  }
  const dir = extraDir(name, mathlib);
  try {
    const marker = JSON.parse(readFileSync(readyMarker(dir), 'utf8'));
    if (marker.name === name && marker.mathlib === mathlib && marker.rev === version.rev && marker.warmed === true
      && existsSync(join(dir, 'lake-manifest.json')) && existsSync(join(dir, '.lake', 'packages', spec.package, '.lake', 'build', 'lib', 'lean', `${spec.target.replaceAll('.', '/')}.olean`))
      && spec.tools.every(tool => existsSync(join(dir, tool.path)))) return { name, title: spec.title, ready: true, dir };
  } catch { /* not built, or built by an older installer */ }
  return { name, title: spec.title, ready: false, problem: `${spec.title} for Mathlib ${mathlib} is not installed or needs preparation: /lean extras install ${name}` };
}

/** The workspace's `LEAN_PATH` (Mathlib, the add-on and their dependencies), cached per workspace. */
export async function extraLeanPath(dir: string): Promise<string | undefined> {
  const cacheFile = join(dir, '.theoria-lean-path');
  const manifest = join(dir, 'lake-manifest.json');
  const stamp = (() => { try { return String(statSync(manifest).mtimeMs); } catch { return 'none'; } })();
  try {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as { stamp: string; leanPath: string };
    if (cached.stamp === stamp && cached.leanPath) return cached.leanPath.split(delimiter).filter(Boolean).map(path => resolve(dir, path)).join(delimiter);
  } catch { /* not cached */ }
  const result = await runWithTemp('lake', ['env', 'printenv', 'LEAN_PATH'], { cwd: dir, env: hermeticLeanEnv(), replaceEnv: true, timeoutMs: seconds(config().lean.discovery.lakeEnvTimeoutSeconds) });
  const leanPath = result.code === 0 ? result.stdout.trim().split(delimiter).filter(Boolean).map(path => resolve(dir, path)).join(delimiter) : '';
  if (!leanPath) return undefined;
  try { writeFileSync(cacheFile, JSON.stringify({ stamp, leanPath })); } catch { /* read-only here (a sandbox): fine */ }
  return leanPath;
}

/**
 * Links the executables an add-on finds relative to the working directory (LeanHammer's Zipperposition) into the
 * working directory's `.lake`, so `lean` started there finds them. Never replace a user's existing file or link.
 */
export function linkExtraTools(cwd: string, state: ExtraState): string | undefined {
  if (!state.ready) return;
  for (const tool of extraSpec(state.name)?.tools ?? []) {
    const target = join(state.dir, tool.path);
    const link = join(cwd, tool.link);
    if (!existsSync(target)) return `${state.title}'s executable is missing: ${tool.path}`;
    try {
      const existing = lstatSync(link, { throwIfNoEntry: false });
      if (existing) {
        if (!existing.isSymbolicLink()) continue;
        const previous = resolve(dirname(link), readlinkSync(link));
        if (previous === resolve(target)) continue;
        if (!previous.startsWith(resolve(agentDir(), config().lean.extrasDir) + sep) || !previous.endsWith(sep + tool.path)) continue;
        unlinkSync(link);
      }
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(target, link);
      const ignore = join(cwd, '.lake', '.gitignore');
      if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
    } catch (error) { return `Cannot prepare ${state.title}'s executable: ${error instanceof Error ? error.message : String(error)}`; }
  }
}

const installs = new Map<string, Promise<string>>();

/** Builds `name` for the checkout's Mathlib. Long (the add-on is compiled once); `onLine` reports progress. */
export function installExtra(name: string, checkout: Checkout, onLine?: (line: string) => void, signal?: AbortSignal): Promise<string> {
  const key = extraDir(name, checkout.version);
  const pending = installs.get(key);
  if (pending) return pending;
  const installation = buildExtra(name, checkout, onLine, signal).finally(() => installs.delete(key));
  installs.set(key, installation);
  return installation;
}

async function buildExtra(name: string, checkout: Checkout, onLine?: (line: string) => void, signal?: AbortSignal): Promise<string> {
  const spec = extraSpec(name);
  if (!spec) throw new Error(`${name} is not a Lean add-on Theoria knows.`);
  const version = spec.versions.find(entry => entry.mathlib === checkout.version);
  if (!version) throw new Error(`${spec.title} has no version for Mathlib ${checkout.version}.`);
  if (!checkout.built) throw new Error(`Mathlib ${checkout.version} is not built.`);
  if (extraState(name, checkout.version).ready) return `${spec.title} is already built for Mathlib ${checkout.version}. /lean extras on ${name} turns it on for this project.`;
  signal?.throwIfAborted();
  const dir = extraDir(name, checkout.version);
  const packages = join(dir, '.lake', 'packages');
  const timeoutMs = seconds(spec.installTimeoutSeconds);
  const mathlib = join(packages, 'mathlib');
  const head = spawnSync('git', ['-C', checkout.path, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
  if (!head || !/^[a-f0-9]{40}$/.test(head)) throw new Error(`Cannot read Mathlib's commit at ${checkout.path}.`);
  // Resume a matching interrupted build, never remove a working workspace just to install it again.
  const reuse = existsSync(join(dir, 'lake-manifest.json'))
    && readFileSync(join(dir, 'lean-toolchain'), 'utf8').trim() === checkout.toolchain
    && spawnSync('git', ['-C', mathlib, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() === head
    && readFileSync(join(dir, 'lakefile.toml'), 'utf8').includes(`rev = ${JSON.stringify(version.rev)}`);
  if (existsSync(dir) && !reuse) throw new Error(`${dir} is an incomplete or incompatible workspace. /lean extras remove ${name}, then install it again.`);
  if (!reuse) {
    mkdirSync(packages, { recursive: true });
    onLine?.(`Cloning Mathlib ${checkout.version} (copy-on-write)…`);
    const copied = await run('/bin/cp', ['-cR', checkout.path, mathlib], { timeoutMs, signal });
    if (copied.code !== 0) throw new Error(`Could not clone ${checkout.path} copy-on-write (it needs APFS): ${lastLines(copied.stderr, 200, 2)}`);
    // A checkout that is a git worktree points at its main repository; give the clone standalone metadata.
    if (!statSync(join(mathlib, '.git')).isDirectory()) {
      const remote = spawnSync('git', ['-C', checkout.path, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim();
      rmSync(join(mathlib, '.git'), { force: true });
      spawnSync('git', ['init', '-q', mathlib]);
      if (remote) spawnSync('git', ['-C', mathlib, 'remote', 'add', 'origin', remote]);
      writeFileSync(join(mathlib, '.git', 'HEAD'), `${head}\n`);
    }
    // Mathlib's own dependencies, already built, become the workspace's.
    for (const entry of readdirSync(join(mathlib, '.lake', 'packages'))) renameSync(join(mathlib, '.lake', 'packages', entry), join(packages, entry));
    writeFileSync(join(dir, 'lean-toolchain'), `${checkout.toolchain}\n`);
    writeFileSync(join(dir, 'lakefile.toml'), [
      'name = "theoria_extra"', 'version = "0.1.0"', '',
      '[[require]]', `name = ${JSON.stringify(spec.package)}`, `git = ${JSON.stringify(spec.repo)}`, `rev = ${JSON.stringify(version.rev)}`, '',
      '[[require]]', 'name = "mathlib"', 'scope = "leanprover-community"', `rev = ${JSON.stringify(checkout.version)}`, '',
    ].join('\n'));
    // Seed Mathlib's exact manifest so `lake update <add-on>` resolves only the add-on.
    const mathlibManifest = JSON.parse(readFileSync(join(mathlib, 'lake-manifest.json'), 'utf8')) as { packages: Record<string, unknown>[] };
    writeFileSync(join(dir, 'lake-manifest.json'), `${JSON.stringify({
      version: '1.1.0', packagesDir: '.lake/packages', name: 'theoria_extra', lakeDir: '.lake',
      packages: [
        { url: 'https://github.com/leanprover-community/mathlib4', type: 'git', subDir: null, scope: 'leanprover-community', rev: head, name: 'mathlib', manifestFile: 'lake-manifest.json', inputRev: checkout.version, inherited: false, configFile: 'lakefile.lean' },
        ...mathlibManifest.packages.map(entry => ({ ...entry, inherited: true })),
      ],
    }, null, 1)}\n`);
  }
  const env = hermeticLeanEnv();
  signal?.throwIfAborted();
  onLine?.(`Fetching ${spec.title} ${version.rev}…`);
  const updated = await runWithTemp('lake', ['update', spec.package], { cwd: dir, env, replaceEnv: true, timeoutMs, ...(signal ? { signal } : {}), ...(onLine ? { onLine } : {}) });
  if (updated.code !== 0) throw new Error(`lake update ${spec.package} failed: ${lastLines(updated.stderr || updated.stdout, 400, 4)}`);
  if (spawnSync('git', ['-C', mathlib, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim() !== head) throw new Error(`${spec.title} moved Mathlib off ${checkout.version}; not installed.`);
  // Shared dependencies must stay at Mathlib's pins too, not just Mathlib's top-level commit.
  const dependencies = JSON.parse(readFileSync(join(mathlib, 'lake-manifest.json'), 'utf8')).packages as { name: string; rev?: string }[];
  const resolved = JSON.parse(readFileSync(join(dir, 'lake-manifest.json'), 'utf8')).packages as { name: string; rev?: string }[];
  for (const dependency of dependencies) {
    if (resolved.find(entry => entry.name === dependency.name)?.rev !== dependency.rev) throw new Error(`${spec.title} changed Mathlib's ${dependency.name} dependency; not installed.`);
  }
  onLine?.(`Building ${spec.title} (a few minutes, once)…`);
  signal?.throwIfAborted();
  const built = await runWithTemp('lake', ['build', spec.target], { cwd: dir, env, replaceEnv: true, timeoutMs, ...(signal ? { signal } : {}), ...(onLine ? { onLine } : {}) });
  if (built.code !== 0) throw new Error(`Building ${spec.title} failed: ${lastLines(built.stderr || built.stdout, 400, 4)}`);
  // `lake lean` needs native import facets which `lake build Hammer` alone does not produce. Warm all of Mathlib
  // here too: trials and Comparator can only read these packages, and must never compile missing dependency files.
  onLine?.(`Preparing ${spec.title} and Mathlib for read-only trials…`);
  const warm = join(dir, 'TheoriaExtraWarm.lean');
  writeFileSync(warm, `import Mathlib\nimport ${spec.target}\n`);
  try {
    signal?.throwIfAborted();
    const loaded = await runWithTemp('lake', ['lean', warm], { cwd: dir, env, replaceEnv: true, timeoutMs, signal, onLine });
    if (loaded.code !== 0) throw new Error(`Preparing ${spec.title} failed: ${lastLines(loaded.stderr || loaded.stdout, 400, 4)}`);
  } finally { rmSync(warm, { force: true }); }
  for (const tool of spec.tools) {
    const path = join(dir, tool.path);
    const probe = spawnSync(path, ['--version'], { encoding: 'utf8', timeout: 30_000 });
    if (probe.status !== 0) throw new Error(`${tool.path} does not run (on Apple silicon: softwareupdate --install-rosetta): ${(probe.stderr || String(probe.error ?? '')).slice(0, 200)}`);
  }
  if (!await extraLeanPath(dir)) throw new Error(`Lake could not report ${spec.title}'s library path.`);
  writeFileSync(readyMarker(dir), `${JSON.stringify({ name, mathlib: checkout.version, rev: version.rev, mathlibRev: head, warmed: true, at: new Date().toISOString() })}\n`);
  return `${spec.title} ${version.rev} is built for Mathlib ${checkout.version}. /lean extras on ${name} turns it on for this project.`;
}

export function removeExtra(name: string, mathlib: string) {
  if (!extraSpec(name)?.versions.some(entry => entry.mathlib === mathlib)) throw new Error(`Unknown add-on/version: ${name} / ${mathlib}.`);
  const dir = extraDir(name, mathlib);
  if (installs.has(dir)) throw new Error(`${name} is being installed; wait for it to finish.`);
  rmSync(dir, { recursive: true, force: true });
}
