import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import type { McpServerConfig } from '@earendil-works/pi-coding-agent';
import { globalMcpFile, piMcpConfig, type LaunchPlan } from '@theoria/mcp/api';
import { config, expandHome, shippedConfigPath } from '@theoria/shared/config';
import { agentDir, projectRoot, withElan } from '@theoria/shared/paths';
import { lastLines, run, seconds } from '@theoria/shared/process';
import { projectType } from '@theoria/shared/project';
import { currentProfile } from '@theoria/shared/harness';
import { label, ready, resolve as resolveEnvironment, type Environment } from './environment.ts';

/**
 * Mathlib search: lean-lsp-mcp as the MCP server `leanSearch.server`, through Pi's `/mcp`.
 *
 * `/lean search install` puts the pinned version, with a Python of its own, in Theoria's agent directory (so a bot
 * session can read it and nothing is downloaded while an agent runs) and adds the server to Pi's `mcp.json`, where
 * `/mcp` turns it on or off. Pi starts it as `theoria mcp-launch <server>` in the session's folder; `leanSearchPlan`
 * then points it at the session's Mathlib checkout or add-on workspace, or says why it cannot run.
 */

const settings = () => config().leanSearch;
export const searchDir = () => join(agentDir(), settings().installDir);
const binary = () => join(searchDir(), 'bin', settings().package);
const python = () => join(searchDir(), 'tools', settings().package, 'bin', 'python');
const cacheDir = () => join(searchDir(), settings().cacheDir);
const markerFile = () => join(searchDir(), 'installed.json');
const launcher = () => join(dirname(shippedConfigPath()), 'bin', 'theoria.js');

/** The installed version, when the pinned package is installed and its program is there. */
export function installedVersion(): string | undefined {
  try {
    const marker = JSON.parse(readFileSync(markerFile(), 'utf8')) as { package?: string; version?: string };
    return marker.package === settings().package && existsSync(binary()) ? marker.version : undefined;
  } catch { return undefined; }
}

/** uv, from `leanSearch.uvCandidates` or PATH. */
export function findUv(): string | undefined {
  const onPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, 'uv'));
  return [...settings().uvCandidates.map(expandHome), ...onPath].find(path => existsSync(path));
}

/** The `mcp.json` entry Theoria writes. Exposure `hidden`: the project type declares the search tools directly. */
export function serverEntry(): McpServerConfig {
  return {
    command: launcher(),
    args: [config().mcp.launchSubcommand, settings().server],
    exposure: 'hidden',
    description: settings().description,
    timeout: settings().requestTimeoutSeconds,
  };
}

type EntryState = { kind: 'missing' } | { kind: 'foreign' } | { kind: 'ours'; enabled: boolean };

