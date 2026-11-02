import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname } from 'node:path';
import { config } from '@theoria/shared/config';
import { projectPath, projectRoot } from '@theoria/shared/paths';

/**
 * Storage for the research state, in the project's `.theoria` folder: JSON files written atomically and JSONL files
 * appended to. A terminal session and a bot session may write the same project at once, so every read-modify-write
 * (a run record, a new id) happens under one lock file per project, created exclusively; a lock older than
 * `research.lockStaleSeconds` was left by a crashed process and is taken over.
 */

const settings = () => config().research;
export const researchPath = (cwd: string, ...parts: string[]) => projectPath(cwd, ...parts);
export const projectId = (cwd: string) => basename(projectRoot(cwd));

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Runs `fn` holding the project's research lock. */
export function withLock<T>(cwd: string, fn: () => T): T {
  const path = researchPath(cwd, settings().lockFile);
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + settings().lockWaitSeconds * 1000;
  for (;;) {
    try {
      const fd = openSync(path, 'wx');
      writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let age = 0;
      try { age = Date.now() - statSync(path).mtimeMs; } catch { continue; }
      if (age > settings().lockStaleSeconds * 1000) { try { unlinkSync(path); } catch { /* another process took it */ } continue; }
      if (Date.now() > deadline) throw new Error(`The project's research state is locked by another session (${path}); try again.`);
      pause(50);
    }
  }
  try { return fn(); } finally { try { unlinkSync(path); } catch { /* already gone */ } }
}

export function readJson<T>(path: string): T | undefined {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return undefined; }
}

export function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

export function appendJsonl(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(value)}\n`, 'utf8');
}

export function readJsonl<T>(path: string): T[] {
  let text = '';
  try { text = readFileSync(path, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as T]; } catch { return []; } });
}

/** The next id in a sequence such as `run-001`, `C12`, from the ids in use. */
export function nextId(prefix: string, used: string[], width = 0): string {
  const numbers = used.map(id => (id.startsWith(prefix) ? Number(id.slice(prefix.length)) : NaN)).filter(Number.isFinite);
  const next = (numbers.length ? Math.max(...numbers) : 0) + 1;
  return `${prefix}${String(next).padStart(width, '0')}`;
}

export function sha256(path: string): string | undefined {
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return undefined; }
}

export const now = () => new Date().toISOString();
