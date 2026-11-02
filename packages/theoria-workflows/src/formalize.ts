import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { label, type Environment } from '@theoria/pi-lean/api';
import { config } from '@theoria/shared/config';
import { projectRoot } from '@theoria/shared/paths';
import { projectRecord, saveProjectRecord } from '@theoria/shared/project';
import { relative } from 'node:path';
import { checkFormalize, read } from './gate.ts';
import { declarations, firstLine, namesFor, statementText, type Declaration } from './lean-source.ts';
import type { Goal } from './pick.ts';
import { render, type WorkflowPrompt } from './prompt.ts';
import type { Ctx, WorkflowRuntime } from './runtime.ts';
import type { Parsed } from './target.ts';

const identifier = /^[\p{L}_][\p{L}\p{N}_.']*$/u;

/** A new file under the project's `paths.formalDir`, named from the description, never overwriting one. */
function formalFile(cwd: string, base: string): string {
  const dir = join(projectRoot(cwd), config().paths.formalDir);
  let file = join(dir, `${base}.lean`);
  for (let n = 2; existsSync(file); n += 1) file = join(dir, `${base}${n}.lean`);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

/**
 * `/formalize`: the agent writes a new file with the statement proved by `sorry`; Theoria accepts it when Lean
 * elaborates it with `sorry` as the only gap. When `forProve`, this is the first half of `/prove` on a description.
 */
export async function formalize(rt: WorkflowRuntime, ctx: Ctx, parsed: Parsed, prompt: WorkflowPrompt, environment: Environment, forProve: boolean): Promise<Goal | undefined> {
  const target = parsed.target;
  if (target.kind !== 'text') {
    const existing = target.kind === 'matches' ? target.matches[0]! : { file: target.file, theorem: target.kind === 'file' ? (target.theorem ?? '') : target.theorem };
    const where = `${existing.theorem ? `\`${existing.theorem}\` in ` : ''}${rt.shown(ctx, existing.file)}`;
    if (!ctx.hasUI || !await ctx.ui.confirm('Already formalized?', `${where} looks like a formalization of this already. Write a new one anyway?`)) {
      rt.card('/formalize · already formalized', [`${where} matches "${parsed.text}". Use \`/prove ${parsed.text}\` to prove it, or ask again with different words for a new formalization.`], { ok: true, tone: 'accent' });
      return undefined;
    }
  }
  const request = target.kind === 'text' ? target.text : parsed.text;
  const sourceFile = target.kind === 'text' ? target.file : undefined;
  const names = namesFor(parsed.flags.name ?? (request || (sourceFile ? sourceFile.replace(/^.*\//, '').replace(/\.\w+$/, '') : '')));
  const theorem = parsed.flags.name && identifier.test(parsed.flags.name) ? parsed.flags.name : names.theorem;
  const file = formalFile(ctx.cwd, names.file);
  const max = prompt.settings.maxAttempts;
  rt.theorem = theorem;
  rt.file = rt.shown(ctx, file);
  const vars = { request, free: !sourceFile, source_file: sourceFile ? rt.shown(ctx, sourceFile) : '', file: rt.shown(ctx, file), theorem };
  const checkIt = () => checkFormalize(environment, { cwd: ctx.cwd, file, timeoutSeconds: prompt.settings.timeoutSeconds, signal: rt.signal });

  let diagnostics = '';
  for (let attempt = 1; attempt <= max; attempt += 1) {
    rt.status(ctx, `/formalize ${theorem} · attempt ${attempt}/${max}`);
    const message = render(attempt === 1 ? prompt.body : prompt.retry, request, { ...vars, ...rt.baseVars(environment, prompt, attempt, diagnostics) });
    const { aborted, error } = await rt.turn(ctx, message);
    if (aborted || error) {
      const kept = rt.restore(ctx, file, undefined, theorem);
      rt.card(`/formalize · ${error ? 'interrupted' : 'cancelled'}`, [error, kept && `The unfinished file is kept at ${rt.shown(ctx, kept)}.`], { ok: false, outcome: error ? 'interrupted' : 'cancelled' });
      return undefined;
    }
    rt.status(ctx, `/formalize ${theorem} · Lean is checking`);
    const verdict = await checkIt();
    if (rt.signal?.aborted || verdict.check?.status === 'timeout' || verdict.check?.status === 'unavailable') {
      const kept = rt.restore(ctx, file, undefined, theorem);
      rt.card('/formalize · interrupted', [verdict.summary, kept && `The unfinished file is kept at ${rt.shown(ctx, kept)}.`], { ok: false, outcome: rt.signal?.aborted ? 'cancelled' : verdict.check!.status });
      return undefined;
    }
    if (!verdict.ok) { diagnostics = verdict.diagnostics; continue; }

    let chosen = verdict.readings[0]!;
    if (verdict.readings.length > 1) {
      const picked = await chooseReading(ctx, file, verdict.readings);
      if (!picked) {
        rt.card(`/formalize · ${verdict.readings.length} readings, none chosen`, [
          `The description has several readings, each written to ${rt.shown(ctx, file)} and each well-formed:`, '',
          ...verdict.readings.map(reading => `- \`${reading.name}\`: ${firstLine(reading.docstring) ?? reading.header}`), '',
          `Choose one with \`/prove ${rt.shown(ctx, file)} <theorem>\`.`,
        ], { ok: true, tone: 'accent' });
        return undefined;
      }
      chosen = picked;
      const recheck = await checkIt();
      if (!recheck.ok) { diagnostics = recheck.diagnostics; continue; }
    }
    const fresh = declarations(read(file) ?? '').find(entry => entry.name === chosen.name) ?? chosen;
    // The first statement a Theoria project formalizes becomes its goal, which /status measures progress against.
    const record = projectRecord(ctx.cwd);
    const madeGoal = !!record && !record.goal;
    if (madeGoal) saveProjectRecord(ctx.cwd, { goal: { file: relative(projectRoot(ctx.cwd), file), theorem: fresh.name } });
    rt.card('/formalize · well-formed', [
      `\`${fresh.name}\` in ${rt.shown(ctx, file)} · ${label(environment)} · attempt ${attempt}/${max}`, '',
      '```lean', statementText(fresh), '```',
      fresh.docstring ? `\n${fresh.docstring}` : '', '',
      `Lean accepts the statement; that it is well-formed does not make it true.${forProve ? '' : ` Prove it with \`/prove ${fresh.name}\`.`}`,
      madeGoal && `It is now this project's Lean target; /status measures Lean-verified progress towards it.`,
      rt.promptNote(ctx, prompt),
    ], { ok: true, file, theorem: fresh.name });
    return { file, theorem: fresh.name, declaration: fresh, fromDescription: true };
  }
  const kept = rt.restore(ctx, file, undefined, theorem);
  rt.card(`/formalize · not formalized after ${max} attempt(s)`, [
    ...rt.diagnostics(diagnostics),
    kept && `The last attempt is kept at ${rt.shown(ctx, kept)}.`, rt.promptNote(ctx, prompt),
  ], { ok: false });
  return undefined;
}

/** Several readings: the user picks one, and the others are removed from the file. */
async function chooseReading(ctx: Ctx, file: string, readings: Declaration[]): Promise<Declaration | undefined> {
  if (!ctx.hasUI) return undefined;
  const width = config().workflows.card.readingChars;
  const labels = readings.map(reading => `${reading.name}: ${(firstLine(reading.docstring) ?? reading.header).slice(0, width)}`);
  const picked = await ctx.ui.select('The description has several readings. Which do you mean?', labels);
  if (!picked) return undefined;
  const chosen = readings[labels.indexOf(picked)]!;
  let source = read(file) ?? '';
  for (const reading of [...readings].sort((a, b) => b.start - a.start)) {
    if (reading.name !== chosen.name) source = source.slice(0, reading.start) + source.slice(reading.end);
  }
  writeFileSync(file, source.replace(/\n{3,}/g, '\n\n'), 'utf8');
  return chosen;
}
