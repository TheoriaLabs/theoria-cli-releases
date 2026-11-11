import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from '@theoria/shared/paths';
import { inventory, label, leanChoices, resolve as resolveEnvironment, saveLeanSelection, type Selection } from '@theoria/pi-lean/api';
import { loadPrompt, measureProgress, projectRow, refreshInventory, statusLines, workflowNames } from '@theoria/pi-workflows/api';
import type { CredentialBroker } from './credentials.ts';
import { loadSecrets, sessionEnv } from './credentials.ts';
export { loadSecrets, sessionEnv } from './credentials.ts';
import { config } from '@theoria/shared/config';
import { limit } from '@theoria/shared/limits';
import { seconds } from '@theoria/shared/process';
import {
  createProject, folderName, insideProjects, listProjects, projectRecord, projectType, projectTypes, type ProjectRecord,
} from '@theoria/shared/project';
import { ProjectSession, stripAnsi, type RpcEvent } from './session.ts';
import {
  consumePairing, readBotState, readOwner, writeBotState, writeOwner, type BotState, type Owner,
} from './store.ts';
import { chunks, telegramCommand, type InlineButton, type TelegramApi, type TelegramMessage, type TelegramUpdate, type TelegramUser } from './telegram.ts';

/**
 * The Theoria Telegram bot. One owner, paired with a one-time code from `/connect-bot`, may use it; every other
 * sender is ignored. Projects are the folders inside the owner's projects folder, nothing else: a project name from
 * Telegram is only ever looked up among them. Each project gets its own sandboxed session (`ProjectSession`); its
 * workflow commands, plain-text prompts, questions and verdicts travel through this class.
 */

const coreCommands = [
  { command: 'new_project', description: 'Create a project and choose its type' },
  { command: 'projects', description: 'List projects and select one' },
  { command: 'use', description: 'Select a project: /use <name>' },
  { command: 'status', description: 'Progress and current run; /status all, /status refresh' },
  { command: 'cancel', description: 'Stop the current run' },
  { command: 'runs', description: 'Research runs of the project' },
  { command: 'attack_new', description: 'Start a research attack: /attack_new <objective>' },
  { command: 'attack_fork', description: 'Fork the current research run' },
  { command: 'attack_resume', description: 'Back into a research run' },
  { command: 'attack_pause', description: 'Pause the current research run' },
  { command: 'attack_complete', description: 'Complete the current research run' },
  { command: 'benchmark_list', description: 'Benchmarks and their splits' },
  { command: 'benchmark_run', description: 'Run a benchmark: /benchmark_run <id> [split] [N] [model=<provider>/<id>]' },
  { command: 'benchmark_status', description: 'Results of the latest benchmark run' },
  { command: 'benchmark_cancel', description: 'Stop a benchmark run' },
  { command: 'benchmark_compare', description: 'Compare two benchmark runs: /benchmark_compare <run> <run>' },
  { command: 'help', description: 'What this bot can do here' },
];

type Action = () => Promise<void> | void;
/** What the next plain-text message from the owner answers, when it answers something. */
type Awaiting = { kind: 'project-name' } | { kind: 'ui'; session: ProjectSession; id: string };

export interface BotLog { (line: string): void }

export class TheoriaBot {
  owner: Owner | undefined;
  /** Serves the AWS profile's keys to sessions, when `bedrock.awsProfile` is set. Set before `run()`. */
  credentials: CredentialBroker | undefined;
  /** API keys from the Keychain (`theoria bot secret set`), loaded when a session starts. */
  private secrets: Record<string, string> = {};
  readonly state: BotState;
  private readonly api: TelegramApi;
  private readonly me: TelegramUser;
  private readonly log: BotLog;
  private readonly sessions = new Map<string, ProjectSession>();
  private readonly actions = new Map<string, Action>();
  private actionCounter = 0;
  private awaiting: Awaiting | undefined;
  /** Per session: when its current workflow started, the progress message, and whether a plain prompt awaits a reply. */
  private readonly runs = new Map<ProjectSession, { started?: number; workflow?: string; statusMessage?: number; plain?: boolean; reply?: string; error?: string }>();
  /** The last model error reported per project, so a workflow's retries do not repeat the same message. */
  private readonly reportedErrors = new Map<string, string>();
  private stopped = false;
  private typing: NodeJS.Timeout | undefined;

