import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { config } from './config.ts';

/**
 * Theoria's actions: the shared definition behind a slash command (run by you) and the agent's `theoria` tool (run by
 * the model). An action takes the same text arguments as its slash command and returns a structured result, so the
 * model receives what happened (a Lean verdict, a claim's state), never a summary it could misread.
 *
 * A package defines actions with `provideActions`; the actions hub (theoria-core) collects them at session start
 * over Pi's event bus, so packages do not depend on each other and an action exists only where its package is loaded
 * (a project type without workflows has no `prove`). Whether the model may run an action is the configuration's
 * business (`actions.model`), not the action's: an action not listed there never reaches the model.
 */

export type ActionSurface = 'terminal' | 'bot' | 'trial';
export type ModelPolicy = 'allow' | 'ask' | 'deny';

export interface ActionResult {
  ok: boolean;
  /** What happened, for the person or the model: Theoria's own words, from Lean or the stores. */
  text: string;
  /** Structured data (a verdict, a claim), returned to the model as the tool's details. */
  details?: unknown;
  /** A terminal interruption should wait for the user instead of automatically calling the provider again. */
  resumeAgent?: boolean;
}

export interface ActionContext {
  cwd: string;
  /** Who started it; an action may refuse the model something it allows you. */
  invokedBy: 'user' | 'model';
  hasUI: boolean;
  ui: ExtensionContext['ui'];
  /** Session model and registry at invocation time, including custom models and aliases. */
  model: ExtensionContext['model'];
  modelRegistry: ExtensionContext['modelRegistry'];
  /** The command context, for deferred actions, which drive the conversation. */
  command?: ExtensionCommandContext;
  signal?: AbortSignal;
}

export interface ActionSpec {
  /** Unique, lowercase with hyphens: `prove`, `run-status`. */
  name: string;
  /** The slash command a person types for it, as shown to the model: `/prove <theorem>`, `/attack status`. */
  usage: string;
  /** One line: what it does and when to use it. */
  summary: string;
  /** Model routing/usage rules, included in the command tool's system-prompt guidelines when this action is available. */
  promptGuidelines?: string[];
  /**
   * inline: runs inside the tool call. deferred: needs the conversation (it prompts the agent itself), so it is queued
   * and runs when the agent's turn ends, with its result sent back as a message.
   */
  execution: 'inline' | 'deferred';
  run(args: string, actx: ActionContext): Promise<ActionResult>;
}

const collectChannel = 'theoria:actions:collect';

/**
 * Makes actions available to the hub. Called from an extension's factory; `specs` is read when the hub collects, at
 * session start, so it may depend on the session (the project type).
 */
export function provideActions(pi: ExtensionAPI, specs: () => ActionSpec[]): void {
  pi.events.on(collectChannel, (data: unknown) => {
    const add = data as (spec: ActionSpec) => void;
    for (const spec of specs()) add(spec);
  });
}

/** The hub's side: every action the loaded packages provide. */
export function collectActions(pi: ExtensionAPI): ActionSpec[] {
  const found = new Map<string, ActionSpec>();
  pi.events.emit(collectChannel, (spec: ActionSpec) => { if (!found.has(spec.name)) found.set(spec.name, spec); });
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Where this session runs: a trial of a benchmark, a bot session, or the terminal. */
export const trialEnv = 'THEORIA_TRIAL';
export function actionSurface(env: NodeJS.ProcessEnv = process.env): ActionSurface {
  if (env[trialEnv]) return 'trial';
  if (env.THEORIA_BOT_SESSION) return 'bot';
  return 'terminal';
}

/** Whether the model may run `action` here. Unlisted actions are denied. */
export function modelPolicy(action: string, surface: ActionSurface = actionSurface()): ModelPolicy {
  const entry = config().actions.model.find(item => item.action === action);
  const value = entry?.[surface];
  return value === 'allow' || value === 'ask' ? value : 'deny';
}

/** A result as one line of text, for a person. */
export const resultLine = (result: ActionResult) => result.text;
