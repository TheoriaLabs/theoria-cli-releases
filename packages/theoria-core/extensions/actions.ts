import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { actionSurface, collectActions, modelPolicy, type ActionResult, type ActionSpec } from '@theoria/shared/actions';
import { registerCard } from '@theoria/shared/card';
import { config } from '@theoria/shared/config';
import { componentOn } from '@theoria/shared/harness';

/**
 * The actions hub: Theoria's commands, offered to the agent as one tool.
 *
 * At session start it collects the actions the loaded packages provide (`provideActions`) and keeps those the
 * configuration lets the model run on this surface (`actions.model`). They become the `theoria` tool, whose
 * description lists them with their slash-command usage, so the model calls `/prove` the way you would type it.
 *
 * - inline actions run inside the tool call and return their result;
 * - deferred actions (the workflows, which prompt the agent themselves) are queued; when the agent's turn ends the hub
 *   runs them through its queue command, as if you had typed them, and sends the agent each structured verdict.
 *
 * Guards, each enforced here and not left to the prompt: unlisted or `deny` actions are refused; `ask` needs your
 * confirmation and is refused where no one can answer; while a deferred action runs the agent cannot start another
 * (depth 1); at most `actions.maxDeferredPerSession` deferred actions per session; the same call `repeatLimit` times
 * in a row asks first.
 */

interface Queued { spec: ActionSpec; args: string }

export default function actions(pi: ExtensionAPI) {
  if (!componentOn('actions')) return;
  const settings = config().actions;
  const surface = actionSurface();
  const card = registerCard(pi, 'theoria-action');
  let available: ActionSpec[] = [];
  const queue: Queued[] = [];
  let running: Queued | undefined;
  let deferredStarted = 0;
  const recent: string[] = [];

  pi.on('session_start', () => {
    queue.length = 0;
    running = undefined;
    deferredStarted = 0;
    recent.length = 0;
    available = collectActions(pi).filter(spec => modelPolicy(spec.name, surface) !== 'deny');
    if (!available.length) return;
    pi.registerTool(defineTool({
      name: settings.tool,
      label: 'Theoria',
      description: describeTool(available),
      promptSnippet: `${settings.tool}: run Theoria commands (${available.map(spec => spec.usage.split(' ').slice(0, 2).join(' ')).join(', ')})`,
      promptGuidelines: available.flatMap(spec => spec.promptGuidelines ?? []),
      parameters: Type.Object({
        action: Type.String({ description: `One of: ${available.map(spec => spec.name).join(', ')}` }),
        args: Type.Optional(Type.String({ description: 'The arguments, as you would type them after the slash command.' })),
      }),
      executionMode: 'sequential',
      async execute(_id, params, signal, _onUpdate, ctx) {
        const result = await invoke(params.action, params.args?.trim() ?? '', ctx, signal);
        return { content: [{ type: 'text', text: result.text }], details: result.details ?? { ok: result.ok } };
      },
    }));
  });

  async function invoke(name: string, args: string, ctx: ExtensionContext, signal?: AbortSignal): Promise<ActionResult> {
    const spec = available.find(candidate => candidate.name === name);
    if (!spec) return { ok: false, text: `No action "${name}" is available to you here. Available: ${available.map(item => item.name).join(', ')}.` };
    const key = `${name} ${args}`;
    const repeats = recent.filter(entry => entry === key).length;
    const policy = modelPolicy(name, surface);
    const ask = policy === 'ask' || repeats + 1 >= settings.repeatLimit;
    if (ask) {
      if (!ctx.hasUI) return { ok: false, text: `${spec.usage.split(' ')[0]} needs your confirmation, and no one can answer here; it was not run.` };
      const why = policy === 'ask' ? '' : ` (the ${repeats + 1}${ordinal(repeats + 1)} identical call in a row)`;
      const go = await ctx.ui.confirm(`The agent wants to run ${spec.usage.split(' ')[0]} ${args}`.trim(), `${spec.summary}${why}`);
      if (!go) return { ok: false, text: 'You declined; it was not run. Ask the user what to do instead.' };
    }
    recent.push(key);
    if (recent.length > settings.repeatLimit) recent.shift();
    if (spec.execution === 'inline') {
      try { return await spec.run(args, { cwd: ctx.cwd, invokedBy: 'model', hasUI: ctx.hasUI, ui: ctx.ui, signal }); } catch (error) {
        return { ok: false, text: `${spec.name} failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
    if (running) return { ok: false, text: `${running.spec.usage.split(' ')[0]} is running; you cannot start another workflow from inside it. Work on it directly.` };
    if (queue.length) return { ok: false, text: `${queue[0]!.spec.usage.split(' ')[0]} is already queued. End your turn; one workflow at a time.` };
    if (deferredStarted >= settings.maxDeferredPerSession) {
      return { ok: false, text: `You have started ${deferredStarted} workflows in this session, the limit (actions.maxDeferredPerSession). Ask the user to continue.` };
    }
    deferredStarted += 1;
    queue.push({ spec, args });
    return {
      ok: true,
      text: `Queued ${spec.usage.split(' ')[0]} ${args}. It starts when you end this turn, and Theoria's checked result comes back to you as a message. End your turn now without further work.`,
      details: { queued: spec.name, args },
    };
  }

  // The turn ended: run what the agent queued, as if typed.
  pi.on('agent_settled', () => {
    if (!queue.length || running) return;
    setTimeout(() => pi.sendUserMessage(`/${settings.queueCommand}`, { expandPromptTemplates: true }), 0);
  });

  pi.registerCommand(settings.queueCommand, {
    description: 'Run the Theoria workflow the agent queued (started automatically when its turn ends)',
    handler: async (_args, ctx) => {
      const next = queue.shift();
      if (!next) { ctx.ui.notify('The agent has queued nothing.', 'info'); return; }
      running = next;
      let result: ActionResult;
      try {
        result = await next.spec.run(next.args, { cwd: ctx.cwd, invokedBy: 'model', hasUI: ctx.hasUI, ui: ctx.ui, command: ctx as ExtensionCommandContext });
      } catch (error) {
        result = { ok: false, resumeAgent: false, text: `${next.spec.name} failed: ${error instanceof Error ? error.message : String(error)}` };
      } finally {
        running = undefined;
      }
      const head = `${next.spec.usage.split(' ')[0]} ${next.args}`.trim();
      const resume = result.resumeAgent !== false;
      pi.sendMessage(card(`Result of ${head}, which you asked for`, [result.text, '', resume ? 'Continue your task with this result.' : 'Workflow interrupted. Retry explicitly when ready.'], {
        ok: result.ok, tone: result.ok && resume ? 'success' : 'warning', result: result.details ?? null,
      }), { triggerTurn: resume });
    },
  });
}

function describeTool(specs: ActionSpec[]): string {
  return [
    'Run one of Theoria\'s commands, as the user would type it, and get its result. Results come from Theoria\'s tools and records, not from you: cite them as given.',
    'Workflows (deferred) start when you end your turn; their verdict is sent to you.',
    ...specs.map(spec => `- ${spec.name}: ${spec.usage} — ${spec.summary}${spec.execution === 'deferred' ? ' (deferred)' : ''}`),
  ].join('\n');
}

const ordinal = (n: number) => (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