  constructor(api: TelegramApi, me: TelegramUser, log: BotLog) {
    this.api = api;
    this.me = me;
    this.log = log;
    this.owner = readOwner();
    this.state = readBotState();
  }

  /** Polls Telegram until `stop()`. A conflict (another reader of this bot) ends the loop instead of competing. */
  async run(): Promise<'stopped' | 'conflict'> {
    const backoffMax = seconds(config().connectors.telegram.backoffMaxSeconds);
    let backoff = 1000;
    this.typing = setInterval(() => this.sendTyping(), seconds(config().connectors.telegram.typingIntervalSeconds));
    await this.syncCommands();
    await this.offerBenchmarkResume().catch(error => this.log(`benchmark resume check failed: ${String(error)}`));
    while (!this.stopped) {
      const polled = await this.api.getUpdates(this.state.offset);
      if (!polled.ok) {
        if (polled.conflict) { this.log(`another process is reading this bot's updates; stopping: ${polled.detail}`); this.stop(); return 'conflict'; }
        this.log(`getUpdates failed, retrying in ${Math.round(backoff / 1000)}s: ${polled.detail}`);
        await sleep(polled.retryAfter ? seconds(polled.retryAfter) : backoff);
        backoff = Math.min(backoff * 2, backoffMax);
        continue;
      }
      backoff = 1000;
      for (const update of polled.result ?? []) {
        this.state.offset = Math.max(this.state.offset, update.update_id + 1);
        writeBotState(this.state);
        await this.handle(update).catch(error => this.log(`update ${update.update_id} failed: ${error instanceof Error ? error.stack : String(error)}`));
      }
    }
    return 'stopped';
  }

  stop() {
    this.stopped = true;
    clearInterval(this.typing);
    for (const session of this.sessions.values()) session.stop();
  }

  // ── Updates ─────────────────────────────────────────────────────────────────────────────────────────────────

  async handle(update: TelegramUpdate) {
    if (update.callback_query) {
      const query = update.callback_query;
      if (!this.isOwner(query.from)) return;
      const action = query.data ? this.actions.get(query.data) : undefined;
      await this.api.answerCallbackQuery(query.id, action ? undefined : 'This button has expired.');
      if (action) { this.actions.delete(query.data!); await action(); }
      return;
    }
    const message = update.message;
    if (!message?.text || !message.from || message.chat.type !== 'private') return;
    const text = message.text.trim();
    const [head = '', ...rest] = text.split(/\s+/);
    const args = rest.join(' ');
    const command = head.startsWith('/') ? head.slice(1).split('@')[0]!.toLowerCase() : undefined;

    if (command === 'start' && args && (!this.owner || !this.isOwner(message.from))) return this.pair(message, args);
    // Everyone but the owner is ignored, without a reply, so the bot does not confirm it exists to strangers.
    if (!this.isOwner(message.from)) return;

    if (!command) return this.text(text);
    this.awaiting = undefined;
    switch (command) {
      case 'start': case 'help': return this.help();
      case 'projects': return this.listProjects();
      case 'use': return this.use(args);
      case 'new_project': return this.newProject(args);
      case 'status': return this.status(args);
      case 'cancel': return this.cancel();
      case 'runs': return this.runs_(args);
      case 'attack_new': case 'attack_fork': case 'attack_resume': case 'attack_pause': case 'attack_complete': return this.runCommand(command.slice(7), args);
      case 'benchmark_list': case 'benchmark_run': case 'benchmark_status': case 'benchmark_cancel': case 'benchmark_compare': return this.benchmark(command.slice(10), args);
      default: return this.workflow(command, args);
    }
  }

  private isOwner(user: TelegramUser) { return !!this.owner && user.id === this.owner.userId; }

  /** `/start <code>`: a valid one-time code from `/connect-bot` makes the sender the owner. */
  private async pair(message: TelegramMessage, code: string) {
    const pairing = consumePairing(code.trim());
    if (!pairing) { this.log(`ignored /start with an unknown or expired code from ${message.from!.id}`); return; }
    const from = message.from!;
    this.owner = {
      botId: this.me.id, botUsername: this.me.username ?? pairing.botUsername,
      userId: from.id, chatId: message.chat.id,
      displayName: from.username ? `@${from.username}` : from.first_name ?? String(from.id),
      projectsDir: pairing.projectsDir, pairedAt: new Date().toISOString(),
    };
    writeOwner(this.owner);
    this.log(`paired with ${this.owner.displayName} (${from.id})`);
    await this.say(`Paired with Theoria. Only you can use this bot.\nProjects: ${pairing.projectsDir}`);
    await this.syncCommands();
    await this.help();
  }

