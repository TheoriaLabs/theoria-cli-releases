import { readFileSync } from 'node:fs';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { actionSurface, provideActions, type ActionResult } from '@theoria/shared/actions';
import { AgentTurn } from '@theoria/shared/agent-turn';
import { registerCard } from '@theoria/shared/card';
import { config } from '@theoria/shared/config';
import { componentOn } from '@theoria/shared/harness';
import { startingProjectType } from '@theoria/shared/project';
import { buildText, compile, openPdf } from '../src/build.ts';
import { parseCommand, status, usage, type LatexCommand } from '../src/commands.ts';
import { environment, installPackages, packageFor } from '../src/environment.ts';
import { paperSettings, projectFile, readState, rootOf, saveSettings } from '../src/state.ts';
import { writePaper } from '../src/workflow.ts';

export default function latex(pi: ExtensionAPI) {
  if (!componentOn('latex') || !startingProjectType()?.settings.latex) return;
  const agent = new AgentTurn(pi);
  const card = registerCard(pi, 'theoria-latex');
  let active: AbortController | undefined;
  const progress = (ctx: ExtensionCommandContext, text?: string) => ctx.ui.setStatus('theoria-workflow', text ? ctx.ui.theme.fg('warning', text) : undefined);
  const report = (title: string, result: ActionResult) => pi.sendMessage(card(title, [result.text], { ok: result.ok, result: result.details }));
  const checkScope = (ctx: ExtensionCommandContext) => {
    if (rootOf(ctx.cwd) !== rootOf(ctx.sessionManager.getCwd())) throw new Error('The command and session project roots disagree. Select the project again with /project list.');
    const header = ctx.sessionManager.getHeader();
    if (header?.cwd && rootOf(ctx.cwd) !== rootOf(header.cwd)) throw new Error('This conversation belongs to a different project. Select the intended project with /project list before writing its paper.');
  };

  async function setup(ctx: ExtensionCommandContext): Promise<void> {
    if (actionSurface() !== 'terminal') { ctx.ui.notify('Run dependency setup in a terminal session; the bot uses the prepared installation.', 'info'); return; }
    const env = await environment(ctx.cwd);
    if (!env.compiler || !env.tlmgr) { ctx.ui.notify('Install TeX Live/BasicTeX first, then open /latex status to finish setup.', 'warning'); return; }
    const packages = [...env.missingPackages];
    for (const file of readState(ctx.cwd).lastBuild?.missing ?? []) {
      if (file === 'biber' || file === 'bibtex') { ctx.ui.notify(`${file} must be installed in your TeX distribution.`, 'warning'); continue; }
      const matches = await packageFor(ctx.cwd, file);
      if (matches.length === 1) packages.push(matches[0]!);
      else if (matches.length > 1) { const picked = await ctx.ui.select(`Package providing ${file}`, matches); if (picked) packages.push(picked); }
      else ctx.ui.notify(`No TeX Live package was found for ${file}.`, 'warning');
    }
    if (!packages.length) { ctx.ui.notify('Required LaTeX dependencies are ready.', 'info'); return; }
    if (!await ctx.ui.confirm('Set up LaTeX dependencies?', `Install ${[...new Set(packages)].join(', ')} in Theoria's directory using the installed TeX Live. latexmk is pinned; style packages use this distribution's repository.`)) return;
    const ownController = active ? undefined : new AbortController();
    if (ownController) active = ownController;
    progress(ctx, 'Setting up LaTeX…');
    try { ctx.ui.notify(await installPackages(ctx.cwd, packages, active?.signal, line => progress(ctx, line.slice(0, 100))), 'info'); }
    finally { if (ownController) active = undefined; progress(ctx); }
  }

  async function settingsMenu(ctx: ExtensionCommandContext) {
    const current = paperSettings(ctx.cwd);
    const engine = await ctx.ui.select('Paper compiler', config().latex.engines);
    if (!engine) return;
    const main = await ctx.ui.input('Paper entry point (relative to the project)', current.main);
    if (main === undefined) return;
    saveSettings(ctx.cwd, { main: main.trim() || current.main, engine });
    ctx.ui.notify(`Paper: ${main.trim() || current.main} · ${engine}`, 'info');
  }

  async function statusMenu(ctx: ExtensionCommandContext) {
    const result = await status(ctx.cwd);
    report('/latex status', { ok: !result.environment.problem, text: result.text });
    if (!ctx.hasUI) return;
    const selected = await ctx.ui.select('LaTeX', ['Done', ...(active ? ['Stop current operation'] : ['Set up dependencies', 'Compiler settings']), 'View build log']);
    if (selected === 'Stop current operation') { active?.abort(); ctx.abort(); }
    if (selected === 'Set up dependencies') await setup(ctx);
    if (selected === 'Compiler settings') await settingsMenu(ctx);
    if (selected === 'View build log') {
      const log = readState(ctx.cwd).lastBuild?.log;
      ctx.ui.notify(log ? readFileSync(projectFile(ctx.cwd, log), 'utf8').slice(-config().workflows.card.diagnosticsChars) : 'No build log yet.', 'info');
    }
  }

  async function execute(command: Exclude<LatexCommand, { name: 'menu' | 'status' }>, ctx: ExtensionCommandContext, interactive: boolean): Promise<ActionResult> {
    checkScope(ctx);
    if (active) return { ok: false, text: 'A LaTeX operation is running. Esc stops it; /latex status shows its progress.' };
    if (command.name !== 'pdf' && !ctx.isIdle()) return { ok: false, text: 'Wait for the agent to finish before starting a paper workflow.' };
    const controller = new AbortController();
    active = controller;
    const unhook = ctx.mode === 'tui' ? ctx.ui.onTerminalInput(data => { if (data === '\u001b') { controller.abort(); ctx.abort(); return { consume: true }; } return undefined; }) : undefined;
    try {
      const env = await environment(ctx.cwd);
      if (interactive && ctx.hasUI && (env.problem || env.missingPackages.length)) {
        await setup(ctx);
      }
      if (command.name === 'pdf') {
        progress(ctx, 'Compiling paper…');
        const build = await compile(ctx.cwd, { signal: controller.signal });
        let text = buildText(build);
        if (build.status === 'ok' && interactive && ctx.mode === 'tui') text += `\n${await openPdf(ctx.cwd, build)}`;
        return { ok: build.status === 'ok', text, details: build };
      }
      const result = await writePaper(ctx.cwd, command.name, command.request, {
        signal: controller.signal, progress: text => progress(ctx, text),
        turn: (text, signal, maxCostUsd) => agent.turn(ctx, text, { signal, maxCostUsd }),
      });
      return { ok: result.ok, text: result.text, details: result };
    } finally { active = undefined; unhook?.(); progress(ctx); }
  }

  pi.on('session_shutdown', () => active?.abort());
  pi.registerCommand('latex', {
    description: 'Project paper: paper create | paper update | pdf | status',
    getArgumentCompletions: prefix => ['paper create', 'paper update', 'pdf', 'status'].filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        checkScope(ctx);
        let command = parseCommand(args);
        if (command.name === 'menu') {
          if (!ctx.hasUI) { report('/latex', { ok: true, text: usage }); return; }
          const choice = await ctx.ui.select('LaTeX · one paper per project', ['paper create', 'paper update', 'pdf', 'status']);
          if (!choice) return;
          command = parseCommand(choice);
          if (command.name === 'create' || command.name === 'update') {
            const request = await ctx.ui.input(command.name === 'create' ? 'Paper focus (optional)' : 'Revision request (optional)');
            if (request === undefined) return;
            command.request = request;
          }
        }
        if (command.name === 'status') { await statusMenu(ctx); return; }
        if (command.name === 'menu') return;
        report(`/latex ${args || command.name}`, await execute(command, ctx, true));
      } catch (error) { report('/latex', { ok: false, text: error instanceof Error ? error.message : String(error) }); }
    },
  });

  provideActions(pi, () => [
    { name: 'latex-status', usage: '/latex status', summary: 'Show paper, compiler dependencies and whether its PDF is current.', execution: 'inline', run: async (_args, actx) => { const result = await status(actx.cwd); return { ok: !result.environment.problem, text: result.text, details: result.environment }; } },
    { name: 'latex-pdf', usage: '/latex pdf', summary: 'Compile this project\'s paper and return the compiler diagnostics and PDF path.', execution: 'inline', run: async (_args, actx) => { const build = await compile(actx.cwd, { signal: actx.signal }); return { ok: build.status === 'ok', text: buildText(build), details: build }; } },
    ...(['create', 'update'] as const).map(mode => ({
      name: `latex-${mode}`, usage: `/latex paper ${mode} [request]`, summary: `${mode === 'create' ? 'Create' : 'Update'} the project's paper using its research evidence, then compile and check it.`, execution: 'deferred' as const,
      run: async (args: string, actx: import('@theoria/shared/actions').ActionContext) => actx.command ? execute({ name: mode, request: args }, actx.command, false) : { ok: false, text: 'Paper writing runs as a deferred action.' },
    })),
  ]);
}
