import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { provideActions, type ActionResult, type ActionSpec } from '@theoria/shared/actions';
import { registerCard } from '@theoria/shared/card';
import { config } from '@theoria/shared/config';
import { parseGoal } from '@theoria/shared/goals';
import { componentOn, currentProfile, loadedCommit } from '@theoria/shared/harness';
import { projectRoot } from '@theoria/shared/paths';
import { startingProjectType } from '@theoria/shared/project';
import { ago, bindRun } from '@theoria/shared/verdicts';
import { artifactCommand, artifactsCommand, artifactUsage, claimCommand, claimsCommand, claimUsage, type Who } from '../src/commands.ts';
import { registerArtifact } from '../src/artifacts.ts';
import { claimsLinkedTo, verifyClaim } from '../src/claims.ts';
import { runContext } from '../src/context.ts';
import { nextStepsPrompt, nextStepsUsage } from '../src/next-steps.ts';
import {
  createRun, getRun, goalMarker, goalObjective, lastSession, listRuns, runEvents, runLine, setStatus, updateRun, type Goal, type Harness, type ResearchRun,
} from '../src/runs.ts';

/**
 * Research runs in a Theoria session, and the project's claims and artifacts.
 *
 * A session belongs to at most one run: `/attack new` and `/attack fork` start a new session for the run, marked by a
 * custom entry in the session file, so resuming that conversation (or the bot's `--continue`) is back in the run.
 * While a session is in a run, the run's goal and the relevant project knowledge are added to the agent's
 * instructions before each turn, workflow verdicts are recorded in the run's events (`THEORIA_RUN_ID`), and claims,
 * artifacts and notes the agent records through the `theoria` tool carry the run's id.
 *
 * A run's autonomous work is pi-goal-x's: `/attack new` can start a pi-goal-x goal whose objective begins with the run's
 * marker. When pi-goal-x marks that goal complete it is recorded as the agent's and auditor's judgement; only you
 * complete the run (`/attack complete`).
 */

const entryType = 'theoria-run';
type Ctx = ExtensionCommandContext;

