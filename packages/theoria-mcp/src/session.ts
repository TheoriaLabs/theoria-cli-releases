import type { ExtensionContext, ExtensionFactory, LoadedMcpConfig } from '@earendil-works/pi-coding-agent';
import { loadConfig } from '@theoria/shared/config';
import { activeComponents, currentProfile } from '@theoria/shared/harness';
import { projectType, projectTypes } from '@theoria/shared/project';
import { forProjectType, type LeftOut } from './filter.ts';
import { piAgentDir, piBuiltInExtensions, piMcpConfig, type PiMcpConfigModule } from './pi.ts';

/** The servers Theoria manages (and starts with `theoria mcp-launch`): only Mathlib search for now. */
export const managedServers = (settings = loadConfig()) => [settings.leanSearch.server];

let lastLeftOut: LeftOut[] = [];
/** The servers the current session left out, and why. */
export const leftOutServers = () => lastLeftOut;

/**
 * Pi's `mcp.json` (global, then the trusted project's), filtered by the session's project type. The configuration is
 * read again each time, so a change `/project servers` saved applies at the next session start or `/reload`.
 */
export function loadForSession(pi: PiMcpConfigModule, ctx: Pick<ExtensionContext, 'cwd' | 'isProjectTrusted'>): LoadedMcpConfig {
  // The harness profile first: without the mcp component no server starts, without search not Mathlib search.
  let components;
  try { components = activeComponents(); } catch (error) { return { servers: [], errors: [error instanceof Error ? error.message : String(error)] }; }
  if (!components.has('mcp')) { lastLeftOut = []; return { servers: [], errors: [] }; }
  let loaded = withoutSearch(pi.loadMcpConfig({ agentDir: piAgentDir(), cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() }), components.has('search'));
  let settings;
  try { settings = loadConfig(); } catch (error) {
    lastLeftOut = [];
    return { ...loaded, errors: [...loaded.errors, `Theoria's settings could not be read, so no project-type filter applies: ${error instanceof Error ? error.message : String(error)}`] };
  }
  // Existing installations retain their original mcp.json timeout. Apply the configured minimum at
  // session load too, preserving explicitly longer windows and leaving foreign launchers alone.
  loaded = { ...loaded, servers: loaded.servers.map(entry => entry.name === settings.leanSearch.server
    && 'command' in entry.config && entry.config.args?.includes(settings.mcp.launchSubcommand)
    && entry.config.args.includes(settings.leanSearch.server)
    ? { ...entry, config: { ...entry.config, timeout: Math.max(entry.config.timeout ?? 0, settings.leanSearch.requestTimeoutSeconds) } }
    : entry) };
  let type;
  try { type = projectType(ctx.cwd); } catch (error) {
    lastLeftOut = [];
    return { ...loaded, errors: [...loaded.errors, `${error instanceof Error ? error.message : String(error)} No project-type filter applies.`] };
  }
  const current = (settings.projectTypes as unknown as ReturnType<typeof projectTypes>)[type.type] ?? type.settings;
  const extra = currentProfile().leanLspTools;
  const selected = { ...current, mcpServers: current.mcpServers.map(entry => entry.server === settings.leanSearch.server
    ? { ...entry, directTools: [...new Set([...entry.directTools, ...extra])] } : entry) };
  const result = forProjectType(loaded, current.name, selected, managedServers(settings));
  lastLeftOut = result.leftOut;
  return result.config;
}

function withoutSearch(loaded: LoadedMcpConfig, search: boolean): LoadedMcpConfig {
  if (search) return loaded;
  const server = loadConfig().leanSearch.server;
  return { ...loaded, servers: loaded.servers.filter(entry => entry.name !== server) };
}

/**
 * Gives Pi's built-in MCP extension Theoria's loader. It stays Pi's extension, `builtin:mcp`: `/mcp`, `pi config`
 * and `-builtin:mcp` work as in Pi, and no other extension takes its place. Call before Pi's `main`.
 */
export async function useProjectTypeMcp(): Promise<void> {
  const { createMcpExtension } = await import('@earendil-works/pi-coding-agent');
  const config = await piMcpConfig();
  const builtIns = await piBuiltInExtensions();
  const mcp = builtIns.find(extension => extension.name === 'mcp');
  if (!mcp) throw new Error('Pi has no built-in MCP extension to configure; check the Pi version against packages/theoria-mcp.');
  const factory: ExtensionFactory = createMcpExtension({ loadConfig: ctx => loadForSession(config, ctx) });
  mcp.factory = factory;
}
