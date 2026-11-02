import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { config, expandHome } from './config.ts';
import { projectPath } from './paths.ts';
import { lastLines, run, seconds } from './process.ts';

/**
 * A project's type, which decides the Theoria workflows it gets (`projectTypes` in the configuration).
 *
 * Decided in this order: `theoria --project-type <type>` for one run (the launcher passes it on as
 * `THEORIA_PROJECT_TYPE`), then the project's `.theoria/project.json`, then `project.defaultType`.
 */

export const projectTypeEnv = 'THEORIA_PROJECT_TYPE';
/** The directory `theoria` was started in, set by the launcher: new projects are created relative to it. */
export const launchDirEnv = 'THEORIA_LAUNCH_DIR';

export interface ProjectTypeSettings {
  name: string;
  description: string;
  workflows: string[];
  lean: boolean;
  latex: boolean;
  scaffold: string[];
  progress: 'lean-goal' | 'none';
  /** MCP servers this type loads, each with the tools declared to the model directly. */
  mcpServers: readonly { server: string; directTools: readonly string[] }[];
  /** Whether servers the user added and the type does not list still load. */
  otherServers: 'show' | 'hide';
}

export interface ProjectType {
  type: string;
  source: 'flag' | 'project' | 'default';
  settings: ProjectTypeSettings;
}

/** The theorem a project works towards, by file (relative to the project) and name. */
export interface ProjectGoal { file: string; theorem: string }

export interface ProjectRecord { name: string; type: string; created: string; goal?: ProjectGoal }

export class ProjectError extends Error {}

/** Every configured type, without `$comment`. */
export function projectTypes(): Record<string, ProjectTypeSettings> {
  const { $comment: _comment, ...types } = config().projectTypes as Record<string, unknown>;
  return types as Record<string, ProjectTypeSettings>;
}

export function assertProjectType(type: string, where: string): void {
  if (!Object.hasOwn(projectTypes(), type)) {
    throw new ProjectError(`${where} names project type "${type}", which is not one of ${Object.keys(projectTypes()).join(', ')}.`);
  }
}

const projectFile = (cwd: string) => projectPath(cwd, config().project.file);

/** The project record in `cwd`, when the folder is a Theoria project. */
export function projectRecord(cwd: string): Partial<ProjectRecord> | undefined {
  try {
    const value = JSON.parse(readFileSync(projectFile(cwd), 'utf8')) as Record<string, unknown>;
    return {
      ...(typeof value.name === 'string' ? { name: value.name } : {}),
      ...(typeof value.type === 'string' && value.type ? { type: value.type } : {}),
      ...(typeof value.created === 'string' ? { created: value.created } : {}),
      ...(isGoal(value.goal) ? { goal: value.goal } : {}),
    };
  } catch { return undefined; }
}

const isGoal = (value: unknown): value is ProjectGoal =>
  typeof value === 'object' && value !== null && typeof (value as ProjectGoal).file === 'string' && typeof (value as ProjectGoal).theorem === 'string';

/** The type a session in `cwd` uses. An unknown type in the flag or the project file is an error, not a fallback. */
export function projectType(cwd: string): ProjectType {
  const flagged = process.env[projectTypeEnv];
  if (flagged) {
    assertProjectType(flagged, `--${config().project.flag}`);
    return { type: flagged, source: 'flag', settings: projectTypes()[flagged]! };
  }
  const saved = projectRecord(cwd)?.type;
  if (saved) {
    assertProjectType(saved, projectFile(cwd));
    return { type: saved, source: 'project', settings: projectTypes()[saved]! };
  }
  const fallback = config().project.defaultType;
  return { type: fallback, source: 'default', settings: projectTypes()[fallback]! };
}

