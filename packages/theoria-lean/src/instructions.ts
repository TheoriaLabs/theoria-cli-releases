import { config } from '@theoria/shared/config';
import { label, ready, type Environment } from './environment.ts';
import { leanVersionOf } from './toolchain.ts';
import { extraSpec } from './extras.ts';
import { currentProfile } from '@theoria/shared/harness';

/** The Mathlib search tools' names, as Pi declares them (`mcp__<server>__<tool>`). */
export const searchToolName = (server: string, tool: string) => `mcp__${server.replace(/[^A-Za-z0-9_]/g, '_')}__${tool}`;

/**
 * The search tools' lines for the `<tools>` summary of the system prompt (`leanSearch.toolLines`), and the guideline
 * that goes with them (`leanSearch.guideline`, attached to the first tool). Pi lists a tool there only when it has a
 * line, and MCP tools bring none of their own; without these the model sees them as schemas only, next to `grep`.
 */
export function searchToolPrompt(server: string): { snippets: Record<string, string>; guidelines: Record<string, string[]> } {
  const settings = config().leanSearch;
  const lsp = currentProfile().leanLspTools;
  const enabled = settings.toolLines.filter(entry => !settings.disabledTools.includes(entry.tool) || lsp.includes(entry.tool));
  const snippets = Object.fromEntries(enabled.map(entry => [searchToolName(server, entry.tool), entry.line
    + (['lean_loogle', 'lean_leanfinder'].includes(entry.tool) ? `; num_results defaults to ${settings.topK}` : '')
    + (entry.tool === 'lean_local_search' ? '; includes native dependencies and Unicode names; index=warming/unavailable/error means incomplete generated-declaration coverage' : '')
    + (entry.tool === 'lean_loogle' ? '; preserves query diagnostics; an empty query may use one broader query, identified by matched_query; broaden=false disables this' : '')]));
  const first = settings.toolLines[0];
  const guidelines: Record<string, string[]> = first ? { [searchToolName(server, first.tool)]: [`${settings.guideline} ${settings.batchGuideline}`] } : {};
  if (lsp.length) guidelines[searchToolName(server, lsp[0]!)] = [
    'Use the available LSP inspection tools when a tactic, expression type or diagnostic is unclear. Use file_path and 1-indexed positions; lean_goal without column shows before/after states and format="structured" exposes hypotheses and targets. Await file edits before querying that file; do not batch dependent edits and LSP queries. If status is still_elaborating, wait and query again. For exposed probe tools, batch tactic alternatives with lean_multi_attempt and use lean_code_actions for resolved suggestion edits. Scratch results and profiler timings are not whole-file verification or compression scores; use lean_check and the host gate for final acceptance.',
  ];
  return { snippets, guidelines };
}

/**
 * The Mathlib search section, when its tools are on in this session. A search result is a lead only: names and
 * statements are confirmed with Lean before anything relies on them.
 */
export function searchInstructions(server: string): string {
  return [
    `Loogle and Lean Finder are remote services that search their own recent Mathlib, which can differ from this session's; `
      + `\`${searchToolName(server, 'lean_local_search')}\` searches this project, its allowed native dependencies and the Lean standard library. Empty results with index=warming/unavailable/error do not establish absence of generated declarations.`,
    'A search result is only a lead: confirm a lemma\'s name and statement with `lean_check` before you rely on it, and never cite a '
      + 'search result as evidence that something holds.',
    'The remote services allow about 3 requests per 30 s each. When one reports a rate limit, say so and use local search or another '
      + 'search instead of retrying.',
    'Loogle retains diagnostic headers and suggestions. After an empty query it may try one broader query by removing filters, within the same rate limit; check matched_query before using a hit. Use broaden=false for an exact-query-only search.',
    ...(currentProfile().leanLspTools.length ? [
      `This harness also exposes Lean LSP inspection and isolated probes: ${currentProfile().leanLspTools.map(tool => `\`${searchToolName(server, tool)}\``).join(', ')}. Inspect goals, types and diagnostics, and use only the probe tools available in this profile. Local tactic counts and profiler timings do not replace whole-file compression measurement or host verification.`,
    ] : []),
  ].join('\n');
}

/** The Lean environment section of the agent's system prompt, added before each turn. */
export function instructions(environment: Environment): string {
  const rules = [
    'Check Lean code with the `lean_check` tool, which reports errors, `sorry` and the axioms a theorem depends on.',
    'Do not install, switch or update Lean or Mathlib yourself; the user chooses them with /lean.',
  ];
  if (!ready(environment)) {
    return [environment.source === 'none'
      ? 'No Lean environment is selected. If the task needs Lean, ask the user to choose one with /lean.'
      : `The selected Lean environment (${label(environment)}) is not usable: ${environment.problem} Tell the user; do not work around it.`].join('\n');
  }
  if (environment.source === 'lean-project') {
    const projectExtras = (environment.extras ?? []).flatMap(extra => (extra.ready ? extraSpec(extra.name)?.instructions ?? [] : []));
    return [`This folder is a Lean project with its own toolchain (Lean ${leanVersionOf(environment.toolchain ?? '')}) and dependencies. `
      + 'Build with `lake build` and check a file with `lake lean <file>` in the project root (it applies the project\'s Lean options; `lake env lean` does not).', ...rules, ...projectExtras].join('\n');
  }
  const extras = (environment.extras ?? []).flatMap(extra => (extra.ready ? extraSpec(extra.name)?.instructions ?? [] : [`${extra.title} is not available here: ${extra.problem}.`]));
  return [
    `${label(environment)} is selected. The bash tool already runs \`lean\` with this toolchain`
      + `${environment.mathlib ? ' and Mathlib on the import path, so `lean File.lean` with `import Mathlib` works in any directory' : ''}.`,
    ...rules, ...extras].join('\n');
}
