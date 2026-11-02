import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { sessionEntry } from '@theoria/pi-lean/api';
import { config, shippedConfigPath } from '@theoria/shared/config';
import { agentDir, theoriaAgentEnv } from '@theoria/shared/paths';
import { launchDirEnv } from '@theoria/shared/project';
import { minutes, seconds } from '@theoria/shared/process';
import { sandboxExec, writeSandboxProfile, type SandboxPaths } from './sandbox.ts';

/** Set in every session `theoria bot` starts: the tool guard turns on, and the terminal notifier stays off. */
export const botSessionEnv = 'THEORIA_BOT_SESSION';

/** An RPC event or response from the session, as Pi writes it. */
export type RpcEvent = Record<string, unknown> & { type?: string; id?: string };

/**
 * One project's Theoria session: `theoria --mode rpc --continue` in the project folder, inside the sandbox, so its
 * conversation carries over between messages and across restarts. Pi's RPC events are re-emitted as `event`; the
 * session stops itself after `connectors.telegram.sessionIdleMinutes` without activity or work.
 */
export class ProjectSession extends EventEmitter {
  readonly dir: string;
  private child: ChildProcess | undefined;
  private ready: Promise<void> | undefined;
  private pending = new Map<string, (event: RpcEvent) => void>();
  private counter = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  /** Whether the agent is working: between `agent_start` and `agent_settled`, or while a workflow reports status. */
  busy = false;
  /** The workflow's latest footer status, while one runs. */
  workflowStatus: string | undefined;

  private paths: Omit<SandboxPaths, 'project'>;
  private env: NodeJS.ProcessEnv;

  constructor(dir: string, paths: Omit<SandboxPaths, 'project'>, env: NodeJS.ProcessEnv) {
    super();
    this.dir = dir;
    this.paths = paths;
    this.env = env;
  }

  /** The environment for the next `start()`. */
  setEnv(env: NodeJS.ProcessEnv) { this.env = env; }

  /** The Mathlib checkouts the sandbox lets the session read; set before `start()`. */
  allowMathlib(paths: string[]) { this.paths = { ...this.paths, mathlib: paths }; }

  get running() { return !!this.child && this.child.exitCode === null; }

  start(): Promise<void> {
    if (this.ready && this.running) return this.ready;
    // The project's .pi folder exists before the sandbox starts, so the session can use it (goals) but not replace it.
    mkdirSync(join(this.dir, '.pi'), { recursive: true });
    const profile = writeSandboxProfile({ ...this.paths, project: this.dir });
    const piDir = prepareSessionPiDir();
    const cli = join(dirname(shippedConfigPath()), 'bin', 'theoria.js');
    this.child = spawn(sandboxExec, ['-f', profile, process.execPath, cli, '--mode', 'rpc', '--continue'], {
      cwd: this.dir,
      env: { ...this.env, PI_CODING_AGENT_DIR: piDir, [theoriaAgentEnv]: agentDir(), [botSessionEnv]: '1', [launchDirEnv]: dirname(this.dir) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: this.child.stdout! });
    lines.on('line', line => this.receive(line));
    const stderr: string[] = [];
    this.child.stderr!.on('data', chunk => { stderr.push(String(chunk)); if (stderr.length > 50) stderr.shift(); });
    this.child.on('exit', code => {
      this.emit('exit', code, stderr.join('').trim().split('\n').slice(-5).join('\n'));
      for (const resolve of this.pending.values()) resolve({ type: 'response', success: false, error: 'the session ended' });
      this.pending.clear();
      this.busy = false;
      this.workflowStatus = undefined;
      clearTimeout(this.idleTimer);
    });
    // Ready when Pi answers its first command, which it does only once its extensions are loaded.
    const timeout = seconds(config().connectors.telegram.sessionStartTimeoutSeconds);
    this.ready = Promise.race([
      this.request({ type: 'get_state' }).then(response => {
        if (response.success === false) throw new Error(String(response.error ?? 'the session did not start'));
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`the session did not start within ${timeout / 1000}s`)), timeout)),
    ]);
    this.ready.catch(() => this.stop());
    this.touch();
    return this.ready;
  }

  private receive(line: string) {
    let event: RpcEvent;
    try { event = JSON.parse(line) as RpcEvent; } catch { return; }
    if (event.type === 'response' && typeof event.id === 'string' && this.pending.has(event.id)) {
      this.pending.get(event.id)!(event);
      this.pending.delete(event.id);
      return;
    }
    if (event.type === 'agent_start') this.busy = true;
    if (event.type === 'agent_settled') this.busy = false;
    if (event.type === 'extension_ui_request' && event.method === 'setStatus' && event.statusKey === 'theoria-workflow') {
      this.workflowStatus = typeof event.statusText === 'string' ? stripAnsi(event.statusText) : undefined;
    }
    this.touch();
    this.emit('event', event);
  }

  send(command: Record<string, unknown>) {
    this.child?.stdin?.write(`${JSON.stringify(command)}\n`);
    this.touch();
  }

  request(command: Record<string, unknown>): Promise<RpcEvent> {
    const id = `t${++this.counter}`;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.send({ ...command, id });
    });
  }

  /** A message as if typed: a slash command runs it, anything else is a prompt, queued after current work. */
  async prompt(text: string) {
    await this.start();
    return this.request({ type: 'prompt', message: text, streamingBehavior: 'followUp' });
  }

  answer(id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) {
    this.send({ type: 'extension_ui_response', id, ...response });
  }

  abort() { return this.request({ type: 'abort' }); }

  stop() {
    clearTimeout(this.idleTimer);
    if (this.running) this.child!.kill('SIGTERM');
  }

  /** Restarts the idle clock. A session with work in progress is never stopped for being idle. */
  private touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.busy || this.workflowStatus) this.touch(); else this.stop();
    }, minutes(config().connectors.telegram.sessionIdleMinutes));
    this.idleTimer.unref();
  }
}