export default function research(pi: ExtensionAPI) {
  if (!componentOn('research')) return;
  const card = registerCard(pi, 'theoria-run');
  let current: ResearchRun | undefined;

  const who = (by: Who['by']): Who => ({ by, ...(current ? { runId: current.id } : {}) });
  const sameProject = (a: string, b: string) => { try { return realpathSync(projectRoot(a)) === realpathSync(projectRoot(b)); } catch { return false; } };
  const refresh = (cwd: string) => {
    if (current) current = sameProject(current.workspace, cwd) ? getRun(cwd, current.id) : undefined;
    bindRun(cwd, current?.id);
    return current;
  };

  function bound(ctx: ExtensionContext): string | undefined {
    const entries = ctx.sessionManager.getEntries() as { type: string; customType?: string; data?: { runId?: string; projectRoot?: string } }[];
    const binding = [...entries].reverse().find(entry => entry.type === 'custom' && entry.customType === entryType)?.data;
    if (binding?.projectRoot && !sameProject(binding.projectRoot, ctx.cwd)) return undefined;
    return binding?.runId;
  }

  function footer(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus('theoria-run', current ? ctx.ui.theme.fg(current.status === 'active' ? 'accent' : 'dim', `${current.id} ${current.status === 'active' ? '' : `(${current.status}) `}· ${current.goal.objective.split('\n')[0]!.slice(0, 40)}`) : undefined);
  }

  pi.on('session_start', (_event, ctx) => {
    const id = bound(ctx);
    current = id ? getRun(ctx.cwd, id) : undefined;
    if (current && !sameProject(current.workspace, ctx.cwd)) current = undefined;
    bindRun(ctx.cwd, current?.id);
    if (current) {
      const file = ctx.sessionManager.getSessionFile();
      if (file && !current.sessions.includes(file)) {
        current = updateRun(ctx.cwd, current.id, run => { run.sessions.push(file); }, { type: 'run.session', payload: { session: basename(file) } });
      }
      linkGoal(ctx);
    }
    footer(ctx);
  });

  pi.on('session_shutdown', (_event, ctx) => { bindRun(ctx.cwd); current = undefined; });

  pi.on('before_agent_start', (event, ctx) => {
    if (!refresh(ctx.cwd) || current!.status === 'completed' || current!.status === 'cancelled') { delete event.systemPromptOptions.sections['research-run']; return; }
    if (!current!.harness.systemPromptHash) {
      const hash = createHash('sha256').update(event.systemPrompt).digest('hex').slice(0, 16);
      current = updateRun(ctx.cwd, current!.id, run => { run.harness.systemPromptHash = hash; });
    }
    linkGoal(ctx);
    // A section of Pi's structured prompt, recorded in the transcript; Pi sends it again only when it changed.
    event.systemPromptOptions.sections['research-run'] = runContext(ctx.cwd, current!);
  });

  // After each turn: a verified claim whose file a workflow changed is rechecked, and pi-goal-x's verdict noted.
  pi.on('agent_settled', (_event, ctx) => { if (current) linkGoal(ctx); });

  /** Links the run to its pi-goal-x goal by the marker, and records once when pi-goal-x marks it complete. */
  function linkGoal(ctx: ExtensionContext) {
    if (!current) return;
    const marker = goalMarker(current);
    const root = projectRoot(ctx.cwd);
    const scan = (dir: string) => { try { return readdirSync(join(root, dir)).filter(name => name.endsWith('.md')).map(name => parseGoal(readFileSync(join(root, dir, name), 'utf8'))); } catch { return []; } };
    const open = scan(config().goals.dir).find(goal => goal?.objective.startsWith(marker));
    const done = scan(config().goals.archivedDir).find(goal => goal?.objective.startsWith(marker));
    const goal = open ?? done;
    if (goal && current.piGoalId !== goal.id) current = updateRun(ctx.cwd, current.id, run => { run.piGoalId = goal.id; }, { type: 'goal.linked', payload: { piGoalId: goal.id } });
    if (done && !runEvents(ctx.cwd, current.id).some(event => event.type === 'goal.marked_complete')) {
      updateRun(ctx.cwd, current.id, () => {}, { type: 'goal.marked_complete', payload: { piGoalId: done.id, status: done.status, judgement: 'pi-goal-x: the agent and its auditor, not Lean' } });
      if (ctx.hasUI) ctx.ui.notify(`pi-goal-x marked ${current.id}'s goal complete. That is the agent's and auditor's judgement; /attack complete closes the run.`, 'info');
    }
  }

  function harness(ctx: ExtensionContext): Harness {
    const commit = loadedCommit();
    const extensions = (process.env.THEORIA_PACKAGES ?? '').split(',').filter(Boolean);
    return {
      ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}), profile: currentProfile().name, piVersion: VERSION, ...(commit ? { theoriaCommit: commit } : {}),
      ...(startingProjectType() ? { projectType: startingProjectType()!.type } : {}), extensions,
    };
  }

  /** Starts a new session that belongs to `run`, with an opening card, and pi-goal-x's goal when asked. */
  async function enter(ctx: Ctx, run: ResearchRun, opening: string[], autonomous: boolean) {
    const goalCommand = pi.getCommands().some(command => command.name === 'goal-direct');
    const result = await ctx.newSession({
      setup: async manager => { manager.appendCustomEntry(entryType, { runId: run.id, projectRoot: projectRoot(ctx.cwd) }); },
      withSession: async next => {
        await next.sendMessage(card(`Research run ${run.id}`, opening, { ok: true, tone: 'accent' }));
        if (autonomous && goalCommand) await next.sendUserMessage(`/goal-direct ${goalObjective(run)}`, { expandPromptTemplates: true });
      },
    });
    if (result.cancelled) ctx.ui.notify(`${run.id} was created, but the session did not switch. /attack resume ${run.id} enters it.`, 'warning');
  }

  function goalOpening(run: ResearchRun, autonomous: boolean, hasGoals: boolean) {
    return [
      `Objective: ${run.goal.objective}`,
      ...(run.goal.successCriteria?.length ? ['Success criteria:', ...run.goal.successCriteria.map(item => `- ${item}`)] : []),
      ...(run.parentRunId ? [`Forked from ${run.parentRunId}: the project's claims and artifacts carry over, the conversation does not.`] : []),
      '',
      autonomous && hasGoals ? 'pi-goal-x works on it autonomously; /attack pause stops it.' : 'Work on it in this conversation; /attack status shows where it stands.',
    ];
  }

  async function newRun(ctx: Ctx, args: string, parent?: ResearchRun) {
    if (!ctx.isIdle()) { ctx.ui.notify('The agent is busy. Wait for it to finish, or press Esc.', 'warning'); return; }
    let objective = args.trim() || (parent ? '' : (await ctx.ui.input('Objective of the research run', 'e.g. Determine whether the spectral route proves T'))?.trim() || '');
    if (parent && !objective) objective = (await ctx.ui.input(`Objective of the fork (empty keeps ${parent.id}'s)`, parent.goal.objective.slice(0, 80)))?.trim() || parent.goal.objective;
    if (!objective) return;
    let successCriteria: string[] | undefined = parent?.goal.successCriteria;
    if (ctx.hasUI && !args.trim()) {
      const criteria = (await ctx.ui.input('Success criteria (separate with ;), or empty', parent?.goal.successCriteria?.join('; ') ?? ''))?.trim();
      if (criteria) successCriteria = criteria.split(';').map(item => item.trim()).filter(Boolean);
    }
    const hasGoals = pi.getCommands().some(command => command.name === 'goal-direct');
    const autonomous = hasGoals && ctx.hasUI ? await ctx.ui.confirm(`Start ${parent ? 'the fork' : 'the run'}: work on it autonomously now?`, `pi-goal-x keeps the agent working on the goal across turns until it is done, blocked or paused (in the bot at most ${config().goals.botMaxAutonomousRuns} runs).\n\n${objective}`) : false;
    const goal: Goal = { objective, ...(successCriteria?.length ? { successCriteria } : {}), ...(parent?.goal.context ? { context: parent.goal.context } : {}) };
    const run = createRun(ctx.cwd, { goal, harness: parent ? { ...parent.harness, ...harness(ctx), systemPromptHash: undefined } : harness(ctx), ...(parent ? { parentRunId: parent.id } : {}) });
    await enter(ctx, run, goalOpening(run, autonomous, hasGoals), autonomous);
  }

  async function chooseRun(ctx: Ctx, title: string, filter: (run: ResearchRun) => boolean): Promise<ResearchRun | undefined> {
    const runs = listRuns(ctx.cwd).filter(filter).reverse();
    if (!runs.length) { ctx.ui.notify('No such runs. /attack new starts one.', 'info'); return undefined; }
    const labels = runs.map(run => `${run.id === current?.id ? '● ' : ''}${runLine(run)}`);
    const picked = await ctx.ui.select(title, labels);
    return picked ? runs[labels.indexOf(picked)] : undefined;
  }

  async function resume(ctx: Ctx, id: string) {
    const run = id ? getRun(ctx.cwd, id) : await chooseRun(ctx, 'Resume which run?', candidate => candidate.status !== 'completed' && candidate.status !== 'cancelled');
    if (!run) { if (id) ctx.ui.notify(`No run ${id}.`, 'error'); return; }
    if (run.status === 'paused') setStatus(ctx.cwd, run.id, 'active');
    const file = lastSession(run);
    const hasGoals = pi.getCommands().some(command => command.name === 'goal-resume');
    const after = async (next: { sendMessage: (message: ReturnType<typeof card>) => Promise<void>; sendUserMessage: (text: string, options: { expandPromptTemplates: boolean }) => Promise<void> }) => {
      await next.sendMessage(card(`Resumed ${run.id}`, [run.goal.objective, ...(run.status === 'paused' ? ['It was paused; it is active again.'] : [])], { ok: true, tone: 'accent' }));
      if (run.status === 'paused' && run.piGoalId && hasGoals) await next.sendUserMessage('/goal-resume', { expandPromptTemplates: true });
    };
    if (file && file !== ctx.sessionManager.getSessionFile()) { await ctx.switchSession(file, { withSession: after }); return; }
    if (file) { ctx.ui.notify(`You are in ${run.id}.`, 'info'); return; }
    await enter(ctx, run, ['A new conversation for the run.', `Objective: ${run.goal.objective}`], false);
  }

  function statusText(cwd: string, run: ResearchRun | undefined): ActionResult {
    if (!run) return { ok: true, text: 'This session is not in a research run. /attack new starts one, /runs lists them.', details: { run: null } };
    const fresh = getRun(cwd, run.id) ?? run;
    const events = runEvents(cwd, fresh.id);
    const verdicts = events.filter(event => event.type === 'verdict.recorded').slice(-5);
    const marked = events.find(event => event.type === 'goal.marked_complete');
    return {
      ok: true,
      text: [
        runLine(fresh),
        ...(fresh.goal.successCriteria?.length ? ['Success criteria:', ...fresh.goal.successCriteria.map(item => `  - ${item}`)] : []),
        ...(fresh.goal.currentFocus ? [`Focus: ${fresh.goal.currentFocus}`] : []),
        `Claims made ${fresh.createdClaimIds.length || countBy(events, 'claim.created')} · artifacts ${countBy(events, 'artifact.created')} · sessions ${fresh.sessions.length} · started ${ago(fresh.createdAt)}`,
        ...(fresh.piGoalId ? [`pi-goal-x goal ${fresh.piGoalId}${marked ? ': marked complete (agent and auditor, not Lean)' : ''}`] : []),
        ...(verdicts.length ? ['Verdicts (Theoria\'s check):', ...verdicts.map(event => { const v = event.payload as { workflow?: string; theorem?: string; outcome?: string }; return `  /${v.workflow}${v.theorem ? ` ${v.theorem}` : ''} · ${v.outcome} · ${ago(event.timestamp)}`; })] : []),
        `Harness: ${[fresh.harness.model, fresh.harness.piVersion && `Pi ${fresh.harness.piVersion}`, fresh.harness.theoriaCommit && `Theoria ${fresh.harness.theoriaCommit}`, fresh.harness.projectType].filter(Boolean).join(' · ')}`,
      ].join('\n'),
      details: { run: fresh },
    };
  }

  function updateGoal(cwd: string, args: string, by: Who['by']): ActionResult {
    if (!current) return { ok: false, text: 'This session is not in a research run.' };
    const [field = '', ...rest] = args.trim().split(/\s+/);
    const value = rest.join(' ').trim();
    if (field === 'focus' && value) {
      current = updateRun(cwd, current.id, run => { run.goal.currentFocus = value; }, { type: 'goal.updated', payload: { focus: value, by } });
      return { ok: true, text: `${current.id} focus: ${value}`, details: { goal: current.goal } };
    }
    if (field === 'note' && value) {
      current = updateRun(cwd, current.id, run => { run.goal.notes = [...(run.goal.notes ?? []), value]; }, { type: 'goal.updated', payload: { note: value, by } });
      return { ok: true, text: `${current.id}: noted.`, details: { goal: current.goal } };
    }
    if (field === 'ready') {
      updateRun(cwd, current.id, () => {}, { type: 'run.ready_for_review', payload: { summary: value, by } });
      return { ok: true, text: `${current.id} is marked ready for your review${value ? `: ${value}` : ''}. Only the user completes a run.` };
    }
    return { ok: false, text: 'Usage: /attack update focus <text> | note <text> | ready [summary]' };
  }

  // ── Commands ────────────────────────────────────────────────────────────────────────────────────────────────

  const runActions = [
    { value: 'status', description: 'This session\'s run: goal, claims, verdicts' },
    { value: 'new', description: 'Start a research run with a persistent goal' },
    { value: 'fork', description: 'A new run from this one: its goal, a fresh conversation' },
    { value: 'resume', description: 'Back into a run' },
    { value: 'pause', description: 'Pause this run (and its autonomous goal)' },
    { value: 'complete', description: 'Close this run' },
    { value: 'update', description: 'focus <text> · note <text> · ready [summary]' },
  ];

  pi.registerCommand('attack', {
    description: 'Attack a research objective: status · new · fork · resume · pause · complete · update',
    getArgumentCompletions: prefix => runActions.filter(action => action.value.startsWith(prefix.trim())).map(action => ({ value: action.value, label: action.value, description: action.description })),
    handler: async (args, ctx) => {
      let [action = '', ...rest] = args.trim().split(/\s+/);
      if (!action && ctx.hasUI) action = (await ctx.ui.select(current ? `Run ${current.id}` : 'Research runs', runActions.map(entry => `${entry.value} — ${entry.description}`)))?.split(' — ')[0] ?? '';
      const tail = rest.join(' ');
      refresh(ctx.cwd);
      switch (action) {
        case '': return;
        case 'status': ctx.ui.notify(statusText(ctx.cwd, current).text, 'info'); return;
        case 'new': return newRun(ctx, tail);
        case 'fork': {
          const parent = current ?? (tail.match(/^run-\d+$/) ? getRun(ctx.cwd, tail) : undefined);
          if (!parent) { ctx.ui.notify('Fork from inside a run (/attack resume), or /attack fork run-003.', 'info'); return; }
          return newRun(ctx, parent === current ? tail : '', parent);
        }
        case 'resume': return resume(ctx, tail);
        case 'pause': case 'complete': {
          if (!current) { ctx.ui.notify('This session is not in a research run.', 'info'); return; }
          if (action === 'complete' && ctx.hasUI && !await ctx.ui.confirm(`Complete ${current.id}?`, `${current.goal.objective}\n\nIts claims and artifacts stay in the project.`)) return;
          current = setStatus(ctx.cwd, current.id, action === 'pause' ? 'paused' : 'completed', tail || undefined);
          const open = current.piGoalId && !runEvents(ctx.cwd, current.id).some(event => event.type === 'goal.marked_complete');
          const goalCommand = action === 'pause' ? 'goal-pause' : 'goal-clear';
          if (open && pi.getCommands().some(command => command.name === goalCommand)) pi.sendUserMessage(`/${goalCommand}`, { expandPromptTemplates: true });
          footer(ctx);
          ctx.ui.notify(`${current.id} is ${current.status}.`, 'info');
          return;
        }
        case 'update': { const result = updateGoal(ctx.cwd, tail, 'user'); ctx.ui.notify(result.text, result.ok ? 'info' : 'warning'); footer(ctx); return; }
        default: ctx.ui.notify('Usage: /attack [status | new <objective> | fork [objective] | resume [run-id] | pause | complete | update …]', 'error');
      }
    },
  });

  // The agent reads the sources and answers in the conversation; nothing is recorded until you ask for it.
  pi.registerCommand('next-steps', {
    description: `Suggest ranked next research steps for papers or a line of research: ${nextStepsUsage}`,
    handler: async (args, ctx) => {
      let prompt: ReturnType<typeof nextStepsPrompt>;
      try { prompt = nextStepsPrompt(ctx.cwd, args); }
      catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'info'); return; }
      // While the agent is still working, queue it after the current turn instead of interrupting it.
      if (ctx.isIdle()) pi.sendUserMessage(prompt.text);
      else { pi.sendUserMessage(prompt.text, { deliverAs: 'followUp' }); ctx.ui.notify('Queued /next-steps after the current turn.', 'info'); }
    },
  });

  pi.registerCommand('runs', {
    description: 'The project\'s research runs, with forks',
    handler: async (_args, ctx) => {
      const runs = listRuns(ctx.cwd);
      if (!runs.length) { ctx.ui.notify('No research runs yet. /attack new starts one.', 'info'); return; }
      ctx.ui.notify(runTree(runs, current?.id).join('\n'), 'info');
    },
  });

  pi.registerCommand('claims', { description: 'The project\'s claims: /claims [hypothesis|supported|verified|refuted|stale]', handler: async (args, ctx) => { ctx.ui.notify(claimsCommand(ctx.cwd, args).text, 'info'); } });
  pi.registerCommand('claim', {
    description: `A claim: ${claimUsage}`,
    getArgumentCompletions: prefix => ['new', 'set', 'edit', 'link', 'verify'].filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value })),
    handler: async (args, ctx) => { const result = await claimCommand(ctx.cwd, args, who('user')); ctx.ui.notify(result.text, result.ok ? 'info' : 'warning'); },
  });
  pi.registerCommand('artifacts', { description: 'The project\'s artifacts', handler: async (_args, ctx) => { ctx.ui.notify(artifactsCommand(ctx.cwd).text, 'info'); } });
  pi.registerCommand('artifact', { description: `An artifact: ${artifactUsage}`, handler: async (args, ctx) => { const result = artifactCommand(ctx.cwd, args, who('user')); ctx.ui.notify(result.text, result.ok ? 'info' : 'warning'); } });

  // ── Actions for the agent ───────────────────────────────────────────────────────────────────────────────────

  provideActions(pi, (): ActionSpec[] => [
    { name: 'claims', usage: '/claims [status]', summary: 'List the project\'s claims and their status.', execution: 'inline', run: async (args, actx) => claimsCommand(actx.cwd, args) },
    { name: 'claim', usage: claimUsage, summary: 'Show, record, change or link a claim. Only Theoria verifies: `verify` asks Lean (formal), `test` runs a statistical test on a data file (statistical).', execution: 'inline', run: (args, actx) => claimCommand(actx.cwd, args, who('model')) },
    { name: 'artifacts', usage: '/artifacts', summary: 'List the project\'s artifacts.', execution: 'inline', run: async (_args, actx) => artifactsCommand(actx.cwd) },
    { name: 'artifact', usage: artifactUsage, summary: 'Register a project file as an artifact of this run.', execution: 'inline', run: async (args, actx) => artifactCommand(actx.cwd, args, who('model')) },
    { name: 'run-status', usage: '/attack status', summary: 'This run\'s goal, verdicts and progress.', execution: 'inline', run: async (_args, actx) => statusText(actx.cwd, refresh(actx.cwd)) },
    { name: 'run-update', usage: '/attack update focus <text> | note <text> | ready [summary]', summary: 'Record the run\'s current focus or a note, or tell the user it is ready for review.', execution: 'inline', run: async (args, actx) => updateGoal(actx.cwd, args, 'model') },
    {
      name: 'run-fork', usage: '/attack fork <objective>', summary: 'Branch a new run from this one (a fresh conversation; claims carry over).', execution: 'deferred',
      run: async (args, actx) => {
        if (!current || !actx.command) return { ok: false, text: 'Forking needs a run and runs only deferred.' };
        await newRun(actx.command, args, current);
        return { ok: true, text: `Forked a new run from ${current.id}.` };
      },
    },
  ]);

  // A workflow that passed: its file becomes an artifact of the run, and claims linked to that file are checked again.
  pi.on('message_end', async (event, ctx) => {
    const message = event.message as { customType?: string; details?: { ok?: boolean; file?: string; theorem?: string } };
    if (message.customType !== 'theoria-verdict' || !message.details?.ok || !message.details.file) return;
    try { registerArtifact(ctx.cwd, { path: message.details.file, kind: 'proof', ...(current ? { runId: current.id } : {}), ...(message.details.theorem ? { metadata: { theorem: message.details.theorem } } : {}) }); } catch { /* not a file any more */ }
    for (const claim of claimsLinkedTo(ctx.cwd, message.details.file)) {
      if (claim.status !== 'verified') await verifyClaim(ctx.cwd, claim.id, current?.id).catch(() => undefined);
    }
  });
}

const countBy = (events: { type: string }[], type: string) => events.filter(event => event.type === type).length;

/** Runs as a tree of forks. */
export function runTree(runs: ResearchRun[], currentId?: string): string[] {
  const children = new Map<string, ResearchRun[]>();
  for (const run of runs) if (run.parentRunId) children.set(run.parentRunId, [...(children.get(run.parentRunId) ?? []), run]);
  const out: string[] = [];
  const walk = (run: ResearchRun, depth: number) => {
    out.push(`${'  '.repeat(depth)}${depth ? '└ ' : ''}${run.id === currentId ? '● ' : ''}${runLine(run)}`);
    for (const child of children.get(run.id) ?? []) walk(child, depth + 1);
  };
  for (const run of runs.filter(entry => !entry.parentRunId || !runs.some(other => other.id === entry.parentRunId)).slice(-config().research.statusMaxRuns)) walk(run, 0);
  return out;
}
