import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { config } from '@theoria/shared/config';
import { agentDir, projectPath } from '@theoria/shared/paths';

/**
 * A choice is a version, never a path: `{ mathlib: "v4.28.0" }` (its Lean follows from it), or `{ lean: "4.27.0" }`
 * for Lean alone. It is resolved to an installed toolchain and checkout each time it is used.
 */
/** With Mathlib, add-ons (`lean.extras`) may be on: `{ mathlib: "v4.28.0", extras: ["hammer"] }`. */
export type Selection = { mathlib: string; extras?: string[] } | { lean: string };

export type Scope = 'project' | 'global';

const globalFile = () => join(agentDir(), config().lean.settingsFile);
const projectFile = (cwd: string) => projectPath(cwd, config().lean.settingsFile);

function read(path: string): Selection | undefined {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (typeof value.mathlib === 'string' && value.mathlib) {
      const extras = Array.isArray(value.extras) ? value.extras.filter((entry): entry is string => typeof entry === 'string') : [];
      return { mathlib: value.mathlib, ...(extras.length ? { extras } : {}) };
    }
    if (typeof value.lean === 'string' && value.lean) return { lean: value.lean };
  } catch { /* absent or unreadable: no choice */ }
  return undefined;
}

/** The project's choice wins; a project without one uses the global default. */
export function selectionFor(cwd: string): { selection?: Selection; scope?: Scope } {
  const project = read(projectFile(cwd));
  if (project) return { selection: project, scope: 'project' };
  const global = read(globalFile());
  return global ? { selection: global, scope: 'global' } : {};
}

export function save(cwd: string, scope: Scope, selection: Selection | undefined) {
  const path = scope === 'project' ? projectFile(cwd) : globalFile();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(selection ?? {}, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * A Lean project of its own (a `lean-toolchain` beside a lakefile, in the working directory or above it) defines its
 * Lean and dependencies itself. Theoria does not override that, since two sources of truth would disagree.
 */
export function leanProject(cwd: string): { root: string; toolchain: string } | undefined {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const toolchain = join(dir, 'lean-toolchain');
    if (existsSync(toolchain) && (existsSync(join(dir, 'lakefile.lean')) || existsSync(join(dir, 'lakefile.toml')))) {
      return { root: dir, toolchain: readFileSync(toolchain, 'utf8').trim() };
    }
    if (dir === parse(dir).root) return undefined;
  }
}
