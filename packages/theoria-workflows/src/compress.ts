import { label, type Environment } from '@theoria/pi-lean/api';
import { read } from './gate.ts';
import { statementText } from './lean-source.ts';
import { guidance, pickTheorem } from './pick.ts';
import { emphases, isEmphasis, type WorkflowPrompt } from './prompt.ts';
import type { Ctx, WorkflowRuntime } from './runtime.ts';
import type { Parsed } from './target.ts';
import { resolveCompressionSkill, withCompressSkill, type CompressionSkill } from './compress-skill.ts';
import { compressionDetails, prepareCompression } from './compression-gate.ts';
import { compressionTarget } from './compression-target.ts';
import { compressionRounds } from './compression-rounds.ts';

/**
 * `/compress`: establish a verified/measured baseline, then optimize LOC and heartbeats across bounded rounds.
 * Rejected drafts roll back to the best verified checkpoint; original statements remain fixed throughout.
 */
export async function compress(rt: WorkflowRuntime, ctx: Ctx, parsed: Parsed, prompt: WorkflowPrompt, environment: Environment) {
  let rounds: number;
  let skill: CompressionSkill;
  let skipVerification = false;
  try {
    const target = compressionTarget(parsed, ctx.cwd);
    ({ parsed, rounds } = target);
    skill = resolveCompressionSkill(ctx.cwd, target.skill);
    skipVerification = target.skipVerification ?? false;
  }
  catch (error) { rt.card('/compress · invalid arguments', [String(error)], { ok: false }); return; }
  if (parsed.target.kind === 'text') {
    rt.card('/compress · no proof found', [`No theorem in this project matches "${parsed.text}". /compress works on a proof that already verifies; use /prove first.`], { ok: false, tone: 'accent' });
    return;
  }
  const emphasis = parsed.flags.emphasis ?? prompt.settings.emphasis;
  if (!isEmphasis(emphasis)) { ctx.ui.notify(`--emphasis must be ${emphases.join(', ')}, not "${emphasis}".`, 'error'); return; }
  const wholeFile = parsed.target.kind === 'file' && !parsed.target.theorem;
  const goal = wholeFile ? undefined : await pickTheorem(rt, ctx, parsed, 'compress');
  if (!wholeFile && !goal) return;
  const file = goal?.file ?? (parsed.target as { file: string }).file;
  const theorem = goal?.theorem;
  const before = read(file) ?? '';
  rt.theorem = theorem;
  rt.file = rt.shown(ctx, file);
  rt.targetDetails = { scope: wholeFile ? 'file' : 'theorem', environment: label(environment), skill: skill.selection, skillSha256: skill.sha256 };
  const input = { cwd: ctx.cwd, file, theorem, before, skipVerification, allowedAxioms: prompt.settings.allowedAxioms, timeoutSeconds: prompt.settings.timeoutSeconds, signal: rt.signal };
  rt.status(ctx, `/compress ${theorem ?? rt.file} · ${skipVerification ? 'loading baseline measurements' : 'checking the original'}`);
  const { baseline, verdict } = await prepareCompression(environment, input);
  if (!baseline) {
    const outcome = rt.signal?.aborted ? 'cancelled' : verdict.details.outcome;
    const heading = ['cancelled', 'timeout', 'unavailable'].includes(String(outcome)) ? String(outcome) : 'the original does not verify';
    rt.card(`/compress · ${heading}`, [`${rt.file} · ${label(environment)}`, ...rt.diagnostics(verdict.diagnostics)], { ok: false, ...verdict.details, outcome });
    return;
  }
  rt.targetDetails = { ...rt.targetDetails, ...compressionDetails(baseline) };
  await compressionRounds(rt, ctx, withCompressSkill(prompt, skill.text), environment, baseline, rounds, emphasis,
    { request: guidance(parsed), statement: goal ? statementText(goal.declaration) : '', baseline_lines: baseline.lines,
      whole_file: wholeFile, theorems: compressionDetails(baseline).theorems.join(', '),
      theorems_json: JSON.stringify(baseline.targets.map(entry => entry.userName).filter(name => !name.includes(baseline.examplePrefix))),
      target_count: baseline.targets.length, emphasis, clarity: emphasis === 'clarity' }, { skill });
}
