import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { config, expandHome } from '@theoria/shared/config';
import { projectPath } from '@theoria/shared/paths';
import type { Environment } from '@theoria/pi-lean/api';
import type { CompressionBaseline, CompressionInput } from './compression-gate.ts';
import { sourceHash, type CompressionPolicy } from './compression-metrics.ts';

type Snapshot = Omit<CompressionBaseline, 'input' | 'compatibilityTargets' | 'cacheHit'>;

/** Mutable local projects include their sources; benchmark callers supply a pinned environment identity. */
function context(environment: Environment, input: CompressionInput) {
  if (input.cacheIdentity) return input.cacheIdentity;
  const root = resolve(environment.projectRoot ?? input.cwd);
  const files: [string, string][] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (['.git', '.lake', config().paths.projectDir, 'node_modules', 'build', 'dist'].includes(name)) continue;
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if ((stat.isFile() || stat.isSymbolicLink()) && path !== resolve(input.file) && /\.lean$/.test(name)) files.push([relative(root, path), sourceHash(readFileSync(path, 'utf8'))]);
    }
  };
  walk(root);
  for (const name of ['lean-toolchain', 'lakefile.toml', 'lakefile.lean', 'lake-manifest.json']) {
    const path = join(root, name);
    if (existsSync(path)) files.push([name, sourceHash(readFileSync(path, 'utf8'))]);
  }
  const { sandboxProfile, checkTmpDir, ...identity } = environment;
  return { identity, root, files };
}

export function baselineCache(environment: Environment, input: CompressionInput, policy: CompressionPolicy) {
  const leanDirectory = dirname(fileURLToPath(import.meta.resolve('@theoria/pi-lean/api')));
  const implementation = ['compression-gate.ts', 'compression-metrics.ts', 'compression-tokens.ts', 'lean-source.ts', 'compression-baseline-cache.ts']
    .map(name => readFileSync(new URL(name, import.meta.url), 'utf8'))
    .concat(['check.ts', 'inspect.ts', 'heartbeats.ts'].map(name => readFileSync(join(leanDirectory, name), 'utf8')));
  const key = sourceHash(JSON.stringify({ version: 1, source: sourceHash(input.before), theorem: input.theorem,
    allowedAxioms: input.allowedAxioms, standardAxioms: config().workflows.standardAxioms, policy,
    environment: { source: environment.source, toolchain: environment.toolchain, mathlib: environment.mathlib, leanPath: environment.leanPath, extras: environment.extras },
    check: config().lean.check, context: context(environment, input),
    compatibility: (policy.compatibilityProjects ?? []).map(project => context({ source: 'lean-project', projectRoot: resolve(input.cwd, expandHome(project)) }, { ...input, cacheIdentity: undefined })),
    implementation }));
  return { key, path: join(projectPath(input.cacheRoot ?? input.cwd, config().workflows.baselineCacheDir), `${key}.json.gz`) };
}

export function readBaselineCache(cache: ReturnType<typeof baselineCache>): Snapshot | undefined {
  try {
    const saved = JSON.parse(gunzipSync(readFileSync(cache.path)).toString('utf8'));
    if (saved.key !== cache.key || saved.hash !== sourceHash(JSON.stringify(saved.baseline))) return;
    const baseline = saved.baseline as Snapshot;
    if (!baseline.targets.length || !baseline.declarations.length || !Array.isArray(baseline.protected) || typeof baseline.examplePrefix !== 'string'
      || !Array.isArray(baseline.measurement.versionsPassed) || !Array.isArray(baseline.measurement.declarations)
      || !Number.isFinite(baseline.measurement.heartbeats) || !baseline.measurement.sourceHash) return;
    return baseline;
  } catch { return; }
}

export function writeBaselineCache(cache: ReturnType<typeof baselineCache>, baseline: CompressionBaseline): void {
  const { input, compatibilityTargets, cacheHit, ...snapshot } = baseline;
  const temporary = `${cache.path}.${randomUUID()}.tmp`;
  mkdirSync(dirname(cache.path), { recursive: true });
  try {
    writeFileSync(temporary, gzipSync(JSON.stringify({ key: cache.key, hash: sourceHash(JSON.stringify(snapshot)), baseline: snapshot })));
    renameSync(temporary, cache.path);
  } finally { rmSync(temporary, { force: true }); }
}
