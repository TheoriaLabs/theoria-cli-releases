import { label, type Environment } from '@theoria/pi-lean/api';
import { attemptLoop } from './attempts.ts';
import { formalize } from './formalize.ts';
import { checkProof, read, type ProofInput } from './gate.ts';
import { statementText } from './lean-source.ts';
import { guidance, pickTheorem, type Goal } from './pick.ts';
import { loadPrompt, type WorkflowPrompt } from './prompt.ts';
import type { Ctx, WorkflowRuntime } from './runtime.ts';
import type { Parsed } from './target.ts';

export const proofInput = (ctx: Ctx, goal: Goal, prompt: WorkflowPrompt, before: string): ProofInput => ({
  cwd: ctx.cwd, file: goal.file, theorem: goal.theorem, before,
  allowedAxioms: prompt.settings.allowedAxioms, timeoutSeconds: prompt.settings.timeoutSeconds,
});

/**
 * `/prove`: Lean must verify the theorem with its statement unchanged and only permitted axioms. A description is
 * formalized first, and its statement accepted by the user before any proof is attempted.
 */
export async function prove(rt: WorkflowRuntime, ctx: Ctx, parsed: Parsed, prompt: WorkflowPrompt, environment: Environment) {
  let goal: Goal | undefined;
  if (parsed.target.kind === 'text') {
    let formalizePrompt: WorkflowPrompt;
    try { formalizePrompt = loadPrompt('formalize', ctx.cwd); } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      return;
    }
    goal = await formalize(rt, ctx, parsed, formalizePrompt, environment, true);
  } else {
    goal = await pickTheorem(rt, ctx, parsed, 'prove');
  }
  if (!goal) return;
  if (goal.fromDescription && prompt.settings.confirmStatement && !await confirmStatement(rt, ctx, goal)) return;

  const before = read(goal.file) ?? '';
  const input = { ...proofInput(ctx, goal, prompt, before), signal: rt.signal };
  rt.status(ctx, `/prove ${goal.theorem} · checking whether it is already proved`);
  const already = await checkProof(environment, input);
  if (rt.signal?.aborted || already.check?.status === 'timeout' || already.check?.status === 'unavailable') {
    rt.card('/prove · interrupted', [already.summary], { ok: false, outcome: rt.signal?.aborted ? 'cancelled' : already.check!.status });
    return;
  }
  if (already.ok) {
    rt.card('/prove · already verified', [already.summary, 'Nothing was changed.'], { ok: true });
    return;
  }
  const unconfirmed = goal.fromDescription && !prompt.settings.confirmStatement;
  const file = goal.file;
  await attemptLoop(rt, ctx, prompt, environment, {
    workflow: 'prove', file, theorem: goal.theorem, before,
    vars: { request: parsed.target.kind === 'text' ? '' : guidance(parsed), statement: statementText(goal.declaration) },
    check: () => checkProof(environment, input),
    success: verdict => ['/prove · verified', [
      verdict.summary, `${rt.shown(ctx, file)} · ${label(environment)}`,
      unconfirmed && 'The statement was written by the agent from a description and not confirmed (confirm-statement: false).',
    ]],
  });
}

/** A statement found or written from a description counts for the user's claim only once they accept it. */
async function confirmStatement(rt: WorkflowRuntime, ctx: Ctx, goal: Goal): Promise<boolean> {
  const statement = statementText(goal.declaration);
  if (!ctx.hasUI) {
    rt.card('/prove · statement needs your confirmation', [
      'This statement was found or written from a description, so it is not proved until you have accepted it:', '',
      '```lean', statement, '```', '', `If it is what you mean, run \`/prove ${rt.shown(ctx, goal.file)} ${goal.theorem}\`.`,
    ], { ok: true, tone: 'accent' });
    return false;
  }
  const accepted = await ctx.ui.confirm('Prove this statement?',
    `${statement}\n\n${goal.declaration.docstring ?? ''}\n\nA proof only counts for your claim if this statement says what you mean.`);
  if (!accepted) {
    rt.card('/prove · statement not accepted', [`Nothing was proved. Edit ${rt.shown(ctx, goal.file)}, or run /formalize with a more precise description.`], { ok: false, tone: 'accent' });
  }
  return accepted;
}
