import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

/**
 * The tool guard for sessions `theoria bot` starts. File tools may read inside the projects folder and change
 * files only inside their own project. The sandbox enforces this for everything, `bash` included; the guard makes
 * a file tool's refusal a clear message to the agent rather than an operating-system error.
 */

const fileTools = new Set(['read', 'write', 'edit', 'ls', 'grep', 'find']);
const writingTools = new Set(['write', 'edit']);

/** The real path of `path`, through its nearest existing ancestor when it does not exist yet. */
export function realTarget(path: string): string {
  let existing = path;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  try { return resolve(realpathSync(existing), relative(existing, path)); } catch { return path; }
}

const within = (root: string, path: string) => {
  const inside = relative(root, path);
  return inside === '' || (!inside.startsWith('..') && !isAbsolute(inside));
};

/** Why a tool call is refused, or undefined when it may run. */
export function guardToolCall(toolName: string, input: Record<string, unknown>, cwd: string, project: string, projectsDir: string): string | undefined {
  if (!fileTools.has(toolName)) return undefined;
  const raw = typeof input.path === 'string' && input.path ? input.path : '.';
  const target = realTarget(resolve(cwd, raw));
  const root = realTarget(writingTools.has(toolName) ? project : projectsDir);
  if (within(root, target)) return undefined;
  return `${toolName} on ${raw} was refused: from Telegram, Theoria may ${writingTools.has(toolName) ? 'change files only in this project' : 'read only inside the projects folder'} (${root}).`;
}

/**
 * Names of the environment variables a bot session's bash must not see: `sandbox.secretEnvPattern` (API keys, tokens,
 * the credential broker's address and token). The Pi process keeps them to call its model; the agent's commands run
 * without them, so `env` or a script cannot read and send them anywhere.
 */
export function secretNames(env: NodeJS.ProcessEnv, pattern: string): string[] {
  const match = new RegExp(pattern);
  return Object.keys(env).filter(name => match.test(name) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)).sort();
}

/** A bash command with the secret variables unset first. */
export const withoutSecrets = (command: string, names: string[]) => (names.length ? `unset ${names.join(' ')}; ${command}` : command);
