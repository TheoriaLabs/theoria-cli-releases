import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { config } from '@theoria/shared/config';
import { appendRunEvent, runDir } from '@theoria/shared/events';
import { projectPath, projectRoot } from '@theoria/shared/paths';
import { declarations, readInventory, refreshInventory, type Inventory, type TheoremState } from '@theoria/pi-workflows/api';
import { projectType } from '@theoria/shared/project';
import { getClaim, statusLabel } from './claims.ts';
import { now, readJson, withLock, writeJson } from './store.ts';

/**
 * Plans: how a research run (or a benchmark trial) means to reach its objective. A small graph: attack angles
 * (alternative routes, one active) and nodes (definitions, lemmas, theorems, milestones) that depend on each other.
 *
 * A node's status is never the agent's word. A node linked to a Lean declaration takes it from Lean's theorem
 * inventory; a node linked to a claim, from the claim's verification; only an unlinked milestone may be marked done,
 * and that is shown as the agent's judgement. A plan is working state of one run; what it establishes lives on as
 * claims and Lean declarations.
 *
 * Two categories: a `lean` plan (Lean-checked) is a proof skeleton, valid only when Lean proves its target from the
 * lemmas it states; a `vision` plan is a strategic research graph (AI/ML, quantitative finance, any project without
 * Lean), valid with its attack angles and milestones in place, and its nodes settled by claims (formal or
 * statistical) or marked done as the agent's judgement. A plan's default category follows the project type.
 */

export const planCategories = ['lean', 'vision'] as const;
export type PlanCategory = (typeof planCategories)[number];
export const categoryLabel: Record<PlanCategory, string> = { lean: 'Lean-checked proof plan', vision: 'vision: a strategic research graph, not checked by Lean' };

export const nodeKinds = ['definition', 'lemma', 'theorem', 'milestone'] as const;
export type NodeKind = (typeof nodeKinds)[number];

export interface LeanRef { file: string; name: string }

export interface Angle {
  id: string;
  title: string;
  rationale: string;
  risk: string;
  status: 'active' | 'candidate' | 'abandoned';
  reason?: string;
}

export interface PlanNode {
  id: string;
  angle: string;
  kind: NodeKind;
  title: string;
  statement?: string;
  dependsOn: string[];
  lean?: LeanRef;
  claim?: string;
  /** For a milestone without evidence: the agent marked it done. */
  done?: { note: string; at: string };
}

export interface Plan {
  category: PlanCategory;
  objective: { text: string; lean?: LeanRef };
  angles: Angle[];
  nodes: PlanNode[];
  version: number;
  runId?: string;
  createdAt: string;
  updatedAt: string;
}

const settings = () => config().plan;

/** Lean-checked where the project type uses Lean, a vision plan elsewhere. */
export function defaultCategory(cwd: string): PlanCategory {
  try { return projectType(cwd).settings.lean ? 'lean' : 'vision'; } catch { return 'vision'; }
}

/** Where a plan lives: in its research run's folder, or the project's `.theoria` outside a run. */
export const planPath = (cwd: string, runId?: string) => (runId ? join(runDir(cwd, runId), settings().file) : projectPath(cwd, settings().file));

export const readPlan = (cwd: string, runId?: string) => readJson<Plan>(planPath(cwd, runId));

/** `Solution.lean:Name` → a reference, relative to the project. */
export function parseLeanRef(cwd: string, text: string): LeanRef {
  const at = text.lastIndexOf(':');
  if (at <= 0 || at === text.length - 1) throw new Error(`A Lean reference is <file.lean>:<name>, not "${text}".`);
  const file = text.slice(0, at);
  if (!file.endsWith('.lean')) throw new Error(`${file} is not a Lean file.`);
  const root = projectRoot(cwd);
  const inside = resolve(cwd, file).slice(root.length + 1);
  if (!resolve(cwd, file).startsWith(`${root}/`)) throw new Error(`${file} is not inside the project.`);
  return { file: inside, name: text.slice(at + 1) };
}

export const leanText = (ref: LeanRef) => `${ref.file}:${ref.name}`;

function save(cwd: string, runId: string | undefined, plan: Plan, event: string) {
  writeJson(planPath(cwd, runId), plan);
  if (runId) appendRunEvent(cwd, runId, event, { version: plan.version, angles: plan.angles.length, nodes: plan.nodes.length });
}

