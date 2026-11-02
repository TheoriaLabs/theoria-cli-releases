import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, parse, relative } from 'node:path';
import { config, configEnv, expandHome, shippedConfigPath } from '@theoria/shared/config';
import { agentDir, elanBin } from '@theoria/shared/paths';
import { stateDir } from './store.ts';

/**
 * The macOS sandbox (`sandbox-exec`) around a session `theoria bot` starts for one project.
 *
 * Everything is allowed by default except what is denied below, so Pi, node, git and Lean keep working:
 * - Reads under `sandbox.denyReadUnder` (the home folder) are refused, except the projects folder, Theoria's own
 *   install and agent directory, the Lean toolchains, the Mathlib checkouts and `sandbox.allowRead`. The folders
 *   above an allowed path may be stat-ed, which node needs to resolve paths, but not listed.
 * - Writes are refused everywhere except this project, the temporary directory, the agent directory and
 *   `sandbox.allowReadWrite`. The connector's own state directory stays read-only.
 * - `sandbox.denyExec` programs cannot be run, so the Keychain token cannot be read back with `security`.
 * - `sandbox.protectedProjectFiles` (the project's `.pi/mcp.json`, `.pi/extensions`, …) cannot be written, nor the
 *   `.pi` folder replaced: a trusted project loads them in a terminal session, which runs outside the sandbox.
 * Network is allowed. Every command the agent runs inherits the sandbox.
 */

export interface SandboxPaths {
  project: string;
  projectsDir: string;
  /** Mathlib checkouts the project's Lean choice may use. */
  mathlib: string[];
  /** The session's own Pi directory inside the agent directory (default `connectors.telegram.sessionPiDir`). */
  piDir?: string;
  /** Experiment workers use a strict allowlist, excluding sibling trials and held-out evidence. */
  experiment?: boolean;
  /** Worker-local reference paths which remain readable but cannot be modified. */
  readOnly?: string[];
}

