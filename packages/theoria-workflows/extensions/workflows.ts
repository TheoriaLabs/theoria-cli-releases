import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { ready, resolve as resolveEnvironment, type Environment } from '@theoria/pi-lean/api';
import { provideActions, type ActionResult } from '@theoria/shared/actions';
import { startingProjectType } from '@theoria/shared/project';
import { recentVerdicts } from '@theoria/shared/verdicts';
import { formalize } from '../src/formalize.ts';
import { compress } from '../src/compress.ts';
import { prove } from '../src/prove.ts';
import { loadPrompt, PromptError, workflowNames, type WorkflowName, type WorkflowPrompt } from '../src/prompt.ts';
import { WorkflowRuntime, type Ctx } from '../src/runtime.ts';
import { resolveTarget } from '../src/target.ts';
import { refreshInventory } from '../src/inventory.ts';
import { measureProgress } from '../src/progress.ts';
import { compressSkillPath, compressWorkflowGuideline } from '../src/compress-skill.ts';
import { keepAwake } from '@theoria/shared/process';
import { config } from '@theoria/shared/config';
import { compressionMetricsText } from '../src/compression-metrics.ts';

/**
 * /formalize, /prove and /compress: prompt-driven workflows whose results Lean decides.
 *
 * Each is a loop. Theoria fixes the target and keeps a copy of the file, hands the agent the prompt from the
 * workflow's Markdown file, waits for it to stop, then runs its own check, which the prompt cannot change. A failed
 * check goes back to the agent with Lean's messages until the attempts run out. The run ends with a verdict card; a
 * failed or cancelled run restores the file and keeps the attempt under the project's attempts directory.
 *
 * Only the workflows the project's type enables are registered (`projectTypes.<type>.workflows`), so a project
 * without them has no such commands at all.
 */
