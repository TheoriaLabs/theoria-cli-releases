import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { inventory } from '@theoria/pi-lean/api';
import { config } from '@theoria/shared/config';
import { run, runWithTemp, seconds } from '@theoria/shared/process';
import { envsDir } from './paths.ts';
import type { LeanSpec } from './types.ts';

/**
 * The Lean a benchmark runs on. A Mathlib checkout qualifies only at exactly the benchmark's commit with the same
 * toolchain; it is then cloned copy-on-write (APFS `cp -c`, no extra disk for the build) into Theoria's environments
 * folder, so Lake may write its caches there and your checkout is never written. Trial workspaces and evaluation
 * folders are Lake projects whose packages link to that clone, so Lake applies the benchmark's Lean options.
 */

export { hermeticLeanEnv } from '@theoria/shared/process';
import { hermeticLeanEnv } from '@theoria/shared/process';

export type EnvState = { ready: true; mathlib?: string } | { ready: false; reason: string };

const gitHead = (dir: string) => spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();

/** A Mathlib checkout on this machine at exactly the spec's commit and toolchain. */
export async function matchingCheckout(spec: LeanSpec): Promise<{ path: string; version: string } | undefined> {
  if (!spec.mathlibRev) return undefined;
  const found = await inventory();
  for (const checkout of found.checkouts) {
    if (!checkout.built || checkout.toolchain !== spec.toolchain) continue;
    if (gitHead(checkout.path) === spec.mathlibRev) return { path: checkout.path, version: checkout.version };
  }
  return undefined;
}

const toolchainInstalled = (toolchain: string) => {
  const result = spawnSync(join(process.env.ELAN_HOME ?? join(process.env.HOME ?? '', '.elan'), 'bin', 'elan'), ['toolchain', 'list'], { encoding: 'utf8' });
  const version = toolchain.split(':').pop() ?? toolchain;
  return (result.stdout ?? '').split('\n').some(line => line.includes(version));
};

const envPath = (rev: string) => join(envsDir(), `mathlib-${rev.slice(0, 12)}`);
const readyMarker = (dir: string) => join(dir, '.theoria-env-ready');

/** Whether the spec can run here, and the Mathlib clone to use, without changing anything. */
export async function envState(spec: LeanSpec): Promise<EnvState> {
  if (!toolchainInstalled(spec.toolchain)) return { ready: false, reason: `Lean ${spec.toolchain} is not installed (/lean install)` };
  if (!spec.mathlibRev) return { ready: true };
  const clone = envPath(spec.mathlibRev);
  if (existsSync(readyMarker(clone))) return { ready: true, mathlib: clone };
  const checkout = await matchingCheckout(spec);
  if (!checkout) return { ready: false, reason: `no built Mathlib checkout at commit ${spec.mathlibRev.slice(0, 12)}${spec.mathlibTag ? ` (${spec.mathlibTag}; /lean install ${spec.mathlibTag})` : ''}` };
  return { ready: false, reason: `Mathlib ${checkout.version} matches; its benchmark environment is prepared on the first run` };
}

