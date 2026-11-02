import { Type } from '@earendil-works/pi-ai';
import { defineTool, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { config } from '@theoria/shared/config';
import { componentOn } from '@theoria/shared/harness';
import { currentRunId } from '@theoria/shared/verdicts';
import { readInventory } from '@theoria/pi-workflows/api';
import {
  abandonAngle, addAngle, addNodes, checkPlan, createPlan, editNode, removeNode, linkNode, markDone, nodeKinds, nodeViews, planLines, readPlan, switchAngle, type Plan,
} from '../src/plans.ts';

/**
 * Plans in a session: the `plan` tool for the agent, `/plan` for you, and the plan's open nodes in the agent's system
 * prompt each turn (its `<plan>` section, from Lean's cached results; `check` asks Lean again). A session in a
 * research run uses the run's plan; elsewhere (a benchmark trial) the project's. Independent of any goal mechanism.
 */
export default function plan(pi: ExtensionAPI) {
  if (!componentOn('plan')) return;

  async function summary(cwd: string, refresh: boolean): Promise<{ text: string; plan?: Plan; valid?: boolean }> {
    const current = readPlan(cwd, currentRunId(cwd));
    if (!current) return { text: 'There is no plan yet. create makes one: the objective and two or three attack angles.' };
    const check = await checkPlan(cwd, currentRunId(cwd), { refresh });
    return {
      text: [
        ...planLines(current, check),
        check.valid ? 'Skeleton: valid (Lean).' : `Skeleton: not yet valid: ${check.problems.join('; ')}.`,
      ].join('\n'),
      plan: current, valid: check.valid,
    };
  }

  pi.registerTool(defineTool({
    name: 'plan',
    label: 'Plan',
    description: [
      'Your plan for the objective: attack angles (alternative routes, one active) and nodes (definitions, lemmas, theorems, milestones) with dependencies.',
      'Category lean (Lean-checked: a proof skeleton with a target theorem, its lemmas stated in the Lean file) or vision (a strategic research graph, not checked by Lean); the default follows the project type.',
      'A node linked to a Lean declaration (Solution.lean:name) is proved only when Lean proves it; a node linked to a claim, when the claim is verified (formally or statistically). Marking a node done applies only to unlinked milestones, as your judgement.',
      'op: create (category, objective, target, angles) · add (nodes) · edit (node, nodes[0] with the fields to change) · remove (node) · angle (angles[0]: a new candidate angle) · link (node, lean|claim) · switch (angle, reason) · abandon (angle, reason) · done (node, note) · show · check (asks Lean).',
      'Revise the plan as you learn: add, edit or remove nodes, add angles, switch or abandon them. Every change is a new version.',
    ].join(' '),
    promptSnippet: 'plan: a proof or research plan (attack angles, milestones, lemmas), checked against Lean',
    promptGuidelines: [config().plan.guideline],
    parameters: Type.Object({
      op: Type.Union(['create', 'add', 'edit', 'remove', 'angle', 'link', 'switch', 'abandon', 'done', 'show', 'check'].map(value => Type.Literal(value))),
      objective: Type.Optional(Type.String({ description: 'create: what the plan must establish.' })),
      category: Type.Optional(Type.String({ description: 'create: lean (Lean-checked proof plan) or vision (strategic research graph).' })),
      target: Type.Optional(Type.String({ description: 'create: the objective theorem, as file.lean:name.' })),
      angles: Type.Optional(Type.Array(Type.Object({ title: Type.String(), rationale: Type.Optional(Type.String()), risk: Type.Optional(Type.String()) }), { description: 'create: two or three alternative routes; the first is active.' })),
      nodes: Type.Optional(Type.Array(Type.Object({
        id: Type.Optional(Type.String()), angle: Type.Optional(Type.String()),
        kind: Type.String({ description: nodeKinds.join(' | ') }), title: Type.String(), statement: Type.Optional(Type.String()),
        dependsOn: Type.Optional(Type.Array(Type.String())), lean: Type.Optional(Type.String({ description: 'file.lean:declaration' })), claim: Type.Optional(Type.String()),
      }), { description: 'add: the nodes, on the active angle unless one is named.' })),
      node: Type.Optional(Type.String()), angle: Type.Optional(Type.String()), reason: Type.Optional(Type.String()),
      lean: Type.Optional(Type.String()), claim: Type.Optional(Type.String()), note: Type.Optional(Type.String()),
    }),
    executionMode: 'sequential',
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const cwd = ctx.cwd;
      const runId = currentRunId(cwd);
      try {
        switch (params.op) {
          case 'create':
            createPlan(cwd, runId, { objective: params.objective ?? '', ...(params.target ? { target: params.target } : {}), ...(params.category ? { category: params.category } : {}), angles: params.angles ?? [] });
            break;
          case 'add': addNodes(cwd, runId, params.nodes ?? []); break;
          case 'edit': editNode(cwd, runId, params.node ?? '', params.nodes?.[0] ?? {}); break;
          case 'remove': removeNode(cwd, runId, params.node ?? ''); break;
          case 'angle': addAngle(cwd, runId, params.angles?.[0] ?? { title: '' }); break;
          case 'link': linkNode(cwd, runId, params.node ?? '', { ...(params.lean ? { lean: params.lean } : {}), ...(params.claim ? { claim: params.claim } : {}) }); break;
          case 'switch': switchAngle(cwd, runId, params.angle ?? '', params.reason ?? ''); break;
          case 'abandon': abandonAngle(cwd, runId, params.angle ?? '', params.reason ?? ''); break;
          case 'done': markDone(cwd, runId, params.node ?? '', params.note ?? ''); break;
          default: break;
        }
      } catch (error) {
        return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], details: { ok: false } };
      }
      const result = await summary(cwd, params.op === 'check');
      return { content: [{ type: 'text', text: result.text }], details: { ok: true, valid: result.valid ?? false, plan: result.plan ?? null } };
    },
  }));

  // The plan in front of the agent each turn, from Lean's cached results: no Lean run per turn.
  pi.on('before_agent_start', (event, ctx) => {
    const current = readPlan(ctx.cwd, currentRunId(ctx.cwd));
    const sections = event.systemPromptOptions.sections;
    if (!current) { delete sections.plan; return; }
    const views = nodeViews(ctx.cwd, current, readInventory(ctx.cwd));
    const active = current.angles.find(angle => angle.status === 'active');
    const settled = new Set(views.filter(view => ['proved', 'defined', 'verified', 'done'].includes(view.status)).map(view => view.node.id));
    const next = views.filter(view => view.node.angle === active?.id && !settled.has(view.node.id) && view.node.dependsOn.every(id => settled.has(id)));
    const formal = views.filter(view => view.node.kind !== 'definition' && view.node.angle === active?.id);
    sections.plan = planLines(current, { views, next, proved: formal.filter(view => settled.has(view.node.id)).length, total: formal.length }).join('\n');
  });

  pi.registerCommand('plan', {
    description: 'The plan of this run (or project): show · check (asks Lean)',
    getArgumentCompletions: prefix => ['show', 'check'].filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      const result = await summary(ctx.cwd, args.trim() === 'check');
      ctx.ui.notify(result.text, 'info');
    },
  });
}
