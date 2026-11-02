import { existsSync } from 'node:fs';
import { delimiter, dirname, join, parse, relative } from 'node:path';
import { config, expandHome } from './config.ts';

/**
 * Where Theoria keeps things. Each location comes from `paths` in the configuration; the environment variables Pi
 * and elan already define (`PI_CODING_AGENT_DIR`, `ELAN_HOME`) and `THEORIA_LEAN_HOME` still win, so a test or a
 * second installation can point somewhere else without a config file.
 */

export { expandHome };

/**
 * Theoria's own data (Lean choices, caches, user prompts, connector state), normally also Pi's directory, apart from a
 * personal `~/.pi`. A bot session runs Pi in a directory of its own (`PI_CODING_AGENT_DIR`) and names Theoria's in
 * `THEORIA_AGENT_DIR`, so the two can differ.
 */
export const theoriaAgentEnv = 'THEORIA_AGENT_DIR';
export const agentDir = () => process.env[theoriaAgentEnv] ?? process.env.PI_CODING_AGENT_DIR ?? expandHome(config().paths.agentDir);
/** Mathlib versions Theoria installed. */
export const leanHome = () => process.env.THEORIA_LEAN_HOME ?? expandHome(config().paths.leanHome);
export const managedMathlibDir = () => join(leanHome(), config().paths.mathlibDir);
export const elanBin = () => join(process.env.ELAN_HOME ?? expandHome(config().paths.elanHome), 'bin');

/** PATH with elan's proxies on it, so `lean` and `lake` resolve even when only the user's shell profile adds them. */
export function withElan(path = process.env.PATH ?? ''): string {
  const parts = path.split(delimiter).filter(Boolean);
  return parts.includes(elanBin()) ? path : [elanBin(), ...parts].join(delimiter);
}

/** The project a session works in: the nearest ancestor with `.git` or a Theoria project directory, else `cwd`. */
export function projectRoot(cwd: string): string {
  const marker = config().paths.projectDir;
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, marker))) return dir;
    if (dir === parse(dir).root) return cwd;
  }
}

/** A path inside the project's Theoria directory (`.theoria/…`). */
export const projectPath = (cwd: string, ...parts: string[]) => join(projectRoot(cwd), config().paths.projectDir, ...parts);

/** A path as the user would name it: relative to the project, when it is inside it. */
export function shownPath(cwd: string, path: string): string {
  const inside = relative(projectRoot(cwd), path);
  return inside && !inside.startsWith('..') ? inside : path;
}