/** Changes the plan under the project's lock; a new version each time. */
export function updatePlan(cwd: string, runId: string | undefined, change: (plan: Plan) => void, event = 'plan.updated'): Plan {
  return withLock(cwd, () => {
    const current = readPlan(cwd, runId);
    if (!current) throw new Error('There is no plan yet: create one first.');
    const next = structuredClone(current);
    change(next);
    validate(next);
    next.version = current.version + 1;
    next.updatedAt = now();
    save(cwd, runId, next, event);
    return next;
  });
}

export interface AngleInput { title: string; rationale?: string; risk?: string }
export interface NodeInput { id?: string; angle?: string; kind: string; title: string; statement?: string; dependsOn?: string[]; lean?: string; claim?: string }

/** A new plan (or a new version replacing the current one): the objective and its attack angles, the first active. */
export function createPlan(cwd: string, runId: string | undefined, input: { objective: string; target?: string; angles: AngleInput[]; category?: string }): Plan {
  if (!input.objective.trim()) throw new Error('A plan needs an objective.');
  const category = (input.category ?? defaultCategory(cwd)) as PlanCategory;
  if (!(planCategories as readonly string[]).includes(category)) throw new Error(`A plan's category is ${planCategories.join(' or ')}, not ${input.category}.`);
  if (category === 'vision' && input.target) throw new Error('A vision plan has no Lean target; use category lean for a proof plan.');
  if (!input.angles.length) throw new Error('A plan needs at least one attack angle.');
  return withLock(cwd, () => {
    const previous = readPlan(cwd, runId);
    const at = now();
    const plan: Plan = {
      category,
      objective: { text: input.objective.trim(), ...(input.target ? { lean: parseLeanRef(cwd, input.target) } : {}) },
      angles: input.angles.map((angle, index) => ({
        id: `a${index + 1}`, title: angle.title.trim(), rationale: angle.rationale?.trim() ?? '', risk: angle.risk?.trim() ?? '',
        status: index === 0 ? 'active' as const : 'candidate' as const,
      })),
      nodes: [], version: (previous?.version ?? 0) + 1, ...(runId ? { runId } : {}), createdAt: previous?.createdAt ?? at, updatedAt: at,
    };
    save(cwd, runId, plan, previous ? 'plan.replaced' : 'plan.created');
    return plan;
  });
}

/** Adds nodes (to the active angle unless one is named); ids are kept when given, else n1, n2, … */
export function addNodes(cwd: string, runId: string | undefined, inputs: NodeInput[]): Plan {
  return updatePlan(cwd, runId, plan => {
    const active = plan.angles.find(angle => angle.status === 'active')?.id ?? plan.angles[0]!.id;
    for (const input of inputs) {
      if (!(nodeKinds as readonly string[]).includes(input.kind)) throw new Error(`A node's kind is one of ${nodeKinds.join(', ')}, not ${input.kind}.`);
      const id = input.id?.trim() || nextNodeId(plan);
      if (plan.nodes.some(node => node.id === id)) throw new Error(`There is already a node ${id}.`);
      plan.nodes.push({
        id, angle: input.angle ?? active, kind: input.kind as NodeKind, title: input.title.trim(),
        ...(input.statement ? { statement: input.statement.trim() } : {}), dependsOn: input.dependsOn ?? [],
        ...(input.lean ? { lean: parseLeanRef(cwd, input.lean) } : {}), ...(input.claim ? { claim: input.claim.toUpperCase() } : {}),
      });
    }
  });
}

function nextNodeId(plan: Plan): string {
  const numbers = plan.nodes.map(node => /^n(\d+)$/.exec(node.id)?.[1]).filter(Boolean).map(Number);
  return `n${(numbers.length ? Math.max(...numbers) : 0) + 1}`;
}

function validate(plan: Plan) {
  const ids = new Set(plan.nodes.map(node => node.id));
  for (const node of plan.nodes) {
    if (!plan.angles.some(angle => angle.id === node.angle)) throw new Error(`Node ${node.id} names angle ${node.angle}, which the plan does not have.`);
    for (const dependency of node.dependsOn) if (!ids.has(dependency)) throw new Error(`Node ${node.id} depends on ${dependency}, which the plan does not have.`);
  }
  if (plan.angles.filter(angle => angle.status === 'active').length > 1) throw new Error('Only one angle can be active.');
}

