import type { LoadedMcpConfig, McpServerEntry } from '@earendil-works/pi-coding-agent';
import type { ProjectTypeSettings } from '@theoria/shared/project';

/**
 * Which MCP servers a session loads, by its project type. Pure: Pi's loaded config in, the session's config out.
 *
 * - A server the project defines in its own `.pi/mcp.json` (not an override of a global one) always loads.
 * - A server the type lists loads, with the type's `directTools` declared to the model; the entry's own
 *   `toolExposure` (set by the user in `mcp.json`) wins over them.
 * - A server Theoria manages that the type does not list is left out.
 * - Any other server (one the user added) loads unless the type's `otherServers` is `hide`.
 */

export interface LeftOut { name: string; reason: string }

export interface ForType { config: LoadedMcpConfig; leftOut: LeftOut[] }

export function forProjectType(loaded: LoadedMcpConfig, typeName: string, type: Pick<ProjectTypeSettings, 'mcpServers' | 'otherServers'>, managed: readonly string[]): ForType {
  const leftOut: LeftOut[] = [];
  const servers: McpServerEntry[] = [];
  for (const entry of loaded.servers) {
    if (entry.scope === 'project' && !entry.override) { servers.push(entry); continue; }
    const listed = type.mcpServers.find(item => item.server === entry.name);
    if (listed) {
      const direct = Object.fromEntries(listed.directTools.map(tool => [tool, 'direct' as const]));
      const toolExposure = { ...direct, ...(entry.config.toolExposure ?? {}) };
      servers.push(Object.keys(toolExposure).length ? { ...entry, config: { ...entry.config, toolExposure } } : entry);
    } else if (managed.includes(entry.name)) {
      leftOut.push({ name: entry.name, reason: `not used in ${typeName} projects` });
    } else if (type.otherServers === 'hide') {
      leftOut.push({ name: entry.name, reason: `not listed for ${typeName} projects (/project servers)` });
    } else {
      servers.push(entry);
    }
  }
  return { config: { ...loaded, servers }, leftOut };
}