const real = (path: string) => { try { return realpathSync(path); } catch { return path; } };
const quote = (path: string) => `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Every folder strictly between `root` and `path`, for the stat-only rule. */
function ancestorsWithin(root: string, path: string): string[] {
  const out: string[] = [];
  for (let dir = dirname(path); dir !== root && dir !== parse(dir).root; dir = dirname(dir)) {
    if (relative(root, dir).startsWith('..')) break;
    out.push(dir);
  }
  return out;
}

export function sandboxProfile(paths: SandboxPaths): string {
  if (paths.experiment) return experimentSandboxProfile(paths);
  const settings = config().sandbox;
  const deny = real(expandHome(settings.denyReadUnder));
  const repo = real(dirname(shippedConfigPath()));
  const nodePrefix = real(dirname(dirname(real(process.execPath))));
  const readable = [
    real(paths.projectsDir), repo, real(agentDir()), real(dirname(elanBin())), nodePrefix,
    // The user's own configuration, so a session reads the same settings as the terminal.
    real(dirname(expandHome(config().paths.userConfig))), ...(process.env[configEnv] ? [real(expandHome(process.env[configEnv]))] : []),
    ...paths.mathlib.map(real), ...settings.allowRead.map(path => real(expandHome(path))),
    ...settings.allowReadWrite.map(path => real(expandHome(path))),
  ];
  const agent = real(agentDir());
  const writable = [
    real(paths.project), real(tmpdir()), '/private/tmp', '/dev',
    join(agent, paths.piDir ?? config().connectors.telegram.sessionPiDir),
    ...settings.agentWritable.map(name => join(agent, name)),
    ...settings.allowReadWrite.map(path => real(expandHome(path))),
  ];
  const unreadable = [...settings.agentUnreadable.map(name => join(agent, name)), real(stateDir())];
  // Files a trusted project loads in a terminal session, outside the sandbox (Pi trusts a folder, not its contents).
  const project = real(paths.project);
  const protectedFiles = settings.protectedProjectFiles.map(name => join(project, name));
  const metadata = [...new Set(readable.flatMap(path => ancestorsWithin(deny, path)))];
  return [
    '(version 1)',
    '(allow default)',
    `(deny file-read* (subpath ${quote(deny)}))`,
    `(allow file-read* (literal ${quote(deny)})${readable.map(path => ` (subpath ${quote(path)})`).join('')})`,
    ...(metadata.length ? [`(allow file-read-metadata${metadata.map(path => ` (literal ${quote(path)})`).join('')})`] : []),
    '(deny file-write* (subpath "/"))',
    `(allow file-write*${writable.map(path => ` (subpath ${quote(path)})`).join('')})`,
    // Last, so it wins over the agent directory being readable: stored credentials and the bot's state.
    `(deny file-read* file-write*${[...new Set(unreadable)].map(path => ` (subpath ${quote(path)})`).join('')})`,
    // The .pi folder itself may not be renamed, removed or replaced by a link; what it holds is checked by path.
    `(deny file-write* (literal ${quote(join(project, '.pi'))})${protectedFiles.map(path => ` (subpath ${quote(path)})`).join('')})`,
    ...settings.denyExec.map(program => `(deny process-exec (literal ${quote(program)}))`),
    ...readOnlyRules(paths),
    '',
  ].join('\n');
}

/** No project/agent-root read grant: even when the repo contains .theoria, test artifacts remain unreadable. */
function experimentSandboxProfile(paths: SandboxPaths): string {
  const repo = real(dirname(shippedConfigPath()));
  const agent = real(agentDir());
  const workspace = real(paths.project);
  const readonly = [workspace, ...paths.mathlib.map(real), join(repo, 'bin'), join(repo, 'packages'), join(repo, 'node_modules'),
    real(dirname(elanBin())), real(dirname(dirname(process.execPath))),
    ...['/System', '/Library', '/usr', '/opt/homebrew', '/bin', '/sbin', '/dev', '/private/etc', '/private/preboot', '/private/var/db', '/private/var/run'],
    ...['lean-envs', 'lean-lsp-mcp', 'benchmarks/envs', 'benchmarks/tools'].map(path => join(agent, path))];
  const writable = [workspace, join(agent, paths.piDir ?? 'experiment-pi')];
  const literals = ['package.json', 'package-lock.json', 'theoria.config.json', 'tsconfig.json'].map(path => join(repo, path));
  return ['(version 1)', '(allow default)', '(deny file-read* file-write* (subpath "/"))',
    '(allow file-read* (literal "/"))', // dyld opens the filesystem root before locating its shared cache.
    `(allow file-read*${readonly.map(path => ` (subpath ${quote(path)})`).join('')}${literals.map(path => ` (literal ${quote(path)})`).join('')})`,
    `(allow file-read* file-write*${writable.map(path => ` (subpath ${quote(path)})`).join('')})`,
    '(allow file-write* (literal "/dev/null"))', // Git/Lake open the null device read-write when probing dependency remotes.
    '(allow file-read-metadata)',
    `(deny file-write* (subpath ${quote(join(workspace, 'inputs'))}))`,
    ...config().sandbox.denyExec.map(program => `(deny process-exec (literal ${quote(program)}))`), ...readOnlyRules(paths), ''].join('\n');
}

function readOnlyRules(paths: SandboxPaths): string[] {
  const root = real(paths.project);
  return [...new Set((paths.readOnly ?? []).map(real))].flatMap(path => {
    const inside = relative(root, path);
    if (!inside || inside === '..' || inside.startsWith('../') || isAbsolute(inside)) throw new Error('Read-only references must be inside the worker workspace.');
    return [`(deny file-write* (subpath ${quote(path)}))`,
      ...ancestorsWithin(root, path).map(parent => `(deny file-write* (literal ${quote(parent)}))`)];
  });
}

/** Writes the profile for a project and returns its path. */
export function writeSandboxProfile(paths: SandboxPaths): string {
  const profile = sandboxProfile(paths);
  const dir = join(stateDir(), 'sandbox');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${createHash('sha256').update(paths.project).digest('hex').slice(0, 16)}.sb`);
  writeFileSync(file, profile, { mode: 0o600 });
  return file;
}

export const sandboxExec = '/usr/bin/sandbox-exec';
