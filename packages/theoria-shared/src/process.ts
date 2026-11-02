import childProcess, { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from './config.ts';
import { withElan } from './paths.ts';

export interface RunResult { code: number | null; stdout: string; stderr: string; timedOut: boolean }

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Start from `env` alone instead of this process's environment (plus `env`). */
  replaceEnv?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** On Unix, stop descendants too (latexmk starts compiler/bibliography subprocesses). */
  killGroup?: boolean;
  /** Called with each non-empty output line, for progress. */
  onLine?: (line: string) => void;
}

export const seconds = (value: number) => value * 1000;
export const minutes = (value: number) => value * 60_000;

/** A workflow-scoped macOS idle-sleep assertion; release is idempotent and the assertion dies with this process. */
export function keepAwake(enabled: boolean, notify: (message: string) => void = () => {}): () => void {
  if (!enabled || process.platform !== 'darwin') return () => {};
  const child = childProcess.spawn('/usr/bin/caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
  child.on('error', () => notify('caffeinate could not start; the Mac may sleep during the workflow.'));
  child.unref();
  let released = false;
  return () => { if (!released) { released = true; child.kill(); } };
}

/**
 * Runs a program as argv, never through a shell, with a time limit and output bounded by `process.maxOutputBytes`.
 * elan's directory is on its PATH, so `lean`, `lake` and `elan` resolve. A program that cannot start resolves with
 * `code: null` and the reason in `stderr`, rather than throwing.
 */
export function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  if (options.signal?.aborted) return Promise.resolve({ code: null, stdout: '', stderr: 'Cancelled before starting.', timedOut: false });
  const limit = config().process.maxOutputBytes;
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...(options.replaceEnv ? {} : process.env), ...options.env, PATH: withElan(options.env?.PATH ?? process.env.PATH) },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: !!options.killGroup && process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const take = (current: string, chunk: Buffer) => (current.length < limit ? current + chunk.toString('utf8') : current);
    const lines = (chunk: Buffer) => {
      if (!options.onLine) return;
      for (const line of chunk.toString('utf8').split(/[\r\n]+/)) if (line.trim()) options.onLine(line.trim());
    };
    child.stdout.on('data', chunk => { stdout = take(stdout, chunk); lines(chunk); });
    child.stderr.on('data', chunk => { stderr = take(stderr, chunk); lines(chunk); });
    const abort = () => {
      if (options.killGroup && process.platform !== 'win32' && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* it may have exited */ }
      }
      child.kill('SIGKILL');
    };
    const timer = options.timeoutMs ? setTimeout(() => { timedOut = true; abort(); }, options.timeoutMs) : undefined;
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const finish = (result: RunResult) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    child.on('error', error => finish({ code: null, stdout, stderr: stderr || error.message, timedOut }));
    child.on('close', code => finish({ code, stdout, stderr, timedOut }));
  });
}

/** Own all temporary files a Lean/Lake invocation (including its children) creates. The parent may be a
 * sandbox's scratch directory; never change process.env or remove anything outside this fresh directory.
 * run() settles on close, after cancellation/timeout has killed the process group and closed its pipes.
 */
export async function runWithTemp(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  if (options.signal?.aborted) return run(command, args, options);
  const directory = realpathSync(mkdtempSync(join(options.env?.TMPDIR ?? tmpdir(), 'theoria-process-')));
  try {
    return await run(command, args, { ...options, killGroup: true, env: { ...options.env, TMPDIR: directory } });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * This process's environment without anything that chooses a Lean or a library path (ELAN_TOOLCHAIN, LEAN_PATH,
 * LAKE*): for Lean that must use a Lean project's own toolchain and dependencies, not a session's Lean choice.
 */
export function hermeticLeanEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^(ELAN_TOOLCHAIN|LEAN_.*|LAKE.*)$/.test(key) && key !== 'LEAN_ABORT_ON_PANIC') continue;
    out[key] = value;
  }
  return out;
}

/** Sandboxed dependency probes must use the checkout's own remotes, not global Git includes/URL rewrites. */
export function isolatedGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(env).filter(([key]) => key !== 'GIT_CONFIG' && !key.startsWith('GIT_CONFIG_'))),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

/** The last lines of a failure's output, for an error message. */
export const lastLines = (text: string, chars: number, count: number) =>
  text.trim().split('\n').filter(Boolean).slice(-count).join(' ').slice(0, chars);