/** What a bot session's Pi directory may hold between runs; anything else (an extension it wrote) is removed. */
const keptEntries = new Set(['sessions', 'bin', 'models-store.json', 'auth.json', 'settings.json', config().goals.settingsFile]);

/**
 * Pi's directory for bot sessions, inside Theoria's: an empty credential store, so no key or OAuth token from the
 * terminal's `auth.json` enters the sandbox, and only `connectors.telegram.sessionSettings` from Theoria's settings
 * (the default model), and of the MCP servers only Theoria's Mathlib search. It is rebuilt before every session, so
 * nothing a session wrote there (an extension, a package, changed settings, an MCP server) carries over to the next one.
 */
export function prepareSessionPiDir(name = config().connectors.telegram.sessionPiDir): string {
  const dir = join(agentDir(), name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const name of readdirSync(dir)) if (!keptEntries.has(name)) rmSync(join(dir, name), { recursive: true, force: true });
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(readFileSync(join(agentDir(), 'settings.json'), 'utf8')) as Record<string, unknown>; } catch { /* none */ }
  const kept = Object.fromEntries(config().connectors.telegram.sessionSettings.filter(key => key in settings).map(key => [key, settings[key]]));
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(dir, 'auth.json'), '{}\n', { mode: 0o600 });
  // Goal settings (pi-goal-x) as in the terminal, but never unlimited autonomous runs from a phone by default.
  let goals: Record<string, unknown> = {};
  try { goals = JSON.parse(readFileSync(join(agentDir(), config().goals.settingsFile), 'utf8')) as Record<string, unknown>; } catch { /* none */ }
  goals.maxAutonomousRuns ??= config().goals.botMaxAutonomousRuns;
  writeFileSync(join(dir, config().goals.settingsFile), `${JSON.stringify(goals, null, 2)}\n`, { mode: 0o600 });
  // MCP: only the server Theoria manages, as the terminal has it (on or off). Servers the user added may need what the
  // sandbox refuses, so they stay in the terminal.
  const search = sessionEntry();
  if (search) writeFileSync(join(dir, 'mcp.json'), `${JSON.stringify({ mcpServers: { [config().leanSearch.server]: search } }, null, 2)}\n`, { mode: 0o600 });
  if (!existsSync(join(dir, 'sessions'))) mkdirSync(join(dir, 'sessions'));
  return dir;
}

export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, '');
