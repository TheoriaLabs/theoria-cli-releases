import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getAgentDir, type ExtensionFactory, type LoadedMcpConfig, type McpServerConfig } from '@earendil-works/pi-coding-agent';

/**
 * The parts of Pi's MCP support that Pi does not export: its config loader and editors, and its list of built-in
 * extensions. They are imported by file, from the installed Pi, so Theoria reads `mcp.json` exactly as Pi does and
 * gives Pi's own MCP extension (and so Pi's own `/mcp`) a different loader instead of replacing it. Pi is pinned in
 * package.json; `test/pi.test.ts` fails when an upgrade moves or reshapes any of this.
 */

export interface PiMcpConfigModule {
  loadMcpConfig(options: { agentDir: string; cwd: string; projectTrusted: boolean }): LoadedMcpConfig;
  addMcpServerConfig(path: string, name: string, config: McpServerConfig): boolean;
  removeMcpServerConfig(path: string, name: string): boolean;
}

export interface BuiltInExtension { name: string; factory: ExtensionFactory; replaceable?: boolean; builtin?: boolean }

const dist = () => dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
const internal = <T>(path: string) => import(pathToFileURL(join(dist(), path)).href) as Promise<T>;

export const piMcpConfig = () => internal<PiMcpConfigModule>('extensions/mcp/config.js');
export const piBuiltInExtensions = async () => (await internal<{ builtInExtensions: BuiltInExtension[] }>('extensions/index.js')).builtInExtensions;

/** Pi's agent directory, where its global `mcp.json` is: a bot session's is its own (`bot-pi`). */
export const piAgentDir = () => getAgentDir();
export const globalMcpFile = (agentDir = piAgentDir()) => join(agentDir, 'mcp.json');
