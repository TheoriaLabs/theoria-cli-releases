import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@theoria/shared/config';
import { agentDir } from '@theoria/shared/paths';
import { hermeticLeanEnv, runWithTemp, seconds } from '@theoria/shared/process';
import { inventory, type Checkout } from './discovery.ts';
import { leanProject, selectionFor, type Scope } from './settings.ts';
import { leanVersionOf, toolchainFor } from './toolchain.ts';
import { extraLeanPath, extraSpecs, extraState, type ExtraState } from './extras.ts';
import { currentProfile } from '@theoria/shared/harness';

/** The add-ons the session's harness profile turns on. */
const profileExtras = (): string[] => currentProfile().leanExtras;

/** What a session's Lean resolves to, and whether it can be used as it stands. */
export interface Environment {
  /** Where it came from: a Lean project's own files, a Theoria choice for this project, the global default, or none. */
  source: 'lean-project' | Scope | 'none';
  toolchain?: string;
  mathlib?: Checkout;
  /** For a Lean project, its root. */
  projectRoot?: string;
  /** Mathlib and its dependencies, for `LEAN_PATH`. */
  leanPath?: string;
  /** Why it cannot be used, when it cannot. */
  problem?: string;
  /** Lean add-ons wanted here (the project's choice and the harness profile's), and whether each is usable. */
  extras?: ExtraState[];
  /** Controller-owned verification sandbox and temporary directory for isolated experiments. */
  sandboxProfile?: string;
  checkTmpDir?: string;
}

export const ready = (environment: Environment) => !environment.problem && environment.source !== 'none';

export function label(environment: Environment): string {
  if (environment.source === 'none') return 'Lean: not set';
  const lean = environment.toolchain ? `Lean ${leanVersionOf(environment.toolchain)}` : 'Lean';
  const extras = (environment.extras ?? []).map(extra => (extra.ready ? ` + ${extra.title}` : ` (${extra.title} unavailable)`)).join('');
  if (environment.source === 'lean-project') return `${lean} · this Lean project${extras}`;
  return environment.mathlib ? `${lean} · Mathlib ${environment.mathlib.version}${extras}` : `${lean} · no Mathlib`;
}

const cacheFile = () => join(agentDir(), config().lean.leanPathCacheFile);

/**
 * Mathlib's `LEAN_PATH`, as `lake env` reports it inside the checkout. It takes a few seconds, so it is cached per
 * checkout and recomputed when the checkout's manifest changes.
 */