/** Prepares the clone of the matching checkout, once. */
export async function ensureEnv(spec: LeanSpec, onLine?: (line: string) => void): Promise<EnvState> {
  const state = await envState(spec);
  if (state.ready || !spec.mathlibRev) return state;
  const checkout = await matchingCheckout(spec);
  if (!checkout) return state;
  const clone = envPath(spec.mathlibRev);
  rmSync(clone, { recursive: true, force: true });
  mkdirSync(envsDir(), { recursive: true });
  onLine?.(`Cloning Mathlib ${checkout.version} (copy-on-write)…`);
  const copied = await run('/bin/cp', ['-cR', checkout.path, clone], { timeoutMs: seconds(config().benchmarks.prepareTimeoutSeconds) });
  if (copied.code !== 0) {
    rmSync(clone, { recursive: true, force: true });
    return { ready: false, reason: `could not clone ${checkout.path} copy-on-write (it needs APFS): ${copied.stderr.trim().slice(0, 200)}` };
  }
  // A checkout that is a git worktree points at its main repository, which a sandboxed trial cannot read; Lake then
  // sees no remote and would delete the package. The clone gets a standalone .git of its own: the same remote and
  // HEAD at the same commit, which is all Lake reads.
  if (!statSync(join(clone, '.git')).isDirectory()) {
    const remote = spawnSync('git', ['-C', checkout.path, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout?.trim();
    rmSync(join(clone, '.git'), { force: true });
    spawnSync('git', ['init', '-q', clone]);
    if (remote) spawnSync('git', ['-C', clone, 'remote', 'add', 'origin', remote]);
    writeFileSync(join(clone, '.git', 'HEAD'), `${spec.mathlibRev}\n`);
    if (gitHead(clone) !== spec.mathlibRev) return { ready: false, reason: `could not give the Mathlib clone a standalone .git at ${spec.mathlibRev.slice(0, 12)}` };
  }
  // Lake writes the dependency's compiled lakefile on first load; that happens here, outside any sandbox.
  const warm = join(envsDir(), `warm-${spec.mathlibRev.slice(0, 12)}`);
  rmSync(warm, { recursive: true, force: true });
  makeLakeProject(warm, spec, clone, { name: 'theoria_warm', libs: [] });
  // Importing all of Mathlib once makes Lake write the hashes and traces it keeps beside the build; a sandboxed trial,
  // which cannot write the clone, then only reads them.
  writeFileSync(join(warm, 'Warm.lean'), ['import Mathlib', ...(spec.supportModules ?? []).map(module => `import ${module.name}`), ''].join('\n'));
  onLine?.('Loading Mathlib once with Lake…');
  const loaded = await runWithTemp('lake', ['lean', 'Warm.lean'], { cwd: warm, timeoutMs: seconds(config().benchmarks.prepareTimeoutSeconds), env: hermeticLeanEnv(), replaceEnv: true });
  rmSync(warm, { recursive: true, force: true });
  if (loaded.code !== 0) return { ready: false, reason: `Lake could not load the Mathlib clone: ${(loaded.stderr || loaded.stdout).trim().slice(-300)}` };
  writeFileSync(readyMarker(clone), `${JSON.stringify({ from: checkout.path, rev: spec.mathlibRev, at: new Date().toISOString() })}\n`);
  return { ready: true, mathlib: clone };
}

/** A Lake project on an add-on's workspace: its manifest and packages (Mathlib included), the add-on required first. */
function makeExtraProject(dir: string, spec: LeanSpec, extra: ExtraWorkspace, options: { name: string; libs: string[] }) {
  mkdirSync(join(dir, '.lake', 'packages'), { recursive: true });
  writeFileSync(join(dir, 'lean-toolchain'), `${spec.toolchain}\n`);
  writeFileSync(join(dir, 'lakefile.toml'), [
    `name = ${JSON.stringify(options.name)}`, 'version = "0.1.0"', '',
    ...(Object.keys(spec.leanOptions).length ? ['[leanOptions]', ...Object.entries(spec.leanOptions).map(([key, value]) => `${key} = ${tomlValue(value)}`), ''] : []),
    '[[require]]', `name = ${JSON.stringify(extra.package)}`, `git = ${JSON.stringify(extra.repo)}`, `rev = ${JSON.stringify(extra.rev)}`, '',
    '[[require]]', 'name = "mathlib"', 'scope = "leanprover-community"', `rev = ${JSON.stringify(spec.mathlibTag ?? spec.mathlibRev)}`, '',
    ...libraryLines(dir, spec, options.libs),
  ].join('\n'));
  const manifest = JSON.parse(readFileSync(join(extra.dir, 'lake-manifest.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dir, 'lake-manifest.json'), `${JSON.stringify({ ...manifest, name: options.name }, null, 1)}\n`);
  for (const name of readdirSync(join(extra.dir, '.lake', 'packages'))) {
    const path = join(dir, '.lake', 'packages', name);
    if (!existsSync(path)) symlinkSync(join(extra.dir, '.lake', 'packages', name), path);
  }
}

const tomlValue = (value: string | number | boolean) => (typeof value === 'string' ? JSON.stringify(value) : String(value));

/** Trusted utility modules are recreated from pinned sources in every trial/evaluation, including their Lake roots. */
function libraryLines(dir: string, spec: LeanSpec, libs: string[]): string[] {
  const modules = spec.supportModules ?? [];
  const names = new Set<string>();
  for (const module of modules) {
    if (!/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(module.name) || ['Solution', 'Challenge', 'TheoriaBenchmarkSupport', 'Mathlib', 'Lean', 'Init'].includes(module.name.split('.')[0]!)) throw new Error(`Invalid benchmark support module: ${module.name}`);
    if (names.has(module.name)) throw new Error(`Duplicate benchmark support module: ${module.name}`);
    names.add(module.name);
    const path = join(dir, `${module.name.replaceAll('.', '/')}.lean`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, module.source);
  }
  return [
    ...libs.flatMap(lib => ['[[lean_lib]]', `name = ${JSON.stringify(lib)}`, '']),
    ...(modules.length ? ['[[lean_lib]]', 'name = "TheoriaBenchmarkSupport"', `roots = ${JSON.stringify([...names])}`, ''] : []),
  ];
}

/** A Lean add-on's workspace (lean.extras) a trial or judge project builds on: Mathlib and the add-on together. */
export interface ExtraWorkspace { dir: string; package: string; repo: string; rev: string }

/** A Lake project using the benchmark's exact toolchain, Lean options and prepared dependencies. */
export function makeLakeProject(dir: string, spec: LeanSpec, mathlib: string | undefined, options: { name: string; libs: string[]; extra?: ExtraWorkspace }) {
  if (options.extra) return makeExtraProject(dir, spec, options.extra, options);
  mkdirSync(join(dir, '.lake', 'packages'), { recursive: true });
  writeFileSync(join(dir, 'lean-toolchain'), `${spec.toolchain}\n`);
  const lines = [
    `name = ${JSON.stringify(options.name)}`, 'version = "0.1.0"', '',
    ...(Object.keys(spec.leanOptions).length ? ['[leanOptions]', ...Object.entries(spec.leanOptions).map(([key, value]) => `${key} = ${tomlValue(value)}`), ''] : []),
    ...(mathlib && spec.mathlibRev ? ['[[require]]', 'name = "mathlib"', 'scope = "leanprover-community"', `rev = ${JSON.stringify(spec.mathlibTag ?? spec.mathlibRev)}`, ''] : []),
    ...libraryLines(dir, spec, options.libs),
  ];
  writeFileSync(join(dir, 'lakefile.toml'), lines.join('\n'));
  if (mathlib && spec.manifest) {
    const manifest = JSON.parse(spec.manifest) as Record<string, unknown>;
    manifest.name = options.name;
    writeFileSync(join(dir, 'lake-manifest.json'), `${JSON.stringify(manifest, null, 1)}\n`);
  }
  if (mathlib) {
    const link = (name: string, target: string) => { const path = join(dir, '.lake', 'packages', name); if (!existsSync(path)) symlinkSync(target, path); };
    link('mathlib', mathlib);
    for (const name of readdirSync(join(mathlib, '.lake', 'packages'))) link(name, join(mathlib, '.lake', 'packages', name));
  }
}
