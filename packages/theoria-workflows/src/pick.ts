import { openTheorems, read } from './gate.ts';
import { declarations, isTheorem, matchingDeclarations, writesSorry, type Declaration } from './lean-source.ts';
import type { Ctx, WorkflowRuntime } from './runtime.ts';
import type { Match, Parsed } from './target.ts';
import { splitArgs } from './prompt.ts';

/** A theorem a workflow works on, and whether the user named it or it was found from a description. */
export interface Goal { file: string; theorem: string; declaration: Declaration; fromDescription: boolean }

/** Words after the file and theorem name are guidance for the agent. */
export const guidance = (parsed: Parsed) =>
  (parsed.target.kind === 'file' ? splitArgs(parsed.text).slice(parsed.target.theorem ? 2 : 1).join(' ') : '');

/**
 * The theorem a `/prove` or `/compress` input refers to: from a file (the one open or proved theorem in it, or a
 * choice), an exact name, or several matches the user picks between. Reports what is missing and returns nothing
 * when there is no theorem to work on.
 */
export async function pickTheorem(rt: WorkflowRuntime, ctx: Ctx, parsed: Parsed, workflow: 'prove' | 'compress'): Promise<Goal | undefined> {
  const target = parsed.target;
  let file: string;
  let theorem: string | undefined;
  let fromDescription = false;
  if (target.kind === 'file') {
    file = target.file;
    theorem = target.theorem;
    if (!theorem) {
      const source = read(file) ?? '';
      const candidates = workflow === 'prove' ? openTheorems(source) : declarations(source).filter(entry => isTheorem(entry) && !writesSorry(entry));
      if (!candidates.length) {
        rt.card(`/${workflow} · nothing to ${workflow}`, [`${rt.shown(ctx, file)} has no ${workflow === 'prove' ? 'theorem with a sorry' : 'proved theorem'}. `
          + `Name one: \`/${workflow} ${rt.shown(ctx, file)} <theorem>\`.`], { ok: false, tone: 'accent' });
        return undefined;
      }
      theorem = candidates.length === 1
        ? candidates[0]!.name
        : (await pickMatch(rt, ctx, workflow, candidates.map(entry => ({ file, theorem: entry.name, score: 1, header: entry.header }))))?.theorem;
    }
  } else if (target.kind === 'theorem') {
    file = target.file; theorem = target.theorem;
    // An exact name is the user naming the statement; anything else was a description that happened to match.
    fromDescription = parsed.text.trim() !== theorem && parsed.text.trim() !== theorem.split('.').pop();
  } else if (target.kind === 'matches') {
    const match = await pickMatch(rt, ctx, workflow, target.matches);
    if (!match) return undefined;
    file = match.file; theorem = match.theorem; fromDescription = true;
  } else return undefined;
  if (!theorem) return undefined;
  const candidates = matchingDeclarations(declarations(read(file) ?? '').filter(isTheorem), theorem);
  if (candidates.length > 1) {
    const picked = await pickMatch(rt, ctx, workflow, candidates.map(entry => ({ file, theorem: entry.name, score: 1, header: entry.header })));
    if (!picked) return;
    theorem = picked.theorem;
  }
  const declaration = candidates.length === 1 ? candidates[0] : candidates.find(entry => entry.name === theorem);
  if (!declaration) {
    rt.card(`/${workflow} · theorem not found`, [`There is no theorem \`${theorem}\` in ${rt.shown(ctx, file)}.`], { ok: false, tone: 'accent' });
    return undefined;
  }
  if (target.kind === 'theorem' && matchingDeclarations([declaration], parsed.text.trim()).length) fromDescription = false;
  return { file, theorem: declaration.name, declaration, fromDescription };
}

async function pickMatch(rt: WorkflowRuntime, ctx: Ctx, workflow: string, matches: Match[]): Promise<Match | undefined> {
  if (!ctx.hasUI) {
    rt.card(`/${workflow} · several theorems match`, ['Name the one you mean:', '',
      ...matches.map(match => `- \`/${workflow} ${rt.shown(ctx, match.file)} ${match.theorem}\``)], { ok: false, tone: 'accent' });
    return undefined;
  }
  const labels = matches.map(match => `${match.theorem} · ${rt.shown(ctx, match.file)}`);
  const picked = await ctx.ui.select('Which theorem?', labels);
  return picked ? matches[labels.indexOf(picked)] : undefined;
}