  // ── Projects ────────────────────────────────────────────────────────────────────────────────────────────────

  private projects() { return this.owner ? listProjects(this.owner.projectsDir) : []; }

  /** The selected project's folder, re-checked to be inside the projects folder every time it is used. */
  private selectedDir(): string | undefined {
    if (!this.owner || !this.state.selected) return undefined;
    return insideProjects(this.owner.projectsDir, join(this.owner.projectsDir, this.state.selected));
  }

  private async select(dir: string) {
    const real = insideProjects(this.owner!.projectsDir, dir);
    if (!real) { await this.say('That project is not in the projects folder.'); return; }
    this.state.selected = real.split('/').pop()!;
    writeBotState(this.state);
    await this.syncCommands();
    const record = projectRecord(real);
    await this.say(`Selected ${record?.name ?? this.state.selected}. ${this.commandsLine(real)}`);
  }

  private async listProjects() {
    const projects = this.projects();
    if (!projects.length) { await this.say('No projects yet. Create one with /new_project.'); return; }
    const selected = this.selectedDir();
    await this.say('Projects (tap to select):', projects.map(project => [{
      text: `${project.dir === selected ? '● ' : ''}${projectRow(project.dir, project.record)}`.slice(0, 120),
      callback_data: this.action(() => this.select(project.dir)),
    }]));
  }

  private async use(name: string) {
    if (!name) return this.listProjects();
    const wanted = folderName(name);
    const projects = this.projects();
    const match = projects.find(project => project.dir.split('/').pop() === wanted)
      ?? projects.find(project => folderName(project.record.name ?? '') === wanted)
      ?? projects.find(project => project.dir.split('/').pop()!.includes(wanted));
    if (!match) { await this.say(`No project matches "${name}". /projects lists them.`); return; }
    await this.select(match.dir);
  }

  /** `/new_project [name]`: the name, then the type, then Lean for a type that uses it. */
  private async newProject(name: string) {
    if (!name) { this.awaiting = { kind: 'project-name' }; await this.say('Name of the new project?'); return; }
    const types = Object.entries(projectTypes());
    await this.say(`Type of "${name}":`, types.map(([type, settings]) => [{
      text: `${settings.name} · ${settings.workflows.length ? settings.workflows.map(entry => `/${entry}`).join(' ') : 'no workflows yet'}`,
      callback_data: this.action(() => this.chooseLean(name, type)),
    }]));
  }

  private async chooseLean(name: string, type: string) {
    if (!projectTypes()[type]!.lean) return this.create(name, type);
    const { choices } = await leanChoices();
    if (!choices.length) return this.create(name, type);
    await this.say('Lean and Mathlib:', [
      ...choices.map(choice => [{ text: choice.label, callback_data: this.action(() => this.create(name, type, choice.selection)) }]),
      [{ text: 'Choose later', callback_data: this.action(() => this.create(name, type)) }],
    ]);
  }

