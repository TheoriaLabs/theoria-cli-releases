import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { config, expandHome } from '@theoria/shared/config';
import { agentDir } from '@theoria/shared/paths';
import { run, seconds } from '@theoria/shared/process';
import { paperSettings } from './state.ts';

export const installDir = () => join(agentDir(), config().latex.installDir);
export const texmfHome = () => join(installDir(), 'texmf');

export function findBinary(name: string): string | undefined {
  return [...(process.env.PATH ?? '').split(delimiter), ...config().latex.binDirs.map(expandHome)].filter(Boolean).map(dir => join(dir, name)).find(file => {
    try { accessSync(file, constants.X_OK); return true; } catch { return false; }
  });
}

/** Same TeX tree in the terminal and the bot; only caches are writable by a sandboxed session. */
export function texEnv(): NodeJS.ProcessEnv {
  const secret = new RegExp(config().sandbox.secretEnvPattern, 'i');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !secret.test(key) && !/^(TEX|BIBINPUTS|BSTINPUTS|LATEXMK)/.test(key)));
  const cache = join(installDir(), 'cache');
  mkdirSync(cache, { recursive: true });
  return {
    ...env, PATH: [process.env.PATH ?? '', ...config().latex.binDirs.map(expandHome)].join(delimiter),
    TEXMFHOME: texmfHome(), TEXMFVAR: join(cache, 'var'), TEXMFCONFIG: join(cache, 'config'),
    openin_any: 'p', openout_any: 'p',
  };
}

export interface TexEnvironment {
  engine: string; compiler?: string; compilerVersion?: string; latexmk?: string; latexmkVersion?: string;
  perl?: string; tlmgr?: string; kpsewhich?: string; bibtex?: string; biber?: string;
  missingPackages: string[]; problem?: string;
}

const firstLine = (text: string) => text.trim().split('\n')[0] ?? '';
export async function environment(cwd: string): Promise<TexEnvironment> {
  const { engine } = paperSettings(cwd);
  const compiler = findBinary(engine);
  const perl = findBinary('perl');
  const kpsewhich = findBinary('kpsewhich');
  const tlmgr = findBinary('tlmgr');
  const env = texEnv();
  const opts = { env, replaceEnv: true, timeoutMs: seconds(config().latex.probeTimeoutSeconds) };
  let latexmk = findBinary('latexmk');
  const managed = join(installDir(), 'latexmk', 'latexmk.pl');
  if (!latexmk && existsSync(managed)) latexmk = managed;
  const missingPackages: string[] = [];
  for (const pkg of config().latex.packages) {
    if (pkg.name === 'latexmk' && latexmk) continue;
    const result = kpsewhich ? await run(kpsewhich, [...(pkg.name === 'latexmk' ? ['--format=texmfscripts'] : []), pkg.file], opts) : undefined;
    if (!result || result.code !== 0 || !result.stdout.trim()) missingPackages.push(pkg.name);
    else if (pkg.name === 'latexmk') latexmk = result.stdout.trim();
  }
  const compilerResult = compiler ? await run(compiler, ['--version'], opts) : undefined;
  const mkResult = latexmk && perl ? await run(perl, [latexmk, '-v'], opts) : undefined;
  const problem = !compiler ? `${engine} is not installed. Install TeX Live/BasicTeX, then use /latex status to finish setup.`
    : compilerResult?.code !== 0 ? `${engine} could not start.`
      : !perl ? 'Perl is needed to run latexmk.'
        : !latexmk || mkResult?.code !== 0 ? 'latexmk is not installed or cannot run. Open /latex status → Set up dependencies.' : undefined;
  return {
    engine, compiler, compilerVersion: compilerResult ? firstLine(compilerResult.stdout) : undefined,
    latexmk, latexmkVersion: mkResult?.stdout.trim().split('\n').find(line => /Version/i.test(line)), perl, tlmgr, kpsewhich,
    bibtex: findBinary('bibtex'), biber: findBinary('biber'), missingPackages, ...(problem ? { problem } : {}),
  };
}