/** Writes the project record, keeping fields already there. A one-run `--project-type` no longer applies. */
export function saveProjectRecord(cwd: string, update: Partial<ProjectRecord>): string {
  if (update.type) assertProjectType(update.type, 'The choice');
  const path = projectFile(cwd);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...projectRecord(cwd), ...update }, null, 2)}\n`, 'utf8');
  delete process.env[projectTypeEnv];
  return path;
}

/**
 * The Theoria projects in a projects folder: its direct subfolders with a project record, by real path, so a
 * symlink cannot make a folder elsewhere look like one of them.
 */
export function listProjects(root: string): { dir: string; record: Partial<ProjectRecord> }[] {
  let names: string[] = [];
  try { names = readdirSync(root); } catch { return []; }
  const realRoot = safeRealpath(root);
  if (!realRoot) return [];
  return names.flatMap(name => {
    const dir = insideProjects(realRoot, join(realRoot, name));
    const record = dir ? projectRecord(dir) : undefined;
    return dir && record ? [{ dir, record }] : [];
  }).sort((a, b) => (b.record.created ?? '').localeCompare(a.record.created ?? ''));
}

const safeRealpath = (path: string) => { try { return realpathSync(path); } catch { return undefined; } };

/**
 * `path` as a real path when it is a folder strictly inside the projects folder `root`, after following symlinks;
 * otherwise undefined. Every project Telegram can reach goes through this.
 */
export function insideProjects(root: string, path: string): string | undefined {
  const realRoot = safeRealpath(root);
  const real = safeRealpath(path);
  if (!realRoot || !real || real === realRoot) return undefined;
  const inside = relative(realRoot, real);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) return undefined;
  try { if (!statSync(real).isDirectory()) return undefined; } catch { return undefined; }
  return real;
}

/** `Legendre's conjecture` → `legendre-conjecture`. */
export const folderName = (name: string) =>
  name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/'s\b/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** Where `/new-project` puts a project: `project.parentDir`, relative to where `theoria` was started. */
export function newProjectDir(name: string, cwd: string): string {
  return join(projectsRoot(process.env[launchDirEnv] ?? cwd), folderName(name));
}

/** The projects folder, `project.parentDir` resolved against a base directory. */
export const projectsRoot = (base: string) => resolve(base, expandHome(config().project.parentDir));

/**
 * Creates a project folder: the project record, a git repository, a `.gitignore` and the type's scaffold folders.
 * A folder that already has files is refused, so nothing is ever overwritten.
 */
export async function createProject(dir: string, name: string, type: string): Promise<{ dir: string; created: string[] }> {
  assertProjectType(type, 'The choice');
  if (!folderName(name)) throw new ProjectError(`"${name}" has no letters or digits to name a folder with.`);
  if (existsSync(dir) && readdirSync(dir).length) throw new ProjectError(`${dir} already exists and is not empty.`);
  mkdirSync(dir, { recursive: true });
  const created: string[] = [];
  const git = await run('git', ['init', '--quiet'], { cwd: dir, timeoutMs: seconds(config().lean.discovery.gitTimeoutSeconds) });
  if (git.code !== 0) throw new ProjectError(`git init failed: ${lastLines(git.stderr, config().lean.install.errorChars, config().lean.install.errorLines)}`);
  created.push('.git');
  writeFileSync(join(dir, '.gitignore'), `${config().project.gitignore.join('\n')}\n`, { flag: 'wx' });
  created.push('.gitignore');
  for (const folder of projectTypes()[type]!.scaffold) {
    mkdirSync(join(dir, folder), { recursive: true });
    created.push(`${folder}/`);
  }
  saveProjectRecord(dir, { name, type, created: new Date().toISOString() });
  created.push(`${config().paths.projectDir}/${config().project.file}`);
  return { dir, created };
}

/**
 * The type of the project a session is starting in, for an extension deciding what to register. Pi creates the
 * extensions again on every session switch and reload, after the working directory is set, so this is current.
 * A broken project file gives `undefined`: nothing type-specific is registered, and theoria-core reports why.
 */
export function startingProjectType(): ProjectType | undefined {
  try { return projectType(process.cwd()); } catch { return undefined; }
}