function readServers(path: string): Record<string, Record<string, unknown>> | undefined {
  try { return (JSON.parse(readFileSync(path, 'utf8')) as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers; } catch { return undefined; }
}

/** The server's entry in Pi's global `mcp.json`: missing, someone else's, or Theoria's (and whether it is on). */
export function globalEntry(path = globalMcpFile()): EntryState {
  const entry = readServers(path)?.[settings().server];
  if (!entry) return { kind: 'missing' };
  const args = Array.isArray(entry.args) ? entry.args : [];
  if (!args.includes(config().mcp.launchSubcommand) || !args.includes(settings().server)) return { kind: 'foreign' };
  return { kind: 'ours', enabled: entry.enabled !== false };
}

/** Whether the project's `.pi/mcp.json` turns the server off for this project (`/mcp` → Disable in this project). */
const offInProject = (cwd: string) => readServers(join(projectRoot(cwd), '.pi', 'mcp.json'))?.[settings().server]?.enabled === false;

const listedFor = (cwd: string) => {
  try {
    const type = projectType(cwd);
    return { listed: type.settings.mcpServers.some(item => item.server === settings().server), typeName: type.settings.name };
  } catch { return { listed: false, typeName: 'this' }; }
};

export type SearchState = 'on' | 'off' | 'unavailable' | 'not-installed' | 'not-used' | 'foreign';

/** Where Mathlib search stands for a session in `cwd`, and the line `/lean`, `/project status` and the bot show. */
export async function searchState(cwd: string, environment?: Environment): Promise<{ state: SearchState; line: string }> {
  const head = 'Mathlib search';
  const { listed, typeName } = listedFor(cwd);
  if (!listed) return { state: 'not-used', line: `${head}: not used in ${typeName} projects (/project servers)` };
  const entry = globalEntry();
  if (!installedVersion() || entry.kind === 'missing') return { state: 'not-installed', line: `${head}: not installed (/lean search install)` };
  if (entry.kind === 'foreign') return { state: 'foreign', line: `${head}: the ${settings().server} server in ${globalMcpFile()} is not Theoria's; it is left as it is` };
  if (!entry.enabled) return { state: 'off', line: `${head}: off (/mcp → ${settings().server} → Enable)` };
  if (offInProject(cwd)) return { state: 'off', line: `${head}: off in this project (/mcp)` };
  const plan = await leanSearchPlan(cwd, environment);
  if ('unavailable' in plan) return { state: 'unavailable', line: `${head}: unavailable: ${plan.unavailable}` };
  return { state: 'on', line: `${head}: on · Loogle, Lean Finder, local search · ${label(environment ?? await resolveEnvironment(cwd))} (/mcp)` };
}

/** How `theoria mcp-launch` starts lean-lsp-mcp for a session in `cwd`, or why it cannot. */
export async function leanSearchPlan(cwd: string, known?: Environment): Promise<LaunchPlan> {
  const version = installedVersion();
  if (!version) return { unavailable: `${settings().package} is not installed: /lean search install` };
  if (!existsSync(python())) return { unavailable: `${settings().package} Python environment is missing: /lean search install` };
  const environment = known ?? await resolveEnvironment(cwd);
  let root: string | undefined;
  if (!ready(environment)) return { unavailable: environment.problem ?? 'no Lean environment is chosen (/lean config)' };
  if (environment.source === 'lean-project') root = environment.projectRoot;
  else if (!environment.mathlib) return { unavailable: `${label(environment)} has no Mathlib to search (/lean config)` };
  else root = environment.extras?.find(extra => extra.ready)?.dir ?? environment.mathlib.path;
  if (!root) return { unavailable: 'no Lean project or Mathlib checkout to search' };
  const cache = cacheDir();
  mkdirSync(cache, { recursive: true });
  const disabled = settings().disabledTools.filter(tool => !currentProfile().leanLspTools.includes(tool));
  return {
    command: python(),
    args: [join(dirname(shippedConfigPath()), 'packages/theoria-lean/scripts/search-server.py'), ...(settings().localLoogle ? ['--loogle-local'] : [])],
    cwd: root,
    env: {
      LEAN_PROJECT_PATH: root,
      LEAN_LOG_LEVEL: settings().logLevel,
      LEAN_MCP_DISABLED_TOOLS: disabled.join(','),
      THEORIA_SEARCH_TOP_K: String(settings().topK),
      LEAN_MCP_TOOL_DESCRIPTIONS: JSON.stringify(Object.fromEntries(settings().toolLines.filter(entry => !disabled.includes(entry.tool)).map(entry => [entry.tool,
        `${entry.line}.${entry.tool === 'lean_local_search' ? ' Includes allowed native dependencies and Unicode names; an incomplete index is not proof of absence.' : ''}${entry.tool === 'lean_loogle' ? ' Returns diagnostic headers and suggestions; after no exact matches it may try one explicitly identified broader query. Use broaden=false to disable broadening.' : ''}${['lean_loogle', 'lean_leanfinder'].includes(entry.tool)
          ? ` num_results defaults to ${settings().topK}; explicit values override it. ${settings().batchGuideline}` : ''}`]))),
      ...(settings().localLoogle ? { LEAN_LOOGLE_LOCAL: 'true' } : {}),
      LEAN_LOOGLE_CACHE_DIR: join(cache, 'loogle'),
      XDG_CACHE_HOME: cache,
      // The tool's own files stay as installed: a session (in the sandbox, read-only to it) writes only the cache.
      PYTHONDONTWRITEBYTECODE: '1',
      PATH: withElan(process.env.PATH),
    },
  };
}

/** Installs the pinned lean-lsp-mcp and adds its `mcp.json` entry. Returns what was done, for the user. */
export async function installSearch(options: { signal?: AbortSignal; onLine?: (line: string) => void } = {}): Promise<string> {
  const uv = findUv();
  if (!uv) throw new Error(`uv is not installed (looked in ${settings().uvCandidates.join(', ')} and PATH). Install it from https://docs.astral.sh/uv/ and run /lean search install again.`);
  const dir = searchDir();
  const uvCache = join(dir, 'uv-cache');
  mkdirSync(dir, { recursive: true });
  const spec = `${settings().package}==${settings().version}`;
  const result = await run(uv, ['tool', 'install', '--force', '--compile-bytecode', '--python', settings().python, spec], {
    env: {
      UV_TOOL_DIR: join(dir, 'tools'), UV_TOOL_BIN_DIR: join(dir, 'bin'), UV_PYTHON_INSTALL_DIR: join(dir, 'python'),
      UV_CACHE_DIR: uvCache, UV_PYTHON_PREFERENCE: 'only-managed',
    },
    timeoutMs: seconds(settings().installTimeoutSeconds), ...options,
  });
  rmSync(uvCache, { recursive: true, force: true });
  if (result.timedOut) throw new Error(`Installing ${spec} did not finish within ${settings().installTimeoutSeconds}s.`);
  if (result.code !== 0) throw new Error(`Installing ${spec} failed: ${lastLines(result.stderr || result.stdout, 400, 4)}`);
  const check = await run(binary(), ['--version'], { timeoutMs: seconds(60) });
  if (check.code !== 0 || !`${check.stdout}${check.stderr}`.includes(settings().version)) {
    throw new Error(`${spec} was installed but ${binary()} --version did not report ${settings().version}: ${lastLines(check.stderr || check.stdout, 300, 3)}`);
  }
  writeFileSync(markerFile(), `${JSON.stringify({ package: settings().package, version: settings().version, python: settings().python, installedAt: new Date().toISOString() }, null, 2)}\n`);
  const entry = globalEntry();
  const file = globalMcpFile();
  if (entry.kind === 'foreign') return `Installed ${spec}. ${file} already has a ${settings().server} server that is not Theoria's, so it was left as it is.`;
  if (entry.kind === 'missing') (await piMcpConfig()).addMcpServerConfig(file, settings().server, serverEntry());
  return `Installed ${spec} in ${dir}${entry.kind === 'missing' ? ` and added the ${settings().server} server to ${file}` : ''}. `
    + 'It loads in the project types that list it; /mcp shows it and turns it off.';
}

/** Removes the installation and Theoria's `mcp.json` entry (not someone else's of the same name). */
export async function removeSearch(): Promise<string> {
  const entry = globalEntry();
  if (entry.kind === 'ours') (await piMcpConfig()).removeMcpServerConfig(globalMcpFile(), settings().server);
  rmSync(searchDir(), { recursive: true, force: true });
  return `Removed ${settings().package} from ${searchDir()}${entry.kind === 'ours' ? ` and the ${settings().server} server from ${globalMcpFile()}` : ''}.`;
}

/** The global `mcp.json` entry a bot session's own Pi directory gets: Theoria's server only, as the terminal has it. */
export function sessionEntry(): Record<string, unknown> | undefined {
  const entry = readServers(join(agentDir(), 'mcp.json'))?.[settings().server];
  // The launcher of the Theoria that starts the session, not the one that installed the entry: a sandboxed session
  // can read only its own Theoria (another checkout or worktree is outside the sandbox).
  return entry && globalEntry(join(agentDir(), 'mcp.json')).kind === 'ours'
    ? { ...entry, command: launcher(), timeout: Math.max(typeof entry.timeout === 'number' ? entry.timeout : 0, settings().requestTimeoutSeconds) }
    : undefined;
}