/** A new attack angle, found while working: a candidate until switched to. */
export function addAngle(cwd: string, runId: string | undefined, input: AngleInput): Plan {
  if (!input.title?.trim()) throw new Error('An angle needs a title.');
  return updatePlan(cwd, runId, plan => {
    const numbers = plan.angles.map(angle => Number(/^a(\d+)$/.exec(angle.id)?.[1] ?? 0));
    plan.angles.push({ id: `a${Math.max(0, ...numbers) + 1}`, title: input.title.trim(), rationale: input.rationale?.trim() ?? '', risk: input.risk?.trim() ?? '', status: 'candidate' });
  }, 'plan.angle_added');
}

/** Changes a node as the plan is refined: its title, statement, dependencies, kind or angle. */
export function editNode(cwd: string, runId: string | undefined, nodeId: string, change: Partial<Pick<NodeInput, 'title' | 'statement' | 'dependsOn' | 'kind' | 'angle'>>): Plan {
  return updatePlan(cwd, runId, plan => {
    const node = plan.nodes.find(entry => entry.id === nodeId);
    if (!node) throw new Error(`No node ${nodeId}.`);
    if (change.kind !== undefined) {
      if (!(nodeKinds as readonly string[]).includes(change.kind)) throw new Error(`A node's kind is one of ${nodeKinds.join(', ')}.`);
      node.kind = change.kind as NodeKind;
    }
    if (change.title?.trim()) node.title = change.title.trim();
    if (change.statement !== undefined) node.statement = change.statement.trim();
    if (change.dependsOn) node.dependsOn = change.dependsOn;
    if (change.angle) node.angle = change.angle;
  });
}

/** Removes a node that the plan no longer needs; nodes depending on it lose that dependency. */
export function removeNode(cwd: string, runId: string | undefined, nodeId: string): Plan {
  return updatePlan(cwd, runId, plan => {
    if (!plan.nodes.some(node => node.id === nodeId)) throw new Error(`No node ${nodeId}.`);
    plan.nodes = plan.nodes.filter(node => node.id !== nodeId).map(node => ({ ...node, dependsOn: node.dependsOn.filter(id => id !== nodeId) }));
  }, 'plan.node_removed');
}

export function linkNode(cwd: string, runId: string | undefined, nodeId: string, evidence: { lean?: string; claim?: string }): Plan {
  return updatePlan(cwd, runId, plan => {
    const node = plan.nodes.find(entry => entry.id === nodeId);
    if (!node) throw new Error(`No node ${nodeId}.`);
    if (evidence.lean) node.lean = parseLeanRef(cwd, evidence.lean);
    if (evidence.claim) node.claim = evidence.claim.toUpperCase();
  });
}

/** Makes `angleId` the active angle; the one it replaces stays a candidate. */
export function switchAngle(cwd: string, runId: string | undefined, angleId: string, reason: string): Plan {
  return updatePlan(cwd, runId, plan => {
    const angle = plan.angles.find(entry => entry.id === angleId);
    if (!angle) throw new Error(`No angle ${angleId}.`);
    if (angle.status === 'abandoned') throw new Error(`Angle ${angleId} was abandoned: ${angle.reason ?? ''}`);
    for (const entry of plan.angles) if (entry.status === 'active') entry.status = 'candidate';
    angle.status = 'active';
    angle.reason = reason;
  }, 'plan.angle_switched');
}

export function abandonAngle(cwd: string, runId: string | undefined, angleId: string, reason: string): Plan {
  if (!reason.trim()) throw new Error('Say why the angle is abandoned.');
  return updatePlan(cwd, runId, plan => {
    const angle = plan.angles.find(entry => entry.id === angleId);
    if (!angle) throw new Error(`No angle ${angleId}.`);
    angle.status = 'abandoned';
    angle.reason = reason.trim();
  }, 'plan.angle_abandoned');
}

/** Marks a milestone done: only an unlinked milestone, and only as the agent's judgement. */
export function markDone(cwd: string, runId: string | undefined, nodeId: string, note: string): Plan {
  return updatePlan(cwd, runId, plan => {
    const node = plan.nodes.find(entry => entry.id === nodeId);
    if (!node) throw new Error(`No node ${nodeId}.`);
    if (node.kind !== 'milestone' || node.lean || node.claim) throw new Error(`${nodeId} is settled by its evidence (Lean or a claim), not by being marked done.`);
    node.done = { note: note.trim(), at: now() };
  });
}

// ── Status ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type NodeStatus = 'proved' | 'defined' | 'verified' | 'done' | 'open' | 'broken' | 'missing';

export interface NodeView { node: PlanNode; status: NodeStatus; detail: string }

const findTheorem = (inventory: Inventory, ref: LeanRef) =>
  inventory.theorems.find(entry => entry.file === ref.file && (entry.name === ref.name || entry.name.endsWith(`.${ref.name}`)));

