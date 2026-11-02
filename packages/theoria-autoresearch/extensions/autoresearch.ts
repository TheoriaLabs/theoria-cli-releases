import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI, type ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { actionSurface, provideActions, type ActionResult } from '@theoria/shared/actions';
import { AgentTurn } from '@theoria/shared/agent-turn';
import { Campaign } from '../src/campaign.ts';
import { campaignAlive, campaignBudget, campaignManifest, campaignRoot, createCampaign, readCampaign, updateCampaign } from '../src/campaign-store.ts';
import { campaignUsage, planCampaign } from '../src/campaign-plan.ts';
import { campaignResults } from '../src/campaign-evidence.ts';
import { terminalWorkerEnv } from '@theoria/pi-telegram/credentials';
import { showLimit } from '@theoria/shared/limits';

export default function autoresearch(pi: ExtensionAPI) {
  if (actionSurface() !== 'terminal') return;
  const agent = new AgentTurn(pi);
  let active: Campaign | undefined;
  let running: Promise<unknown> | undefined;

  pi.registerTool(defineTool({
    name: 'autoresearch', label: 'Autoresearch', executionMode: 'sequential',
    description: 'Direct an authorized autoresearch campaign: stage skills, submit benchmark experiments, inspect summary evidence or paginated raw trajectories and candidate proofs, search arXiv, or finish. Raw reads are restricted to authorized development trials. End your turn after submitting a batch; completion results return automatically.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('stage_skill'), Type.Literal('submit_batch'), Type.Literal('status'), Type.Literal('results'),
        Type.Literal('read_evidence'), Type.Literal('read_trajectory'), Type.Literal('read_candidate'),
        Type.Literal('literature_search'), Type.Literal('literature_fetch'), Type.Literal('finish')]),
      parent: Type.Optional(Type.String()), text: Type.Optional(Type.String()), rationale: Type.Optional(Type.String()), evidence: Type.Optional(Type.Array(Type.String())),
      request_id: Type.Optional(Type.String()), hypothesis: Type.Optional(Type.String()),
      experiments: Type.Optional(Type.Array(Type.Object({ skill: Type.String(), model: Type.String(), split: Type.Optional(Type.String()),
        tasks: Type.Optional(Type.Array(Type.String())), repeat: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
        rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })), workers: Type.Optional(Type.Integer({ minimum: 1 })) }))),
      path: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })), query: Type.Optional(Type.String()), url: Type.Optional(Type.String()),
      job_id: Type.Optional(Type.String()), task_id: Type.Optional(Type.String()),
      replicate: Type.Optional(Type.Integer({ minimum: 1, description: 'Trial repetition, default 1.' })),
      round: Type.Optional(Type.Integer({ minimum: 0, description: 'Candidate round. Zero with attempt=0 reads the original baseline.' })),
      attempt: Type.Optional(Type.Integer({ minimum: 0, description: 'Worker attempt for read_trajectory (default 1); candidate attempt for read_candidate (baseline default 0).' })),
      cursor: Type.Optional(Type.Integer({ minimum: 0, description: 'Raw UTF-8 byte cursor; start at 0, then use nextCursor. Page size is the campaign artifactPageBytes limit, reported as pageBytes.' })),
      skill: Type.Optional(Type.String()), summary: Type.Optional(Type.String()),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      try {
        if (!active || resolve(ctx.cwd) !== resolve(active.cwd)) throw new Error('Start /autoresearch in this project first.');
        let details: unknown;
        switch (params.action) {
          case 'stage_skill': details = active.stageSkill(params.parent ?? '', params.text ?? '', params.rationale ?? '', params.evidence); break;
          case 'submit_batch': details = active.submit(params.request_id ?? '', params.experiments ?? [], params.hypothesis ?? ''); break;
          case 'status': case 'results': details = active.results(); break;
          case 'read_evidence': details = active.readEvidence(params.path ?? '', params.offset); break;
          case 'read_trajectory': details = active.readTrajectory(params.job_id ?? '', params.task_id ?? '', params.attempt, params.cursor, params.replicate); break;
          case 'read_candidate': details = active.readCandidate(params.job_id ?? '', params.task_id ?? '', params.round, params.attempt, params.cursor, params.replicate); break;
          case 'literature_search': details = await active.literature(params.query ?? '', true); break;
          case 'literature_fetch': details = await active.literature(params.url ?? '', false); break;
          case 'finish': details = active.finish(params.skill ?? '', params.summary ?? ''); break;
        }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }], details: { ok: false } }; }
    },
  }));

  const latest = (cwd: string) => (active && resolve(active.cwd) === resolve(cwd) ? active.id : undefined) ?? (existsSync(campaignRoot(cwd))
    ? readdirSync(campaignRoot(cwd)).filter(id => /^campaign-\d+$/.test(id)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) : undefined);
  const status = (cwd: string, id = latest(cwd)) => {
    if (!id) return 'No autoresearch campaigns in this project.';
    const state = readCampaign(cwd, id); const manifest = campaignManifest(cwd, state); const budget = campaignBudget(state);
    return `${id}: ${state.phase}${state.reason ? ` — ${state.reason}` : ''}\nObjective: ${manifest.objective}\nSpent $${budget.spent.toFixed(3)} / ${showLimit(manifest.budget, n => `$${n}`)}; reserved $${budget.reserved.toFixed(3)}\n${state.turns.length}/${showLimit(manifest.maxDecisions)} decisions; ${state.jobs.length}/${showLimit(manifest.maxExperiments)} experiments; ${manifest.workers} shared worker slots\n${JSON.stringify(campaignResults(cwd, state), null, 2)}`;
  };
  async function execute(args: string, ctx: ExtensionCommandContext): Promise<ActionResult> {
    const op = args.trim().split(/\s/, 1)[0] || 'status'; const tail = args.trim().slice(op.length).trim();
    try {
      if (op === 'status') return { ok: true, text: status(ctx.cwd, tail || undefined) };
      if (op === 'pause' || op === 'cancel') {
        const id = tail || latest(ctx.cwd); if (!id) throw new Error('No campaign selected.');
        const phase = op === 'pause' ? 'paused' : 'cancelled';
        if (active?.id === id && resolve(active.cwd) === resolve(ctx.cwd)) active.stop(phase, `User requested ${op}.`);
        else {
          const state = readCampaign(ctx.cwd, id);
          if (campaignAlive(state.owner)) throw new Error(`Campaign belongs to process ${state.owner}; stop it in its owning session.`);
          if (state.phase === 'completed') throw new Error('Campaign is already completed.');
          updateCampaign(ctx.cwd, id, `campaign.${phase}`, state => {
            state.phase = phase; state.reason = `User requested ${op}.`;
            if (phase === 'cancelled') for (const job of state.jobs) if (job.status !== 'completed') job.status = 'cancelled';
          });
        }
        return { ok: true, text: `${id}: ${op} requested.${op === 'pause' ? ' In-flight experiments drain before the next research turn.' : ''}` };
      }
      if (!['start', 'resume'].includes(op)) throw new Error(campaignUsage);
      if (running || !ctx.isIdle()) throw new Error('Wait for the current agent/workflow to finish first.');
      if (!ctx.hasUI || !ctx.model) throw new Error('Starting or resuming autoresearch needs a model and an interactive/RPC confirmation.');
      let id = ''; let manifest;
      if (op === 'start') manifest = planCampaign(ctx.cwd, tail, `${ctx.model.provider}/${ctx.model.id}`, pi.getThinkingLevel());
      else { id = tail; manifest = campaignManifest(ctx.cwd, readCampaign(ctx.cwd, id)); }
      for (const name of [manifest.parentModel, ...manifest.models]) {
        const slash = name.indexOf('/'); if (!ctx.modelRegistry.find(name.slice(0, slash), name.slice(slash + 1))) throw new Error(`Model is not available: ${name}`);
      }
      if (`${ctx.model.provider}/${ctx.model.id}` !== manifest.parentModel) throw new Error(`Select the campaign parent model ${manifest.parentModel} before resuming.`);
      if (pi.getThinkingLevel() !== manifest.parentThinking) throw new Error(`Restore parent thinking level ${manifest.parentThinking} before resuming.`);
      if (!await ctx.ui.confirm(op === 'start' ? 'Start unattended autoresearch?' : 'Resume unattended autoresearch?',
        `${manifest.objective}\nModels: ${manifest.models.join(', ')}\n${manifest.budget === undefined ? 'No spending limit.' : `Total budget $${manifest.budget}, including parent calls.`} ${manifest.minutes === undefined ? 'No campaign time limit.' : `${manifest.minutes} active minutes.`}\nPer trial: ${showLimit(manifest.config.maxCostUsd, n => `$${n}`)}, ${showLimit(manifest.config.timeoutMinutes)} minutes, ${showLimit(manifest.config.maxTurns)} responses.\n${manifest.config.skipVerification ? 'Original verification skipped; reuse matching baseline measurements. Candidate verification remains enabled.\n' : ''}${manifest.workers} shared workers; ${showLimit(manifest.maxExperiments)} experiments; ${showLimit(manifest.maxDecisions)} decisions. Parent turns: $${manifest.parentTurnCostUsd} / ${manifest.parentTurnMaxResponses} responses.\nKeep this terminal open. Esc, /autoresearch pause, or cancel stops the campaign.\n${op === 'resume' ? status(ctx.cwd, id!) : ''}`)) return { ok: false, text: 'Autoresearch not started.' };
      if (op === 'start') id = createCampaign(ctx.cwd, manifest).id;
      const previousTools = pi.getActiveTools();
      const campaign = new Campaign(ctx.cwd, id!, {
        research: (prompt, budget, signal, onSpend) => {
          if (`${ctx.model?.provider}/${ctx.model?.id}` !== manifest.parentModel) throw new Error('Parent model changed; restore the campaign model before resuming.');
          if (pi.getThinkingLevel() !== manifest.parentThinking) throw new Error('Parent thinking level changed; restore it before resuming.');
          return agent.turn(ctx, prompt, { signal, maxCostUsd: budget, maxResponses: manifest.parentTurnMaxResponses, onSpend });
        },
        notify: text => ctx.ui.setStatus('theoria-autoresearch', `${id}: ${text.slice(0, 120)}`),
      }, terminalWorkerEnv);
      active = campaign;
      pi.setActiveTools(['autoresearch']);
      const unhook = ctx.mode === 'tui' ? ctx.ui.onTerminalInput(data => {
        if (data === '\u001b') { campaign.stop('paused', 'Interrupted by user.', true); return { consume: true }; }
        return undefined;
      }) : undefined;
      try {
        running = campaign.run(); await running;
        const result = campaign.state;
        pi.sendMessage({ customType: 'theoria-autoresearch', content: status(ctx.cwd, id!), display: true,
          details: { campaignId: id, phase: result.phase, selectedSkill: result.selectedSkill } });
        return { ok: result.phase === 'completed', resumeAgent: false, text: status(ctx.cwd, id!) };
      } finally {
        unhook?.(); pi.setActiveTools(previousTools); ctx.ui.setStatus('theoria-autoresearch', undefined);
        active = undefined; running = undefined;
      }
    } catch (error) { return { ok: false, resumeAgent: false, text: String(error) }; }
  }
  pi.registerCommand('autoresearch', {
    description: 'Unattended research: start, status, pause, resume, cancel. Optional limits; the base agent stages skills and directs benchmark experiments.',
    handler: async (args, ctx) => { const result = await execute(args, ctx); ctx.ui.notify(result.text, result.ok ? 'info' : 'warning'); },
  });
  provideActions(pi, () => [
    { name: 'autoresearch-start', usage: campaignUsage, summary: 'Start a parent-agent research campaign; confirms scope and optional limits once.', execution: 'deferred',
      run: async (args, actx) => actx.command ? execute(`start ${args}`, actx.command) : { ok: false, text: 'Use the deferred autoresearch action.' } },
    { name: 'autoresearch-status', usage: '/autoresearch status [campaign-id]', summary: 'Read campaign state and measured results.', execution: 'inline',
      run: async (args, ctx) => { try { return { ok: true, text: status(ctx.cwd, args.trim() || undefined) }; } catch (error) { return { ok: false, text: String(error) }; } } },
  ]);
  pi.on('session_shutdown', async () => { active?.stop('paused', 'Session closed; resume explicitly.', true); await running; });
}
