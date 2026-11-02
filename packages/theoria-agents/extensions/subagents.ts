import { resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { actionSurface } from '@theoria/shared/actions';
import { currentProfile, subagentEnv } from '@theoria/shared/harness';
import { config } from '@theoria/shared/config';
import { projectRoot } from '@theoria/shared/paths';
import { SubagentManager } from '../src/subagents.ts';

export default function subagents(pi: ExtensionAPI) {
  if (actionSurface() !== 'terminal' || process.env[subagentEnv]) return;
  const managers = new Map<string, SubagentManager>();
  let closing = false;
  const managerFor = (ctx: ExtensionContext) => {
    const session = ctx.sessionManager.getSessionId(); const root = resolve(projectRoot(ctx.cwd)); const key = `${root}:${session}`;
    let manager = managers.get(key);
    if (!manager) {
      manager = new SubagentManager(root, session, { finished: record => {
        if (closing) return;
        const resume = pi.getActiveTools().includes('subagent');
        pi.sendMessage({ customType: 'theoria-subagent', content: `${record.id}: ${record.status}. Use subagent result to inspect its answer.`,
          display: true, details: { id: record.id, status: record.status, metrics: record.metrics } },
        resume ? { deliverAs: 'followUp', triggerTurn: true } : { deliverAs: 'nextTurn' });
      } });
      managers.set(key, manager);
    }
    return manager;
  };
  pi.registerTool(defineTool({
    name: 'subagent', label: 'Subagent', executionMode: 'sequential',
    description: 'Start and manage an independent Theoria subagent for a general task. Works without an autoresearch campaign. start returns an ID immediately; use wait/result to collect its answer, status/list to monitor, or cancel. Each child has its own context, credentials and bounded runtime. read mode keeps project files read-only; explicitly select write for implementation. Children cannot spawn children. Avoid concurrent edits to the same files.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal('start'), Type.Literal('list'), Type.Literal('status'), Type.Literal('result'), Type.Literal('wait'), Type.Literal('cancel')]),
      task: Type.Optional(Type.String()), context: Type.Optional(Type.String()), cwd: Type.Optional(Type.String()), model: Type.Optional(Type.String()),
      mode: Type.Optional(Type.Union([Type.Literal('read'), Type.Literal('write')])),
      cost: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), turns: Type.Optional(Type.Integer({ minimum: 1 })),
      timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })), id: Type.Optional(Type.String()), seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
    }),
    async execute(_id, params, signal, _update, ctx) {
      try {
        const manager = managerFor(ctx); let result: unknown;
        switch (params.action) {
          case 'start': {
            if (!ctx.model) throw new Error('Select a model before spawning a subagent.');
            const model = params.model ?? `${ctx.model.provider}/${ctx.model.id}`; const slash = model.indexOf('/');
            if (slash < 1 || !ctx.modelRegistry.find(model.slice(0, slash), model.slice(slash + 1))) throw new Error(`Unavailable model ${model}.`);
            result = manager.start({ task: params.task ?? '', context: params.context, cwd: params.cwd, model, mode: params.mode,
              thinking: pi.getThinkingLevel(), harness: currentProfile().name, maxCostUsd: params.cost, maxTurns: params.turns, timeoutMinutes: params.timeout });
            break;
          }
          case 'list': result = manager.list(); break;
          case 'status': result = manager.status(params.id ?? ''); break;
          case 'result': result = manager.result(params.id ?? ''); break;
          case 'wait': result = await manager.wait(params.id ?? '', params.seconds, signal); break;
          case 'cancel': result = await manager.cancel(params.id ?? ''); break;
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }], details: { ok: false } }; }
    },
  }));
  pi.registerCommand('subagent', {
    description: 'Independent child tasks: /subagent start <task>, list, status/result/wait/cancel <id>',
    handler: async (args, ctx) => {
      const action = args.trim().split(/\s+/, 1)[0] || 'list'; const rest = args.trim().slice(action.length).trim();
      try {
        const manager = managerFor(ctx); let result: unknown;
        if (action === 'start') {
          if (!ctx.model) throw new Error('Select a model first.');
          result = manager.start({ task: rest, model: `${ctx.model.provider}/${ctx.model.id}`, thinking: pi.getThinkingLevel(), harness: currentProfile().name });
        } else if (action === 'list') result = manager.list();
        else if (action === 'status') result = manager.status(rest);
        else if (action === 'result') result = manager.result(rest);
        else if (action === 'wait') result = await manager.wait(rest, config().subagents.maxWaitSeconds);
        else if (action === 'cancel') result = await manager.cancel(rest);
        else throw new Error('Use /subagent start <task>, list, status/result/wait/cancel <id>.');
        ctx.ui.notify(JSON.stringify(result, null, 2), 'info');
      } catch (error) { ctx.ui.notify(String(error), 'error'); }
    },
  });
  const stop = async () => { closing = true; await Promise.allSettled([...managers.values()].map(manager => manager.stopAll())); managers.clear(); };
  pi.on('session_start', () => { closing = false; });
  pi.on('session_shutdown', stop);
  pi.on('session_before_switch', stop);
}
