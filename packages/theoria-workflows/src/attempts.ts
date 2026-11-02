import type { Environment } from '@theoria/pi-lean/api';
import { config } from '@theoria/shared/config';
import type { Verdict } from './gate.ts';
import { render, type WorkflowPrompt } from './prompt.ts';
import type { CardLine, Ctx, WorkflowRuntime } from './runtime.ts';
import { basename } from 'node:path';

export interface AttemptRun {
  workflow: 'prove' | 'compress';
  file: string;
  theorem?: string;
  /** The file before the agent started, restored if no attempt passes. */
  before: string;
  vars: Record<string, string | number | boolean>;
  check: () => Promise<Verdict>;
  /** The card's title and lines when a check passes. */
  success: (verdict: Verdict) => [string, CardLine[]];
}

/**
 * The retry loop of `/prove` and `/compress`: prompt, wait for the agent, run Theoria's check, and on a failure send
 * Lean's messages back, until a check passes or `max-attempts` run out. A cancelled or exhausted run restores the
 * file and keeps the last attempt.
 */
export async function attemptLoop(rt: WorkflowRuntime, ctx: Ctx, prompt: WorkflowPrompt, environment: Environment, run: AttemptRun) {
  const max = prompt.settings.maxAttempts;
  rt.theorem = run.theorem;
  rt.file = rt.shown(ctx, run.file);
  const target = run.theorem ?? `${rt.file} · ${run.vars.target_count} proof targets`;
  const snapshotName = run.theorem ?? `${basename(run.file, '.lean')}-whole-file`;
  const vars = { ...run.vars, file: rt.shown(ctx, run.file), theorem: run.theorem ?? '' };
  let diagnostics = '';
  let reply = '';
  for (let attempt = 1; attempt <= max; attempt += 1) {
    rt.status(ctx, `/${run.workflow} ${target} · attempt ${attempt}/${max}`);
    const message = render(attempt === 1 ? prompt.body : prompt.retry, String(run.vars.request ?? ''), {
      ...vars, ...rt.baseVars(environment, prompt, attempt, diagnostics),
    });
    const result = await rt.turn(ctx, message);
    reply = result.reply;
    if (result.aborted || result.error) {
      const kept = rt.restore(ctx, run.file, run.before, snapshotName);
      rt.card(`/${run.workflow} · ${result.error ? 'interrupted' : 'cancelled'}`, [result.error, `${rt.shown(ctx, run.file)} is as it was.`, kept && `The unfinished attempt is kept at ${rt.shown(ctx, kept)}.`], { ok: false, outcome: result.error ? 'interrupted' : 'cancelled' });
      return;
    }
    rt.status(ctx, `/${run.workflow} ${target} · Lean is checking attempt ${attempt}`);
    let verdict: Verdict;
    try { verdict = await run.check(); }
    catch (error) {
      const kept = rt.restore(ctx, run.file, run.before, snapshotName);
      rt.card(`/${run.workflow} · interrupted`, [String(error), `${rt.shown(ctx, run.file)} is as it was.`, kept && `The unfinished attempt is kept at ${rt.shown(ctx, kept)}.`], { ok: false, outcome: 'unavailable' });
      return;
    }
    if (rt.signal?.aborted || verdict.check?.status === 'timeout' || verdict.check?.status === 'unavailable' || verdict.details.outcome === 'unavailable') {
      const kept = rt.restore(ctx, run.file, run.before, snapshotName);
      const outcome = rt.signal?.aborted ? 'cancelled' : verdict.check?.status ?? 'unavailable';
      rt.card(`/${run.workflow} · ${outcome}`, [verdict.summary, `${rt.shown(ctx, run.file)} is as it was.`, kept && `The unfinished attempt is kept at ${rt.shown(ctx, kept)}.`], { ok: false, ...verdict.details, outcome });
      return;
    }
    if (verdict.ok) {
      const [title, lines] = run.success(verdict);
      rt.card(title, [...lines, `Attempt ${attempt} of ${max}. ${rt.promptNote(ctx, prompt)}`], { ok: true, ...verdict.details });
      return;
    }
    diagnostics = verdict.diagnostics;
  }
  const kept = rt.restore(ctx, run.file, run.before, snapshotName);
  rt.card(`/${run.workflow} · ${run.workflow === 'prove' ? 'unresolved' : 'not compressed'} after ${max} attempt(s)`, [
    `${run.theorem ? `\`${run.theorem}\` in ` : ''}${rt.shown(ctx, run.file)} is as it was before; nothing is claimed.`, '',
    ...rt.diagnostics(diagnostics),
    reply && `\nThe agent's last word: ${reply.slice(0, config().workflows.card.replyChars)}`,
    kept && `The last attempt is kept at ${rt.shown(ctx, kept)}.`, rt.promptNote(ctx, prompt),
  ], { ok: false });
}
