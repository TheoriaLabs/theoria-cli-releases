import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, reloadConfig, userConfigPath, type TheoriaConfig } from '@theoria/shared/config';
import type { ProjectTypeSettings } from '@theoria/shared/project';

/**
 * Changing which MCP servers a project type loads (`/project servers`): the type's `mcpServers` and `otherServers`,
 * saved to the user config file, checked as a whole before it is written.
 */

type TypeServers = Pick<ProjectTypeSettings, 'mcpServers' | 'otherServers'>;

/** The tools a shipped type declares directly for `server`, so listing it again restores the shipped choice. */
export function shippedDirectTools(server: string): string[] {
  const shipped = loadConfig({ override: undefined }).projectTypes as unknown as Record<string, Partial<TypeServers>>;
  for (const type of Object.values(shipped)) {
    const found = type.mcpServers?.find(item => item.server === server);
    if (found) return [...found.directTools];
  }
  return [];
}

/** Saves the type's MCP choice to the user config and returns the configuration as read again. */
export function saveTypeServers(type: string, next: TypeServers, path = userConfigPath()): TheoriaConfig {
  let user: Record<string, unknown> = {};
  if (existsSync(path)) user = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const types = { ...(user.projectTypes as Record<string, Record<string, unknown>> | undefined) };
  types[type] = { ...types[type], mcpServers: next.mcpServers.map(item => ({ server: item.server, directTools: [...item.directTools] })), otherServers: next.otherServers };
  const updated = { ...user, projectTypes: types };
  loadConfig({ override: updated });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
  return reloadConfig();
}
