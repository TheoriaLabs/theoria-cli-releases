import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stripFrontmatter } from '@earendil-works/pi-coding-agent';
import { config } from '@theoria/shared/config';
import type { WorkflowPrompt } from './prompt.ts';
import { sourceHash } from './compression-metrics.ts';

export const compressSkillPath = join(import.meta.dirname, '..', 'skills', 'compress', 'SKILL.md');

export type CompressionSkillSelection = { mode: 'default' | 'file'; path: string } | { mode: 'none' };
export interface CompressionSkill {
  text: string;
  sha256: string;
  /** Absent in historical frozen inputs; never infer those inputs from today's default. */
  selection?: CompressionSkillSelection;
}

/** Shared skill=<path>|none syntax. A selector is not part of a theorem name or round count. */
export function compressionSkillArgs(tokens: string[]): { args: string[]; skill?: string } {
  const args: string[] = [];
  let skill: string | undefined;
  for (const token of tokens) {
    if (!token.startsWith('skill=')) { args.push(token); continue; }
    if (skill !== undefined) throw new Error('Specify skill only once.');
    skill = token.slice('skill='.length);
    if (!skill.trim()) throw new Error('skill must be a file path or none.');
  }
  return { args, ...(skill !== undefined ? { skill } : {}) };
}

/** Resolve once, before execution; the returned text and provenance can be frozen verbatim. */
export function resolveCompressionSkill(cwd: string, selector?: string): CompressionSkill & { selection: CompressionSkillSelection } {
  if (selector === 'none') return { text: '', sha256: sourceHash(''), selection: { mode: 'none' } };
  if (selector !== undefined && !selector.trim()) throw new Error('skill must be a file path or none.');
  const path = selector === undefined ? compressSkillPath : resolve(cwd, selector);
  const text = readFileSync(path, 'utf8');
  if (!text.trim()) throw new Error('Compression skill is empty; use skill=none to explicitly omit the skill body.');
  return { text, sha256: sourceHash(text), selection: { mode: selector === undefined ? 'default' : 'file', path } };
}

export const compressionSkillLabel = (skill: CompressionSkill) =>
  `${skill.selection?.mode ?? 'file'}${skill.selection && 'path' in skill.selection ? ` (${skill.selection.path})` : ''} · ${skill.sha256.slice(0, 12)}`;

export const compressWorkflowGuideline = () =>
  `Whenever the user expresses an intent to reduce the size or length of an existing Lean proof, shorten it, make it more compact, or lower its heartbeat cost, invoke the /compress workflow with \`${config().actions.tool}\` (action: "compress"). For a whole-file request, args is the file path, optionally followed by a positive integer round count (default ${config().workflows.compression.rounds}), e.g. "Solution.lean 5". For an individual theorem/lemma use "Solution.lean Namespace.myLemma 5"; the round count is optional. Omit skill to use the bundled default, pass skill=<path> for another skill, or skill=none for core compression instructions only; quote the whole skill=<path> argument when the path contains spaces. Resolve an ambiguous file or theorem name first. Use the workflow rather than editing proofs outside it. When already executing /compress, follow its instructions and do not start a nested workflow.`;

/** The workflow loads the same skill Pi discovers, including for custom command prompts and retries. */
export function withCompressSkill(prompt: WorkflowPrompt, skill?: string): WorkflowPrompt {
  const instructions = stripFrontmatter(skill ?? readFileSync(compressSkillPath, 'utf8')).trim();
  const active = `The /compress workflow is already active. ${instructions ? 'Apply the compress skill below to the assigned target' : 'Follow the core compression instructions below; no additional skill body is selected'}; do not invoke a nested workflow.
{{#if comparator}}Scope: the benchmark targets {{theorems_json}} in {{file}}. Comparator judges their statements, dependencies, permitted axioms and kernel validity against the frozen challenge. Compiler-generated helper names may change or disappear. Keep proof work in the measured file; new or rewritten helper definitions count toward size.{{/if}}
{{#unless comparator}}{{#if whole_file}}Scope: the whole file {{file}}, with {{target_count}} proof targets: {{theorems}}. Review all proofs in this one workflow. Preserve every existing theorem/lemma name and statement, anonymous example statements, and definitions; source-declared helper lemmas cannot be deleted. New helpers must also verify and count toward total size.{{/if}}
{{#if theorem}}Scope: the theorem/lemma {{theorem}} in {{file}}. Preserve every source-declared statement and definition, and do not introduce gaps in other proofs.{{/if}}
Compiler-generated proof auxiliaries may change or disappear; bound-variable names are not part of the semantic preservation check.{{/unless}}

Round {{round}} of {{rounds}}. Re-read the current proof and replan from scratch for this round. The current best verified checkpoint is {{best_snapshot}}.
Current verified measurements (heartbeats are serial Lean command elaboration, in user-facing units):
{{current_measurements}}
Use lean_check with measureHeartbeats: true and theorems: {{theorems_json}} after significant changes. Theoria verifies and measures independently.
The active compress_score uses configured weights {{score_weights}}: {{score_formula}}. Size and heartbeat reductions are relative to the original baseline; compatibility is the absolute fraction of the fixed environment matrix that actually passed. Proof tokens exclude statements, comments and blank lines; the recorded tokenizer defines the count. New helper proofs count too, and new or rewritten non-proof helper declarations count in full. Current best compress_score: {{current_score}}%. Acceptance requires at least {{minimum_improvement}} percentage points of score gain and caps heartbeat regression at {{heartbeat_regression_limit}}% against both the original and current best. Emphasis and the strategy below do not override this measured objective. Keep non-dominated tradeoffs on the Pareto frontier, and use compress_score to rank them. Compatibility claims must name versions actually checked; no unmeasured zero-shot compatibility percentage.

${instructions}`;
  return { ...prompt, body: `${active}\n\n${prompt.body}`, retry: `${active}\n\n${prompt.retry}` };
}