function declared(cwd: string, ref: LeanRef): boolean {
  try {
    const source = readFileSync(join(projectRoot(cwd), ref.file), 'utf8');
    return declarations(source).some(entry => entry.name === ref.name || entry.name.endsWith(`.${ref.name}`) || ref.name.endsWith(`.${entry.name}`));
  } catch { return false; }
}

function leanStatus(cwd: string, inventory: Inventory, ref: LeanRef, kind: NodeKind): { status: NodeStatus; detail: string } {
  if (kind === 'definition') return declared(cwd, ref) ? { status: 'defined', detail: `${leanText(ref)} is declared` } : { status: 'missing', detail: `${leanText(ref)} is not in the file` };
  const theorem: TheoremState | undefined = findTheorem(inventory, ref);
  if (!theorem) return declared(cwd, ref) ? { status: 'broken', detail: `Lean did not accept ${leanText(ref)}` } : { status: 'missing', detail: `${leanText(ref)} is not in the file` };
  if (theorem.statementError || theorem.proof === 'error') return { status: 'broken', detail: `${theorem.name}: ${theorem.reason ?? 'error'}` };
  if (theorem.proof === 'proved') return { status: 'proved', detail: `${theorem.name} is proved (Lean)` };
  return { status: 'open', detail: `${theorem.name}: ${theorem.reason ?? 'open'}` };
}

export function nodeViews(cwd: string, plan: Plan, inventory: Inventory): NodeView[] {
  return plan.nodes.map(node => {
    if (node.lean) return { node, ...leanStatus(cwd, inventory, node.lean, node.kind) };
    if (node.claim) {
      const claim = getClaim(cwd, node.claim);
      if (!claim) return { node, status: 'missing' as const, detail: `no claim ${node.claim}` };
      return { node, status: claim.status === 'verified' ? 'verified' as const : 'open' as const, detail: `${claim.id} ${statusLabel(claim)}` };
    }
    if (node.done) return { node, status: 'done' as const, detail: `marked done (the agent's judgement): ${node.done.note}` };
    return { node, status: 'open' as const, detail: node.kind === 'milestone' ? 'not done' : 'not linked to Lean yet' };
  });
}

const settledStatuses: NodeStatus[] = ['proved', 'defined', 'verified', 'done'];

export interface PlanCheck {
  exists: boolean;
  /** For a math plan: a proof skeleton Lean accepts; otherwise: angles and nodes in place. */
  valid: boolean;
  problems: string[];
  views: NodeView[];
  proved: number;
  total: number;
  /** Open nodes of the active angle whose dependencies are settled: what to work on next. */
  next: NodeView[];
  objective?: { status: NodeStatus | 'unknown'; detail: string };
  allAbandoned: boolean;
}

/**
 * The plan against the evidence. With `refresh`, Lean checks the project's files first (the theorem inventory, from
 * its cache for files that did not change); otherwise the cached inventory is used. `target` overrides the plan's
 * objective theorem (a benchmark knows its own).
 */