let installing: Promise<string> | undefined;
/** Install relocatable TeX packages in Theoria's user tree; system TeX Live remains the engine provider. */
export function installPackages(cwd: string, packages: string[], signal?: AbortSignal, onLine?: (line: string) => void): Promise<string> {
  if (installing) return installing;
  installing = install(cwd, packages, signal, onLine).finally(() => { installing = undefined; });
  return installing;
}

async function install(cwd: string, packages: string[], signal?: AbortSignal, onLine?: (line: string) => void): Promise<string> {
  if (!packages.length) return 'The required LaTeX packages are already installed.';
  if (packages.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(name))) throw new Error('Invalid TeX Live package name.');
  const found = await environment(cwd);
  if (!found.compiler || !found.tlmgr) throw new Error('Install TeX Live/BasicTeX first; its tlmgr manages LaTeX packages.');
  const tree = texmfHome();
  mkdirSync(tree, { recursive: true });
  const args = ['--usermode', '--usertree', tree];
  const options = { env: texEnv(), replaceEnv: true, timeoutMs: seconds(config().latex.installTimeoutSeconds), signal, onLine, killGroup: true };
  signal?.throwIfAborted();
  if (packages.includes('latexmk')) {
    const dir = join(installDir(), 'latexmk');
    mkdirSync(dir, { recursive: true });
    const source = config().latex.latexmk;
    for (const argv of [['init', '-q', dir], ['-C', dir, 'fetch', '--depth=1', source.repo, source.rev], ['-C', dir, 'checkout', '--detach', 'FETCH_HEAD']]) {
      signal?.throwIfAborted();
      const step = await run('git', argv, options);
      if (step.code !== 0) throw new Error(`Installing latexmk failed: ${step.stderr || step.stdout}`);
    }
  }
  const styles = packages.filter(name => name !== 'latexmk');
  if (!styles.length) {
    const next = await environment(cwd);
    if (next.problem) throw new Error(next.problem);
    return 'Installed the pinned latexmk in Theoria\'s directory.';
  }
  if (!existsSync(join(tree, 'tlpkg', 'texlive.tlpdb'))) {
    const init = await run(found.tlmgr, [...args, 'init-usertree'], options);
    if (init.code !== 0) throw new Error(`Could not initialize the TeX package tree: ${init.stderr || init.stdout}`);
  }
  const result = await run(found.tlmgr, [...args, 'install', ...new Set(styles)], options);
  if (signal?.aborted) throw new Error('LaTeX setup cancelled.');
  if (result.timedOut || result.code !== 0) throw new Error(`TeX package installation failed: ${(result.stderr || result.stdout).slice(-2000)}. Binary/non-relocatable packages such as Biber need installation in the selected TeX distribution.`);
  const next = await environment(cwd);
  if (next.problem) throw new Error(next.problem);
  const unresolved = next.missingPackages.filter(name => packages.includes(name));
  if (unresolved.length) throw new Error(`TeX Live did not install ${unresolved.join(', ')}. Check that its repository matches the installed TeX Live year.`);
  return `Installed ${packages.join(', ')} in Theoria's TeX tree.`;
}

/** Map a missing .sty/.cls to its TeX Live package using the distribution's own repository metadata. */
export async function packageFor(cwd: string, filename: string): Promise<string[]> {
  if (!/^[\w.-]+\.(sty|cls|bst|def)$/.test(filename)) return [];
  const known = config().latex.packages.find(pkg => pkg.file === filename);
  if (known) return [known.name];
  const found = await environment(cwd);
  if (!found.tlmgr) return [];
  const result = await run(found.tlmgr, ['search', '--global', '--file', `/${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`], { env: texEnv(), replaceEnv: true, timeoutMs: seconds(config().latex.probeTimeoutSeconds) });
  return [...new Set([...result.stdout.matchAll(/^([\w.-]+):\s*$/gm)].map(match => match[1]!))];
}