  private async create(name: string, type: string, lean?: Selection) {
    const dir = join(this.owner!.projectsDir, folderName(name));
    try {
      await createProject(dir, name, type);
      if (lean) saveLeanSelection(dir, 'project', lean);
    } catch (error) {
      await this.say(`Could not create the project: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await this.say(`Created ${name} (${projectTypes()[type]!.name}).${lean ? ` Lean: ${'mathlib' in lean ? `Mathlib ${lean.mathlib}` : `Lean ${lean.lean}`}.` : ''}`);
    await this.select(dir);
  }

  // ── Working in a project ────────────────────────────────────────────────────────────────────────────────────

  /** The Pi commands the selected project's type enables, by their Telegram names, then the goal commands. */
  private workflowCommands(dir: string | undefined): Map<string, string> {
    if (!dir) return new Map();
    let enabled: string[] = [];
    try { const settings = projectType(dir).settings; enabled = [...settings.workflows, ...(settings.latex ? ['latex'] : [])]; } catch { /* broken project file: none */ }
    return new Map([...enabled, ...config().goals.telegramCommands.map(entry => entry.command)].map(name => [telegramCommand(name), name]));
  }

  private commandsLine(dir: string) {
    const commands = [...this.workflowCommands(dir).keys()];
    return commands.length ? `Commands: ${commands.map(command => `/${command}`).join(' ')}. Plain text goes to the agent.` : 'Plain text goes to the agent.';
  }

  /** The command menu: the core commands, plus the selected project's workflows. */
  private async syncCommands() {
    const dir = this.selectedDir();
    const width = config().connectors.telegram.commandDescriptionChars;
    const goals = Object.fromEntries(config().goals.telegramCommands.map(entry => [entry.command, entry.description])) as Record<string, string>;
    const workflows = [...this.workflowCommands(dir)].map(([command, name]) => {
      let description = name === 'latex' ? 'Paper: paper create | paper update | pdf | status' : goals[name] ?? `Run /${name}`;
      if (!goals[name] && name !== 'latex') try { description = loadPrompt(name as (typeof workflowNames)[number], dir!).settings.description; } catch { /* default */ }
      return { command, description: description.slice(0, width) };
    });
    const result = await this.api.setMyCommands([...workflows, ...coreCommands], this.owner?.chatId);
    if (!result.ok) this.log(`setMyCommands failed: ${result.detail}`);
  }

  private session(dir: string): ProjectSession {
    let session = this.sessions.get(dir);
    if (session) return session;
    session = new ProjectSession(dir, { projectsDir: this.owner!.projectsDir, mathlib: [] }, sessionEnv(this.credentials, this.secrets));
    session.on('event', (event: RpcEvent) => { void this.onEvent(session!, event).catch(error => this.log(`event failed: ${String(error)}`)); });
    session.on('exit', (code: number | null, stderr: string) => {
      this.sessions.delete(dir);
      this.runs.delete(session!);
      if (code) void this.say(`The session for ${projectName(dir)} stopped (exit ${code}).${stderr ? `\n${stderr}` : ''}`);
    });
    this.sessions.set(dir, session);
    return session;
  }

  /** Starts a project's session, after warming what Lean needs outside the sandbox. */
  private async ready(dir: string): Promise<ProjectSession | undefined> {
    const session = this.session(dir);
    if (session.running) return session;
    try {
      this.secrets = await loadSecrets();
      session.setEnv(sessionEnv(this.credentials, this.secrets));
      // The sandbox cannot write into a Mathlib checkout, so its search path is resolved (and cached) here first.
      await resolveEnvironment(dir);
      const found = await inventory();
      session.allowMathlib(found.checkouts.map(checkout => checkout.path));
      await session.start();
      return session;
    } catch (error) {
      this.sessions.delete(dir);
      await this.say(`Could not start the session for ${projectName(dir)}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async workflow(command: string, args: string) {
    const dir = this.selectedDir();
    const name = this.workflowCommands(dir).get(command);
    if (!dir || !name) {
      await this.say(dir ? `/${command} is not available for ${projectName(dir)}. ${this.commandsLine(dir)}` : `Unknown command /${command}. /help lists what works here.`);
      return;
    }
    const isGoalCommand = config().goals.telegramCommands.some(entry => entry.command === name);
    if (!args && !isGoalCommand && name !== 'latex') { await this.say(`Usage: /${command} <what>, e.g. /${command} the sum of the first n odd numbers is n squared`); return; }
    const session = await this.ready(dir);
    if (!session) return;
    if (!isGoalCommand) {
      this.runs.set(session, { started: Date.now(), workflow: name });
      await this.say(`Started /${name} in ${projectName(dir)}. I will message you when it finishes.`);
    }
    this.submit(session, `/${name}${args ? ` ${args}` : ''}`);
  }

  /** Plain text: the answer to a question, a project name, or a prompt for the selected project's agent. */
  private async text(text: string) {
    const awaiting = this.awaiting;
    this.awaiting = undefined;
    if (awaiting?.kind === 'project-name') return this.newProject(text);
    if (awaiting?.kind === 'ui') { awaiting.session.answer(awaiting.id, { value: text }); return; }
    const dir = this.selectedDir();
    if (!dir) { await this.say('Select a project first: /projects, or /new_project.'); return; }
    const session = await this.ready(dir);
    if (!session) return;
    const run = this.runs.get(session) ?? {};
    this.runs.set(session, { ...run, plain: true, reply: '' });
    this.submit(session, text);
  }

  /**
   * Hands a message to a session without waiting for it. Pi answers an extension command only when the command has
   * finished, which for a workflow is minutes later and may need the owner's answer to a question in between, so
   * waiting here would stop the bot reading updates and the answer would never arrive.
   */
  private submit(session: ProjectSession, text: string) {
    void session.prompt(text).then(response => {
      if (response.success === false) void this.say(`${projectName(session.dir)}: ${String(response.error ?? 'the message was not accepted')}`);
    }, error => this.log(`prompt failed: ${String(error)}`));
  }

  private async cancel() {
    const dir = this.selectedDir();
    const session = dir ? this.sessions.get(dir) : undefined;
    if (!session?.running || (!session.busy && !session.workflowStatus)) { await this.say('Nothing is running in the selected project.'); return; }
    await session.abort();
    await this.say(`Stopping the run in ${projectName(dir!)}.`);
  }

  // ── Events from a session ───────────────────────────────────────────────────────────────────────────────────

  private async onEvent(session: ProjectSession, event: RpcEvent) {
    const run = this.runs.get(session) ?? {};
    if (event.type === 'extension_ui_request') return this.uiRequest(session, event, run);
    if (event.type === 'message_end') {
      const message = event.message as { role?: string; customType?: string; content?: unknown; stopReason?: string; errorMessage?: string } | undefined;
      // A model call that failed (expired credentials, a refused request) produces no text. Said once, plainly,
      // rather than leaving a prompt unanswered or a workflow's retries failing in silence.
      if (message?.role === 'assistant' && message.stopReason === 'error') {
        const error = message.errorMessage ?? 'the model call failed';
        if (run.plain) { this.runs.set(session, { ...run, error }); return; }
        if (this.reportedErrors.get(session.dir) !== error) {
          this.reportedErrors.set(session.dir, error);
          await this.say(`${projectName(session.dir)}: the model could not be reached: ${error}${credentialHint(error)}`);
        }
        return;
      }
      if (message?.role === 'assistant' && message.stopReason !== 'error') this.reportedErrors.delete(session.dir);
      if (message?.customType === 'theoria-verdict' || message?.customType === 'theoria-project' || message?.customType === 'theoria-latex') {
        await this.verdict(session, String(message.content ?? ''), run);
      } else if (message?.customType && config().goals.notifyTypes.includes(message.customType)) {
        // A goal's audit result: the agent and a model auditor judged it, which the message says, not Lean.
        for (const part of chunks(`${projectName(session.dir)} · goal\n${String(message.content ?? '')}`)) await this.say(part);
      } else if (message?.role === 'assistant' && run.plain) {
        const text = Array.isArray(message.content)
          ? (message.content as { type?: string; text?: string }[]).filter(part => part.type === 'text').map(part => part.text ?? '').join('')
          : '';
        if (text.trim()) run.reply = text;
        this.runs.set(session, run);
      }
      return;
    }
    if (event.type === 'agent_settled' && run.plain) {
      const where = projectName(session.dir);
      if (run.reply?.trim()) for (const part of chunks(`${where}:\n${run.reply}`)) await this.say(part);
      else if (run.error) await this.say(`${where}: no answer, the model could not be reached: ${run.error}${credentialHint(run.error)}`);
      else await this.say(`${where}: the agent finished without a written answer.`);
      this.runs.set(session, { ...run, plain: false, reply: '', error: undefined });
    }
  }

  /** A workflow's question becomes buttons; its footer status, one message edited as it changes. */
  private async uiRequest(session: ProjectSession, event: RpcEvent, run: { statusMessage?: number }) {
    const id = String(event.id ?? '');
    const where = projectName(session.dir);
    switch (event.method) {
      case 'select': {
        const options = (event.options as string[] | undefined) ?? [];
        await this.say(`${where}: ${String(event.title ?? 'Choose')}`, [
          ...options.map(option => [{ text: option.slice(0, 120), callback_data: this.action(() => session.answer(id, { value: option })) }]),
          [{ text: 'Cancel', callback_data: this.action(() => session.answer(id, { cancelled: true })) }],
        ]);
        return;
      }
      case 'confirm':
        await this.say(`${where}: ${String(event.title ?? 'Confirm')}\n\n${String(event.message ?? '')}`, [[
          { text: 'Yes', callback_data: this.action(() => session.answer(id, { confirmed: true })) },
          { text: 'No', callback_data: this.action(() => session.answer(id, { confirmed: false })) },
        ]]);
        return;
      case 'input': case 'editor':
        this.awaiting = { kind: 'ui', session, id };
        await this.say(`${where}: ${String(event.title ?? 'Reply with text')}${event.placeholder ? ` (${String(event.placeholder)})` : ''}`);
        return;
      case 'notify':
        await this.say(`${where}: ${stripAnsi(String(event.message ?? ''))}`);
        return;
      case 'setStatus': {
        if (event.statusKey !== 'theoria-workflow') return;
        const text = typeof event.statusText === 'string' ? stripAnsi(event.statusText) : undefined;
        if (!text) { this.runs.set(session, { ...this.runs.get(session), statusMessage: undefined }); return; }
        const body = `${where} · ${text}`;
        if (run.statusMessage) await this.api.editMessageText(this.owner!.chatId, run.statusMessage, body);
        else {
          const sent = await this.api.sendMessage(this.owner!.chatId, body);
          this.runs.set(session, { ...this.runs.get(session), statusMessage: sent.result?.message_id });
        }
        return;
      }
      default:
    }
  }

  /** A verdict card: sent as a notification, remembered for /status, and progress measured again. */
  /** A verdict card: sent as a notification. The project's run history and Lean's recheck happen in the session. */
  private async verdict(session: ProjectSession, content: string, run: { started?: number; workflow?: string }) {
    const where = projectName(session.dir);
    const took = run.started ? ` · ${formatDuration(Date.now() - run.started)}` : '';
    for (const part of chunks(`${where}${took}\n${content}`)) await this.say(part);
    this.runs.set(session, { ...this.runs.get(session), started: undefined, workflow: undefined, statusMessage: undefined });
  }

  // ── Status ──────────────────────────────────────────────────────────────────────────────────────────────────

  private async status(args: string) {
    if (args === 'all') {
      const projects = this.projects();
      if (!projects.length) { await this.say('No projects yet. Create one with /new_project.'); return; }
      const lines = projects.map(project => {
        const session = this.sessions.get(project.dir);
        const running = session?.workflowStatus ?? (session?.busy ? 'working' : '');
        return `${project.dir === this.selectedDir() ? '● ' : ''}${projectRow(project.dir, project.record)}${running ? `\n  ${running}` : ''}`;
      });
      for (const part of chunks(lines.join('\n'))) await this.say(part);
      return;
    }
    const dir = this.selectedDir();
    if (!dir) { await this.say('No project selected. /projects, or /status all.'); return; }
    if (args === 'refresh') {
      await this.say(`Checking ${projectName(dir)} with Lean…`);
      await refreshInventory(dir).then(() => measureProgress(dir)).catch(error => this.log(`status refresh failed: ${String(error)}`));
    }
    const session = this.sessions.get(dir);
    const { lines, stale } = await statusLines(dir);
    // Out of date: rechecked here (outside the sandbox, read-only on the project), for the next /status.
    if (stale && args !== 'refresh') void refreshInventory(dir).catch(error => this.log(`status refresh failed: ${String(error)}`));
    const head = [lines[0] ?? '', `Run: ${session?.workflowStatus ?? (session?.busy ? 'the agent is working' : 'idle')}`];
    for (const part of chunks([...head, ...lines.slice(1)].join('\n'))) await this.say(part);
  }


  // ── Research runs and benchmarks ────────────────────────────────────────────────────────────────────────────

  /** `/runs`: read here, from the project's files. */
  private async runs_(_args: string) {
    const dir = this.selectedDir();
    if (!dir) { await this.say('Select a project first: /projects.'); return; }
    const { listRuns, runLine } = await import('@theoria/pi-research/api');
    const runs = listRuns(dir).reverse().slice(0, config().research.statusMaxRuns);
    await this.say(runs.length ? [`Research runs of ${projectName(dir)}:`, ...runs.map(runLine)].join('\n') : 'No research runs yet. /attack_new <objective> starts one.');
  }

  /** `/attack_new`, `/attack_fork`, …: handed to the project's session as `/attack …`, whose questions come back as buttons. */
  private async runCommand(action: string, args: string) {
    const dir = this.selectedDir();
    if (!dir) { await this.say('Select a project first: /projects.'); return; }
    if (action === 'new' && !args) { await this.say('Usage: /attack_new <objective>, e.g. /attack_new Determine whether the spectral route proves T'); return; }
    const session = await this.ready(dir);
    if (!session) return;
    this.submit(session, `/attack ${action}${args ? ` ${args}` : ''}`);
  }

  private benchModule() { return import('@theoria/pi-bench/api'); }

  /** The model bot sessions use: their saved default, else Theoria's Bedrock default. */
  private sessionModel(): string {
    try {
      const saved = JSON.parse(readFileSync(join(agentDir(), 'settings.json'), 'utf8')) as { defaultProvider?: string; defaultModel?: string };
      if (saved.defaultProvider && saved.defaultModel) return `${saved.defaultProvider}/${saved.defaultModel}`;
    } catch { /* none */ }
    return `${config().bedrock.provider}/${process.env.THEORIA_BEDROCK_MODEL || config().bedrock.defaultModel}`;
  }

  private benchEnv = async () => { this.secrets = await loadSecrets(); return sessionEnv(this.credentials, this.secrets); };

  private benchEvents(dir: string, bench: Awaited<ReturnType<TheoriaBot['benchModule']>>) {
    const where = projectName(dir);
    return {
      trialFinished: (trial: Parameters<typeof bench.trialUsage>[0] extends infer M ? { runId: string; id: string; status: string; metrics: M & { reason?: string } } : never) => void this.say(`${where} · ${trial.runId}: ${trial.status === 'passed' ? '✔' : trial.status === 'failed' ? '✖' : '!'} ${trial.id} ${trial.status}\n${bench.trialUsage(trial.metrics)}${trial.metrics.reason ? `\n${trial.metrics.reason.slice(0, 200)}` : ''}`),
      finished: (result: Parameters<typeof bench.usageLines>[0], run: { runId: string; status: string; benchmarkId: string; split: string }) => void this.say([`${where} · ${run.runId} ${run.status}: ${run.benchmarkId} (${run.split}) ${result.passed}/${result.passed + result.failed} passed, judged by Comparator · ${result.errors} errors`, ...bench.usageLines(result)].join('\n')),
      progress: (line: string) => { if (/stopped|Stopping/.test(line)) void this.say(`${where}: ${line}`); },
    };
  }

  private async benchmark(action: string, args: string) {
    const dir = this.selectedDir();
    const bench = await this.benchModule();
    if (action === 'list') { for (const part of chunks(await bench.listText())) await this.say(part); return; }
    if (!dir) { await this.say('Select a project first: /projects. Benchmark runs belong to a project.'); return; }
    if (action === 'status') { for (const part of chunks(bench.statusText(dir, args || undefined).text)) await this.say(part); return; }
    if (action === 'compare') {
      const [first = '', second = ''] = args.split(/\s+/);
      await this.say(first && second ? bench.compareRuns(dir, first, second).text : 'Usage: /benchmark_compare run-007 run-008');
      return;
    }
    if (action === 'cancel') {
      const runId = args || bench.benchmarkRuns(dir).find(run => run.status === 'running' || run.status === 'queued')?.runId;
      await this.say(runId ? bench.cancel(dir, runId) : 'No benchmark run is running in this project.');
      return;
    }
    if (bench.activeRunners().length) { await this.say(`A benchmark is already running (${bench.activeRunners().join(', ')}); one at a time from the phone. /benchmark_cancel stops it.`); return; }
    const cap = config().connectors.telegram.maxBenchmarkCostUsd;
    let planned;
    try { planned = await bench.plan({ ...bench.parseRunArgs(args, this.sessionModel(), 'bot'), maxTotalCostUsd: cap }); } catch (error) {
      await this.say(`${error instanceof Error ? error.message : String(error)}\nUsage: /benchmark_run <${bench.benchmarks.map(benchmark => benchmark.id).join('|')}> [train|val|test] [N or task,task] [model=<provider>/<id>] [harness=<profile>] [cost=$ per trial]`);
      return;
    }
    const lines = bench.planLines(planned);
    if (planned.problems.length) { await this.say(lines.join('\n')); return; }
    const go = async () => {
      const run = bench.start(dir, planned, { projectType: projectRecord(dir)?.type }, Math.min(cap, limit(planned.maxCostUsd)), 'bot', this.benchEnv, this.benchEvents(dir, bench));
      await this.say(`Started ${run.runId}. I will message you as each trial finishes. /benchmark_status, /benchmark_cancel.`);
    };
    const confirmTest = planned.split === 'test' && config().benchmarks.splits.confirmTest;
    await this.say([`Run this benchmark in ${projectName(dir)}? (cap from the phone: $${cap})`, ...lines].join('\n'), [[
      { text: confirmTest ? 'Yes, on the test split' : 'Start', callback_data: this.action(go) },
      { text: 'No', callback_data: this.action(() => this.say('Not started.')) },
    ]]);
  }

  /** Benchmark runs the bot started and left unfinished (a restart): offered to resume, never resumed unasked. */
  async offerBenchmarkResume() {
    const bench = await this.benchModule();
    for (const project of this.projects()) {
      for (const run of bench.stoppedRuns(project.dir).filter(entry => entry.startedFrom === 'bot')) {
        await this.say(`${projectName(project.dir)} · ${run.runId} (${run.benchmarkId}, ${run.split}) stopped when the bot did.`, [[
          { text: 'Resume', callback_data: this.action(async () => { bench.launch(project.dir, run.runId, this.benchEnv, this.benchEvents(project.dir, bench)); await this.say(`Resuming ${run.runId}.`); }) },
          { text: 'Cancel it', callback_data: this.action(async () => { await this.say(bench.cancel(project.dir, run.runId)); }) },
        ]]);
      }
    }
  }

  private async help() {
    const dir = this.selectedDir();
    await this.say([
      dir ? `Project: ${projectName(dir)} · ${typeName(projectRecord(dir))}` : 'No project selected.',
      dir ? this.commandsLine(dir) : '',
      '',
      '/new_project – create a project',
      '/projects, /use <name> – select a project',
      '/status [all|refresh] – proofs, formalizations, goals, recent runs',
      '/cancel – stop the current run',
      '/goal <idea>, /goal_list, /goal_status, /goal_pause, /goal_resume – goals for this project (several may be open)',
      '/attack_new <objective>, /runs, /attack_fork, /attack_resume, /attack_pause, /attack_complete – research runs with a persistent goal',
      `/benchmark_list, /benchmark_run <id> [train|val|test] [N], /benchmark_status, /benchmark_cancel – benchmarks, judged by Comparator (at most $${config().connectors.telegram.maxBenchmarkCostUsd} per run from here)`,
      '/benchmark_run accepts model=<provider>/<id> for a per-run override; omission uses the bot session default.',
      `Projects live in ${this.owner?.projectsDir ?? 'the projects folder'}; nothing outside it is reachable from here.`,
    ].filter(line => line !== '').join('\n'));
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────────────────────────────────────

  private action(run: Action): string {
    const key = `a${++this.actionCounter}`;
    this.actions.set(key, run);
    return key;
  }

  async say(text: string, buttons?: InlineButton[][]) {
    if (!this.owner) return;
    const sent = await this.api.sendMessage(this.owner.chatId, text, buttons);
    if (!sent.ok) this.log(`sendMessage failed: ${sent.detail}`);
  }

  private sendTyping() {
    if (!this.owner) return;
    if ([...this.sessions.values()].some(session => session.busy)) void this.api.sendChatAction(this.owner.chatId);
  }
}

/** What to do about a credentials failure, which from Telegram is the commonest reason nothing answers. */
function credentialHint(error: string): string {
  if (!/credential|ExpiredToken|security token|UnrecognizedClient|not authorized|AccessDenied|re-authenticate/i.test(error)) return '';
  const profile = config().bedrock.awsProfile;
  return profile
    ? `\n\nOn the Mac: aws login --profile ${profile} (or aws sso login --profile ${profile}), then try again. Bot sessions cannot read ~/.aws/credentials, so the profile must sign in by login or SSO.`
    : '\n\nOn the Mac: set bedrock.awsProfile in ~/.theoria-cli/config.json to a login or SSO profile, then theoria bot restart.';
}

const projectName = (dir: string) => projectRecord(dir)?.name ?? dir.split('/').pop() ?? dir;
const typeName = (record: Partial<ProjectRecord> | undefined) => (record?.type ? projectTypes()[record.type]?.name ?? record.type : 'no type');
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  return m < 60 ? `${m} min ${total % 60}s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
