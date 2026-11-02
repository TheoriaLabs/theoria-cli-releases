import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { config } from '@theoria/shared/config';
import { projectRoot } from '@theoria/shared/paths';

export interface PaperSettings { main: string; engine: string }
export interface BuildResult {
  id: string; at: string; status: 'ok' | 'errors' | 'unavailable' | 'timeout' | 'cancelled';
  main: string; engine: string; compiler?: string; latexmk?: string; durationMs: number;
  pdf?: string; log?: string; errors: string[]; warnings: string[]; missing: string[];
  inputs: Record<string, string>; pdfHash?: string;
}
export interface PaperState {
  lastBuild?: BuildResult;
  lastSuccess?: BuildResult;
  workflow?: { mode: 'create' | 'update'; at: string; status: string; request: string; snapshot?: string; evidence: string; costUsd: number };
}

export const rootOf = (cwd: string) => realpathSync(projectRoot(cwd));
export const stateDir = (cwd: string) => projectFile(cwd, join(config().paths.projectDir, config().latex.stateDir));
export const buildId = () => `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
export function hashFile(file: string): string {
  const fd = openSync(file, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  try { for (;;) { const count = readSync(fd, buffer); if (!count) break; hash.update(buffer.subarray(0, count)); } return hash.digest('hex'); }
  finally { closeSync(fd); }
}
export const shown = (cwd: string, file: string) => relative(rootOf(cwd), file);

/** Resolve a project file, including the real path of existing ancestors (also for files not yet created). */
export function projectFile(cwd: string, path: string): string {
  const root = rootOf(cwd);
  const file = resolve(root, path);
  if (file === root || !file.startsWith(root + sep)) throw new Error(`${path} must be a file inside this project.`);
  let ancestor = file;
  while (!existsSync(ancestor)) {
    if (lstatSync(ancestor, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`${path} contains a dangling link.`);
    ancestor = dirname(ancestor);
  }
  const real = realpathSync(ancestor);
  if (real !== root && !real.startsWith(root + sep)) throw new Error(`${path} points outside this project.`);
  return file;
}

export function paperSettings(cwd: string): PaperSettings {
  const settings = config().latex;
  const path = projectFile(cwd, join(config().paths.projectDir, settings.settingsFile));
  const value = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as Partial<PaperSettings> : {};
  if (Object.keys(value).some(key => !['main', 'engine'].includes(key))) throw new Error(`${path}: only main and engine are settings.`);
  const result = { main: value.main ?? join(settings.paperDir, settings.mainFile), engine: value.engine ?? settings.engine };
  if (typeof result.main !== 'string' || !result.main.endsWith('.tex') || isAbsolute(result.main)) throw new Error('The paper entry point must be a project-relative .tex file.');
  if (!settings.engines.includes(result.engine)) throw new Error(`Choose one of ${settings.engines.join(', ')}.`);
  projectFile(cwd, result.main);
  return result;
}

export function saveSettings(cwd: string, value: PaperSettings) {
  if (!value.main.endsWith('.tex') || isAbsolute(value.main) || !config().latex.engines.includes(value.engine)) throw new Error('Invalid paper entry point or compiler.');
  projectFile(cwd, value.main);
  writeJson(projectFile(cwd, join(config().paths.projectDir, config().latex.settingsFile)), value);
}

export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readState(cwd: string): PaperState {
  try { return JSON.parse(readFileSync(join(stateDir(cwd), 'state.json'), 'utf8')); } catch { return {}; }
}
export function saveState(cwd: string, patch: Partial<PaperState>) { writeJson(join(stateDir(cwd), 'state.json'), { ...readState(cwd), ...patch }); }

/** Source and figure files in a paper. Exclude generated caches; never follow directory links. */
export function paperFiles(cwd: string, settings = paperSettings(cwd)): string[] {
  const root = dirname(projectFile(cwd, settings.main));
  const out: string[] = [];
  const skip = new Set(config().workflows.target.skipDirs);
  const walk = (dir: string, depth: number) => {
    if (depth > config().workflows.target.maxDepth) throw new Error('The paper source tree is too deep.');
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || skip.has(name)) continue;
      const file = join(dir, name);
      const stat = lstatSync(file);
      if (stat.isSymbolicLink()) { projectFile(cwd, shown(cwd, file)); continue; }
      if (stat.isDirectory()) walk(file, depth + 1);
      else if (/\.(tex|bib|sty|cls|bst|png|jpe?g|pdf|svg|eps|csv|md)$/i.test(name)) out.push(file);
      if (out.length > config().workflows.target.maxFiles) throw new Error('Too many files in the paper source tree.');
    }
  };
  walk(root, 0);
  return out;
}

/** A previous PDF is current only for exactly these input contents and paper/compiler selection. */
export function pdfCurrent(cwd: string, build: BuildResult | undefined, settings = paperSettings(cwd)): boolean {
  if (!build?.pdf || build.status !== 'ok' || build.main !== settings.main || build.engine !== settings.engine) return false;
  try {
    if (hashFile(projectFile(cwd, build.pdf)) !== build.pdfHash) return false;
    return Object.entries(build.inputs).every(([file, hash]) => hashFile(isAbsolute(file) ? file : projectFile(cwd, file)) === hash);
  } catch { return false; }
}