export async function checkPlan(cwd: string, runId: string | undefined, options: { refresh?: boolean; target?: LeanRef } = {}): Promise<PlanCheck> {
  const plan = readPlan(cwd, runId);
  if (!plan) return { exists: false, valid: false, problems: ['there is no plan: create one with the plan tool'], views: [], proved: 0, total: 0, next: [], allAbandoned: false };
  const inventory = options.refresh ? await refreshInventory(cwd) : readInventory(cwd);
  const views = nodeViews(cwd, plan, inventory);
  const problems: string[] = [];
  const live = plan.angles.filter(angle => angle.status !== 'abandoned');
  if (plan.angles.length < settings().minAngles) problems.push(`the plan has ${plan.angles.length} attack angle(s); give at least ${settings().minAngles}, each with its rationale and risk`);
  const active = plan.angles.find(angle => angle.status === 'active');
  if (!active && live.length) problems.push('no angle is active: switch to one');
  const target = plan.category === 'lean' ? options.target ?? plan.objective.lean : undefined;
  let objective: PlanCheck['objective'];
  if (plan.category === 'lean' && !target) problems.push('a Lean-checked plan needs its target theorem (create with target file.lean:name)');
  if (plan.category === 'vision') {
    // A strategic graph: its shape is checked, not its evidence. Milestones become settled through claims.
    const active = plan.angles.find(angle => angle.status === 'active');
    if (!views.some(view => view.node.angle === active?.id)) problems.push('the active angle has no milestones yet');
    for (const view of views.filter(entry => entry.status === 'missing' || entry.status === 'broken')) problems.push(`node ${view.node.id}: ${view.detail}`);
  }
  if (target) {
    const leanNodes = views.filter(view => view.node.lean && view.node.angle === active?.id && view.node.kind !== 'milestone');
    const stated = leanNodes.filter(view => view.status !== 'missing' && !(view.node.lean!.name === target.name || target.name.endsWith(`.${view.node.lean!.name}`)));
    if (!stated.length) problems.push('the active angle has no definition or lemma stated in the Lean file and linked to the plan');
    for (const view of views.filter(entry => entry.status === 'missing' || entry.status === 'broken')) problems.push(`node ${view.node.id}: ${view.detail}`);
    const theorem = findTheorem(inventory, target);
    if (!theorem) {
      objective = { status: 'unknown', detail: `Lean has not checked ${leanText(target)} yet` };
      problems.push(`${leanText(target)} was not found by Lean`);
    } else if (theorem.statementError || theorem.proof === 'error') {
      objective = { status: 'broken', detail: theorem.reason ?? 'error' };
      problems.push(`${theorem.name}: ${theorem.reason ?? 'error'}; fix the file so that it compiles`);
    } else if (theorem.proof === 'proved') objective = { status: 'proved', detail: `${theorem.name} is proved (Lean)` };
    else if (theorem.reason === 'depends on sorry') objective = { status: 'open', detail: `${theorem.name} is proved from lemmas that still use sorry` };
    else {
      objective = { status: 'open', detail: `${theorem.name} still uses sorry itself` };
      problems.push(`${theorem.name} still uses sorry itself: prove it from the plan's lemmas, so that only they are left open`);
    }
  }
  const settled = (id: string) => settledStatuses.includes(views.find(view => view.node.id === id)?.status ?? 'open');
  const next = views.filter(view => view.node.angle === active?.id && !settledStatuses.includes(view.status) && view.node.dependsOn.every(settled));
  const formal = views.filter(view => view.node.kind !== 'milestone');
  return {
    exists: true, valid: problems.length === 0, problems, views,
    proved: views.filter(view => settledStatuses.includes(view.status) && view.node.kind !== 'definition').length,
    total: (formal.length ? formal : views).filter(view => view.node.kind !== 'definition').length,
    next, ...(objective ? { objective } : {}), allAbandoned: plan.angles.length > 0 && live.length === 0,
  };
}

const mark: Record<NodeStatus, string> = { proved: '✔', defined: '◆', verified: '✔', done: '☑', open: '○', broken: '✖', missing: '?' };

/** The plan in a few lines: objective, angles, nodes of the active angle with their status, what is next. */
export function planLines(plan: Plan, check: Pick<PlanCheck, 'views' | 'next' | 'proved' | 'total' | 'objective'>, max = settings().maxNodesShown): string[] {
  const active = plan.angles.find(angle => angle.status === 'active');
  const shown = check.views.filter(view => view.node.angle === active?.id).slice(0, max);
  return [
    `${categoryLabel[plan.category ?? 'lean']} · objective: ${plan.objective.text}${plan.objective.lean ? ` (${leanText(plan.objective.lean)})` : ''}${check.objective ? ` · ${check.objective.detail}` : ''}`,
    ...plan.angles.map(angle => `${angle.status === 'active' ? '▶' : angle.status === 'abandoned' ? '✗' : '·'} ${angle.id} ${angle.title}${angle.status === 'abandoned' ? ` (abandoned: ${angle.reason ?? ''})` : ''}${angle.risk && angle.status !== 'abandoned' ? ` · risk: ${angle.risk}` : ''}`),
    `Nodes of ${active?.id ?? 'no active angle'}: ${check.proved} of ${check.total} proved`,
    ...shown.map(view => `  ${mark[view.status]} ${view.node.id} ${view.node.kind} ${view.node.title}${view.node.lean ? ` [${leanText(view.node.lean)}]` : view.node.claim ? ` [${view.node.claim}]` : ''}${view.node.dependsOn.length ? ` ← ${view.node.dependsOn.join(', ')}` : ''}`),
    ...(check.views.filter(view => view.node.angle === active?.id).length > shown.length ? [`  … ${check.views.filter(view => view.node.angle === active?.id).length - shown.length} more`] : []),
    `Next: ${check.next.slice(0, 3).map(view => `${view.node.id} (${view.node.title})`).join(', ') || 'nothing open'}`,
  ];
}

