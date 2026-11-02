import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { config } from '@theoria/shared/config';
import { provideActions } from '@theoria/shared/actions';
import { componentOn } from '@theoria/shared/harness';
import { startingProjectType } from '@theoria/shared/project';
import { label, ready } from '../src/environment.ts';
import { check, formatCheck } from '../src/check.ts';
import { instructions, searchInstructions, searchToolPrompt } from '../src/instructions.ts';
import { searchState } from '../src/search.ts';
import { actions, runAction } from '../src/menu.ts';
import { applyToProcess } from '../src/process-env.ts';
import { LeanState } from '../src/state.ts';

/**
 * /lean: which Lean and Mathlib a session uses, chosen by version.
 *
 * The choice reaches four places: the agent's instructions name it, the agent's shell runs `lean` with it, the
 * `lean_check` tool elaborates against it, and the footer shows it. A folder that is a Lean project of its own keeps
 * its own toolchain and dependencies, and /lean says so instead of overriding them.
 *
 * Registered only for a project type with `lean: true`.
 */
export default function lean(pi: ExtensionAPI) {
  if (!startingProjectType()?.settings.lean) return;
  const state = new LeanState();

  pi.registerTool(defineTool({
    name: 'lean_check',
    label: 'Lean check',
    description: 'Elaborate Lean 4 code or a .lean file against the Lean and Mathlib version the user selected, and report errors, '
      + 'whether it uses sorry, and the axioms named theorems depend on. Set measureHeartbeats to profile command elaboration. Use it to check every Lean proof or statement.',
    promptSnippet: 'lean_check: elaborate Lean 4 code or a file with the selected Lean and Mathlib; reports errors, sorry and axioms',
    parameters: Type.Object({
      code: Type.Optional(Type.String({ description: 'Lean source to check, including its imports (e.g. `import Mathlib`).' })),
      path: Type.Optional(Type.String({ description: 'A .lean file to check instead of code, relative to the working directory.' })),
      theorems: Type.Optional(Type.Array(Type.String(), { description: 'Theorem names whose axioms to report.' })),
      measureHeartbeats: Type.Optional(Type.Boolean({ description: 'Measure serial command-elaboration heartbeats, overall and per command, after checking the source.' })),
      timeoutSeconds: Type.Optional(Type.Number({
        description: `Time limit; default ${config().lean.check.defaultTimeoutSeconds}. Importing Mathlib takes 10–40 s.`,
      })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const environment = await state.refresh(ctx.cwd);
      const result = await check(environment, { ...params, cwd: ctx.cwd, signal });
      return { content: [{ type: 'text', text: formatCheck(result) }], details: result };
    },
  }));

  pi.on('session_start', async (_event, ctx) => {
    if (ctx.hasUI) state.ui = ctx.ui;
    await state.refresh(ctx.cwd);
  });

  pi.on('session_shutdown', () => {
    state.installing?.controller.abort();
    state.ui = undefined;
    // The next session may be a project without Lean; it must not inherit this one's toolchain.
    applyToProcess({ source: 'none' });
  });

  // The agent's instructions name the environment, so it does not guess at versions or try to change them. They are
  // sections of Pi's structured prompt, not a replacement of it: every transcript records exactly what the model read.
  pi.on('before_agent_start', async (event, ctx) => {
    const environment = await state.refresh(ctx.cwd);
    const options = event.systemPromptOptions;
    options.sections['lean-environment'] = instructions(environment);
    const server = config().leanSearch.server;
    if (componentOn('search') && (await searchState(ctx.cwd, environment)).state === 'on') {
      options.sections['mathlib-search'] = searchInstructions(server);
      // The search tools' lines in the <tools> summary, and their rule. Pi shows a line and a rule only for a tool the
      // request declares, so they appear once the MCP server has connected and never for a tool the session lacks.
      const { snippets, guidelines } = searchToolPrompt(server);
      Object.assign(options.toolSnippets, snippets);
      Object.assign(options.toolGuidelines, guidelines);
    } else delete options.sections['mathlib-search'];
  });

  provideActions(pi, () => [{
    name: 'lean-status', usage: '/lean status', summary: 'The Lean and Mathlib this session uses, and whether Mathlib search is on.', execution: 'inline',
    run: async (_args, actx) => {
      const environment = await state.refresh(actx.cwd);
      const search = await searchState(actx.cwd, environment);
      return { ok: ready(environment), text: [`${label(environment)}${ready(environment) ? '' : `: not ready (${environment.problem ?? 'none chosen'})`}`, search.line].join('\n'), details: { environment: label(environment), ready: ready(environment), search: search.state } };
    },
  }]);

  pi.registerCommand('lean', {
    description: `Lean and Mathlib: ${actions.map(action => action.value).join(' | ')}`,
    getArgumentCompletions: prefix => [...actions, ...['status', 'install', 'remove'].map(sub => ({ value: `search ${sub}`, label: `search ${sub}`, description: `Mathlib search: ${sub}` })), ...['status', 'install hammer', 'on hammer', 'off hammer'].map(sub => ({ value: `extras ${sub}`, label: `extras ${sub}`, description: `Lean add-ons: ${sub}` }))]
      .filter(action => action.value.startsWith(prefix.trim())),
    handler: async (args, ctx) => {
      if (!ctx.hasUI) return;
      state.ui = ctx.ui;
      const [first = '', ...rest] = args.trim().split(/\s+/);
      let action = first.toLowerCase();
      if (!action) {
        const picked = await ctx.ui.select('Lean', actions.map(entry => `${entry.value} — ${entry.description}`));
        action = picked?.split(' — ')[0] ?? '';
        if (!action) return;
      }
      await runAction(state, ctx, action, rest.join(' '));
    },
  });
}