async function leanPathOf(checkout: Checkout): Promise<string | undefined> {
  const manifest = join(checkout.path, 'lake-manifest.json');
  let stamp = 'none';
  try { stamp = String(statSync(manifest).mtimeMs); } catch { /* no manifest */ }
  let cache: Record<string, { stamp: string; leanPath: string }> = {};
  try { cache = JSON.parse(readFileSync(cacheFile(), 'utf8')); } catch { /* none yet */ }
  const hit = cache[checkout.path];
  if (hit && hit.stamp === stamp) return hit.leanPath;
  const result = await runWithTemp('lake', ['env', 'printenv', 'LEAN_PATH'], {
    cwd: checkout.path, timeoutMs: seconds(config().lean.discovery.lakeEnvTimeoutSeconds), env: hermeticLeanEnv(), replaceEnv: true,
  });
  const leanPath = result.code === 0 ? result.stdout.trim() : '';
  if (!leanPath) return undefined;
  cache[checkout.path] = { stamp, leanPath };
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(cacheFile(), `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  return leanPath;
}

/** Resolves what Lean a session in `cwd` uses. Nothing is installed or changed here. */
export async function resolve(cwd: string): Promise<Environment> {
  const project = leanProject(cwd);
  if (project) {
    // A Lake project owns its dependencies. Detect add-ons from parsed package entries, regardless of profile;
    // profile-requested add-ons missing from that manifest are unavailable, never injected into the lakefile.
    const packages = (() => {
      try {
        const value = JSON.parse(readFileSync(join(project.root, 'lake-manifest.json'), 'utf8')).packages;
        return Array.isArray(value) ? value.filter((entry): entry is { name: string } => typeof entry?.name === 'string') : [];
      } catch { return []; }
    })();
    const wanted = profileExtras();
    const extras: ExtraState[] = extraSpecs().filter(spec => wanted.includes(spec.name) || packages.some(entry => entry.name === spec.package)).map(spec =>
      packages.some(entry => entry.name === spec.package)
        ? { name: spec.name, title: spec.title, ready: true, dir: project.root }
        : { name: spec.name, title: spec.title, ready: false, problem: `this Lean project does not require ${spec.package}; add it to the lakefile and build it` });
    const problem = extras.filter(extra => !extra.ready).map(extra => extra.problem).join('; ');
    return { source: 'lean-project', toolchain: project.toolchain, projectRoot: project.root, ...(extras.length ? { extras } : {}), ...(problem ? { problem } : {}) };
  }

  const { selection, scope } = selectionFor(cwd);
  if (!selection || !scope) return { source: 'none' };
  const found = await inventory();

  if ('lean' in selection) {
    const version = leanVersionOf(selection.lean);
    const toolchain = found.toolchains.find(entry => leanVersionOf(entry) === version);
    return toolchain
      ? { source: scope, toolchain, ...(profileExtras().length ? { problem: `The harness's Lean add-on needs Mathlib; select a compatible Mathlib with /lean config.` } : {}) }
      : { source: scope, toolchain: toolchainFor(version), problem: `Lean ${version} is not installed.` };
  }

  const checkout = found.checkouts.find(entry => entry.version === selection.mathlib);
  if (!checkout) {
    return { source: scope, problem: `Mathlib ${selection.mathlib} is not on this machine. Install it with /lean install.` };
  }
  const base = { source: scope, mathlib: checkout, toolchain: checkout.toolchain };
  if (!checkout.built) return { ...base, problem: `Mathlib ${checkout.version} is not built.` };
  if (!found.toolchains.includes(checkout.toolchain)) {
    return { ...base, problem: `Lean ${leanVersionOf(checkout.toolchain)}, which Mathlib ${checkout.version} needs, is not installed.` };
  }
  // Add-ons: the project's choice and the harness profile's. One workspace supplies Mathlib and the add-on together.
  const wanted = [...new Set([...(selection.extras ?? []), ...profileExtras()])];
  if (wanted.length > 1) return { ...base, problem: 'Only one Lean add-on workspace can be active at a time.' };
  const extras = wanted.map(name => extraState(name, checkout.version));
  const unavailable = extras.find(extra => !extra.ready);
  if (unavailable && !unavailable.ready) return { ...base, extras, problem: unavailable.problem };
  const usable = extras.find((extra): extra is Extract<ExtraState, { ready: true }> => extra.ready);
  const leanPath = usable ? await extraLeanPath(usable.dir) : await leanPathOf(checkout);
  const withExtras = { ...base, ...(extras.length ? { extras } : {}) };
  return leanPath ? { ...withExtras, leanPath } : { ...withExtras, problem: `lake could not report the search path of ${usable ? usable.title : `Mathlib ${checkout.version}`}.` };
}

/**
 * The variables that make a plain `lean` use this environment: elan's `ELAN_TOOLCHAIN` overrides every other
 * toolchain choice, and `LEAN_PATH` puts Mathlib on the import path. A Lean project sets both itself, through its
 * `lean-toolchain` and `lake env`, so it gets nothing here.
 */
export function variables(environment: Environment): Record<string, string> {
  if (!ready(environment) || environment.source === 'lean-project' || !environment.toolchain) return {};
  return {
    ELAN_TOOLCHAIN: environment.toolchain,
    ...(environment.leanPath ? { LEAN_PATH: environment.leanPath } : {}),
  };
}
