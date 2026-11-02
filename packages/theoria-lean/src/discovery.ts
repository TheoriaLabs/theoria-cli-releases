import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { config } from '@theoria/shared/config';
import { agentDir, managedMathlibDir } from '@theoria/shared/paths';
import { run, seconds } from '@theoria/shared/process';
import { leanVersionOf } from './toolchain.ts';

/** A Mathlib checkout on this machine, known by its version. Its path is internal and never shown. */
export interface Checkout {
  version: string;
  /** The Lean toolchain it pins, e.g. `leanprover/lean4:v4.28.0`. */
  toolchain: string;
  path: string;
  built: boolean;
  /** Installed by Theoria, so Theoria may remove it. */
  managed: boolean;
}

export interface Inventory {
  /** Installed elan toolchains, e.g. `leanprover/lean4:v4.28.0`. */
  toolchains: string[];
  checkouts: Checkout[];
  scannedAt: string;
}

/** Suffix of an install still in progress, which is never offered. */
export const partialSuffix = '.partial';

const cacheFile = () => join(agentDir(), config().lean.inventoryFile);
const settings = () => config().lean.discovery;

/** Whether a checkout has been built: the compiled root module is there. */
export const isBuilt = (dir: string) => existsSync(join(dir, '.lake', 'build', 'lib', 'lean', 'Mathlib.olean'));

export async function toolchains(): Promise<string[]> {
  const listed = await run('elan', ['toolchain', 'list'], { timeoutMs: seconds(settings().elanTimeoutSeconds) });
  if (listed.code !== 0) return [];
  return listed.stdout.split('\n')
    .map(line => line.replace(/\s*\(.*\)\s*$/, '').trim())
    .filter(line => /^[\w.-]+\/[\w.-]+:/.test(line));
}

/** Whether a directory is a Mathlib checkout: it has `Mathlib.lean`, a `Mathlib/` tree and a pinned toolchain. */
function isMathlib(dir: string) {
  return existsSync(join(dir, 'Mathlib.lean')) && existsSync(join(dir, 'Mathlib')) && existsSync(join(dir, 'lean-toolchain'));
}

function candidates(): string[] {
  const skipped = new Set(settings().skipDirs);
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (isMathlib(dir)) { found.push(dir); return; }
    if (depth === 0) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith('.') || skipped.has(name)) continue;
      const path = join(dir, name);
      try { if (statSync(path).isDirectory()) walk(path, depth - 1); } catch { /* unreadable */ }
    }
  };
  // Theoria's installs, but not one still being installed.
  let managed: string[] = [];
  try { managed = readdirSync(managedMathlibDir()); } catch { /* none yet */ }
  for (const name of managed) {
    const path = join(managedMathlibDir(), name);
    if (!name.endsWith(partialSuffix) && isMathlib(path)) found.push(path);
  }
  walk(homedir(), settings().homeScanDepth);
  return [...new Set(found)];
}

/** The version a checkout is at: its release tag when it sits exactly on one, otherwise a description of the commit. */
async function versionOf(dir: string): Promise<string> {
  const timeoutMs = seconds(settings().gitTimeoutSeconds);
  const git = (args: string[]) => run('git', ['-C', dir, ...args], { timeoutMs });
  const exact = await git(['describe', '--tags', '--exact-match', '--match', config().lean.install.tagPattern]);
  if (exact.code === 0 && exact.stdout.trim()) return exact.stdout.trim();
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  const commit = (await git(['rev-parse', '--short', 'HEAD'])).stdout.trim();
  return `${branch && branch !== 'HEAD' ? branch : 'commit'}@${commit || 'unknown'}`;
}

/**
 * Finds installed toolchains and Mathlib checkouts: Theoria's own installs, and any checkout up to
 * `lean.discovery.homeScanDepth` levels below the home directory. One checkout per version is kept, preferring a
 * built one, then one Theoria installed.
 */
export async function scan(): Promise<Inventory> {
  const checkouts: Checkout[] = [];
  for (const path of candidates()) {
    const managed = path.startsWith(managedMathlibDir());
    checkouts.push({
      // Theoria names its installs by the release they are, which a shallow clone's tags do not always show.
      version: managed ? basename(path) : await versionOf(path),
      toolchain: readFileSync(join(path, 'lean-toolchain'), 'utf8').trim(),
      path,
      built: isBuilt(path),
      managed,
    });
  }
  const byVersion = new Map<string, Checkout>();
  for (const checkout of checkouts) {
    const held = byVersion.get(checkout.version);
    const better = !held || (checkout.built && !held.built) || (checkout.built === held.built && checkout.managed && !held.managed);
    if (better) byVersion.set(checkout.version, checkout);
  }
  const inventory: Inventory = {
    toolchains: await toolchains(),
    checkouts: [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version)),
    scannedAt: new Date().toISOString(),
  };
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(cacheFile(), `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  return inventory;
}

/** The last scan, refreshed when it is missing or something it recorded has gone. */
export async function inventory(options: { rescan?: boolean } = {}): Promise<Inventory> {
  if (!options.rescan) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile(), 'utf8')) as Inventory;
      if (cached.checkouts.every(checkout => existsSync(checkout.path))) {
        // Toolchains are cheap to list and change outside Theoria, so they are always current.
        return { ...cached, toolchains: await toolchains() };
      }
    } catch { /* no cache yet */ }
  }
  return scan();
}

/** Orders `v4.28.0`, `v4.35.0-rc3`, …; a release sorts above its release candidates, and non-releases last. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? Infinity : Number(match[4])] : undefined;
  };
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return left ? 1 : right ? -1 : a.localeCompare(b);
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return left[index]! - right[index]!;
  return 0;
}

export const describeCheckout = (checkout: Checkout) => `Mathlib ${checkout.version} · Lean ${leanVersionOf(checkout.toolchain)}`;