export default function workflows(pi: ExtensionAPI) {
  const type = startingProjectType();
  const enabled = workflowNames.filter(name => type?.settings.workflows.includes(name));
  const unknown = (type?.settings.workflows ?? []).filter(name => !(workflowNames as string[]).includes(name));
  if (unknown.length) {
    pi.on('session_start', (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify(`Project type ${type!.type} lists ${unknown.map(name => `/${name}`).join(', ')}, which Theoria does not have.`, 'warning');
    });
  }
  if (!enabled.length) return;
  // Register conditionally rather than through the package manifest: the skill follows /compress availability.
  if (enabled.includes('compress')) pi.on('resources_discover', () => ({ skillPaths: [compressSkillPath] }));
  const rt = new WorkflowRuntime(pi);
  let running: WorkflowName | undefined;
  let active: AbortController | undefined;
  pi.on('session_shutdown', () => active?.abort());

  const run: Record<WorkflowName, (ctx: Ctx, args: string, prompt: WorkflowPrompt, environment: Environment) => Promise<unknown>> = {
    formalize: (ctx, args, prompt, environment) => formalize(rt, ctx, resolveTarget(args, ctx.cwd), prompt, environment, false),
    prove: (ctx, args, prompt, environment) => prove(rt, ctx, resolveTarget(args, ctx.cwd), prompt, environment),
    compress: (ctx, args, prompt, environment) => compress(rt, ctx, resolveTarget(args, ctx.cwd), prompt, environment),
  };

  /**
   * One workflow run, for the slash command and for the agent (through the actions hub). The result is the verdict
   * Theoria recorded for it, never the agent's account of it.
   */
  async function runWorkflow(name: WorkflowName, args: string, ctx: Ctx): Promise<ActionResult> {
    if (running) return { ok: false, text: `/${running} is still running. Press Esc or run /workflow-cancel to stop it first.` };
    if (!ctx.isIdle()) return { ok: false, text: 'The agent is busy. Wait for it to finish, or press Esc.' };
    let prompt: WorkflowPrompt;
    try { prompt = loadPrompt(name, ctx.cwd); } catch (error) {
      return { ok: false, text: error instanceof PromptError ? error.message : String(error) };
    }
    const environment = await resolveEnvironment(ctx.cwd);
    if (!ready(environment)) {
      return { ok: false, resumeAgent: false, text: `/${name} needs a Lean environment: ${environment.problem ?? 'none is chosen'}. Choose one with /lean config.` };
    }
    if (!args.trim()) return { ok: false, text: `Usage: /${name} ${prompt.settings.argumentHint}` };
    running = name;
    const started = new Date();
    rt.startedAt = started.getTime();
    rt.cwd = ctx.cwd;
    const controller = new AbortController();
    active = controller;
    rt.signal = controller.signal;
    const release = keepAwake(config().workflows.awake.preventSleep, message => ctx.ui.notify(message, 'warning'));
    let unhook: (() => void) | undefined;
    let restoreModel = async () => {};
    try {
      unhook = ctx.mode === 'tui' ? ctx.ui.onTerminalInput(data => {
        if (data === '\u001b') { controller.abort(); ctx.abort(); return { consume: true }; }
        return undefined;
      }) : undefined;
      restoreModel = await useModel(pi, ctx, prompt);
      await run[name](ctx, args, prompt, environment);
    } finally {
      release();
      unhook?.();
      active = undefined;
      running = undefined;
      rt.startedAt = undefined;
      rt.theorem = undefined;
      rt.file = undefined;
      rt.cwd = undefined;
      rt.signal = undefined;
      rt.targetDetails = {};
      // What Lean now says about the project's theorems and its target, in the background: /project status and
      // Telegram's /status read it from the cache.
      const cwd = ctx.cwd;
      void refreshInventory(cwd).then(() => measureProgress(cwd)).catch(() => { /* reported by /project status */ });
      rt.status(ctx, undefined);
      await restoreModel();
    }
    const verdict = recentVerdicts(ctx.cwd, 1).find(entry => entry.workflow === name && new Date(entry.at) >= started);
    if (!verdict) return { ok: false, resumeAgent: false, text: `/${name} ended without a verdict (cancelled, or it stopped before Theoria's check).`, details: { workflow: name, verdict: null } };
    const metrics = name === 'compress' ? compressionMetricsText(verdict) : '';
    const rounds = verdict.roundsRequested === undefined ? '' : ` · rounds ${verdict.roundsCompleted}/${verdict.roundsRequested} completed`;
    return {
      ok: verdict.ok,
      resumeAgent: !verdict.interrupted,
      text: `/${name}${verdict.theorem ? ` ${verdict.theorem}` : verdict.file ? ` ${verdict.file}` : ''}: ${verdict.outcome}${rounds}${metrics ? ` · ${metrics}` : ''} (Theoria's check${verdict.ok ? ', passed' : ''}).`,
      details: { workflow: name, verdict },
    };
  }

  pi.registerCommand('workflow-cancel', {
    description: 'Cancel the active Lean workflow, including an in-flight Lean check',
    handler: async (_args, ctx) => {
      if (!active) { ctx.ui.notify('No Lean workflow is running.', 'info'); return; }
      active.abort(); ctx.abort();
    },
  });

  for (const name of enabled) {
    pi.registerCommand(name, {
      description: describe(name),
      handler: async (args, ctx) => {
        const result = await runWorkflow(name, args, ctx);
        // A verdict has its own card; only a refusal needs saying.
        if (!result.details) ctx.ui.notify(result.text, result.text.startsWith('Usage') ? 'info' : 'warning');
      },
    });
  }

  provideActions(pi, () => enabled.map(name => ({
    name,
    usage: `/${name} ${argumentHint(name)}`,
    summary: summaryOf(name),
    ...(name === 'compress' ? { promptGuidelines: [compressWorkflowGuideline()] } : {}),
    execution: 'deferred' as const,
    run: (args, actx) => (actx.command ? runWorkflow(name, args, actx.command) : Promise.resolve({ ok: false, text: `/${name} runs only as a deferred action.` })),
  })));
}

/** A prompt may name the model its workflow runs on; the session's model comes back afterwards. */
async function useModel(pi: ExtensionAPI, ctx: Ctx, prompt: WorkflowPrompt): Promise<() => Promise<void>> {
  if (!prompt.settings.model) return async () => {};
  const [provider, ...rest] = prompt.settings.model.split('/');
  const model = ctx.modelRegistry.find(provider!, rest.join('/'));
  if (!model) {
    ctx.ui.notify(`${prompt.path} names model ${prompt.settings.model}, which is not available; using the current model.`, 'warning');
    return async () => {};
  }
  const previous = ctx.model;
  await pi.setModel(model);
  return async () => { if (previous) await pi.setModel(previous); };
}

const argumentHint = (name: WorkflowName) => { try { return loadPrompt(name, process.cwd()).settings.argumentHint; } catch { return '<target>'; } };
const summaries: Record<WorkflowName, string> = {
  formalize: 'Write a Lean statement for a natural-language claim, checked by Lean to be well-formed (no proof).',
  prove: 'Prove a theorem of the project (a name, a file, or a description), with attempts Lean checks; the file is restored if it fails.',
  compress: 'Optimize LOC and heartbeats for a Lean file or theorem/lemma, with optional rounds (default 1), verified checkpoints and early stopping.',
};
const summaryOf = (name: WorkflowName) => summaries[name];

function describe(name: WorkflowName) {
  try { return loadPrompt(name, process.cwd()).settings.description; } catch { return `Theoria /${name}`; }
}
