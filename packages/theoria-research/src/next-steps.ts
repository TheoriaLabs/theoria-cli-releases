import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '@theoria/shared/config';
import { agentDir, projectPath } from '@theoria/shared/paths';
import { render } from '@theoria/pi-workflows/api';

/**
 * `/next-steps`: a prompt sent to the agent as if you had typed it, asking for ranked next steps on papers or a line
 * of research. The prompt is a Markdown file, looked up like the workflow prompts: the project's
 * `.theoria/commands/next-steps.md`, then the user's `<agent dir>/commands/next-steps.md`, then the shipped default,
 * so it can be changed without touching code. Optional frontmatter (`---` … `---`) is dropped. The body takes
 * `$ARGUMENTS`, `$1`… as Pi prompt templates do, plus `{{count}}`, `{{focus}}`, `{{focus_guidance}}` and
 * `{{#if focus}}…{{/if}}` for the options.
 */
export const nextStepsName = 'next-steps';
export const nextStepsFocuses = ['theory', 'numerics', 'formalization'] as const;
export type NextStepsFocus = typeof nextStepsFocuses[number];
export const nextStepsLimits = { min: 1, max: 10, default: '5–8' } as const;
export const nextStepsUsage = `/next-steps <arxiv-id | url | file | topic> [more papers…] [--n <${nextStepsLimits.min}-${nextStepsLimits.max}>] [--focus ${nextStepsFocuses.join('|')}]`;

const focusGuidance: Record<NextStepsFocus, string> = {
  theory: 'Favour new theorems, generalizations, sharper bounds, proofs or disproofs of stated conjectures, and links between areas.',
  numerics: 'Favour computations, simulations, experiments and counterexample searches, naming the data, code or compute each needs.',
  formalization: 'Favour results to state and prove in Lean 4 with Mathlib: check what Mathlib already covers and name the definitions and lemmas that are missing.',
};

const shipped = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', `${nextStepsName}.md`);

export const nextStepsLocations = (cwd: string) => [
  { source: 'project' as const, path: projectPath(cwd, config().paths.commandsDir, `${nextStepsName}.md`) },
  { source: 'user' as const, path: join(agentDir(), config().paths.commandsDir, `${nextStepsName}.md`) },
  { source: 'default' as const, path: shipped },
];

export interface NextStepsRequest { sources: string; count?: number; focus?: NextStepsFocus }

/**
 * Splits `--n <k>` / `--n=<k>` and `--focus <kind>` / `--focus=<kind>` out of what was typed, anywhere in it, and
 * keeps the rest exactly as written (quoted topics included). Throws with the usage on a bad or repeated option.
 */
export function parseNextSteps(args: string): NextStepsRequest {
  let rest = ` ${args} `;
  const take = (name: string): string | undefined => {
    const pattern = new RegExp(`\\s--${name}(?:=|\\s+)(\\S*)(?=\\s)`, 'g');
    const found = [...rest.matchAll(pattern)];
    if (!found.length) {
      if (new RegExp(`\\s--${name}\\s*$`).test(rest)) throw new Error(`--${name} needs a value. Usage: ${nextStepsUsage}`);
      return undefined;
    }
    if (found.length > 1) throw new Error(`Give --${name} only once. Usage: ${nextStepsUsage}`);
    rest = rest.replace(pattern, ' ');
    return found[0]![1]!;
  };
  const count = take('n');
  const focus = take('focus');
  const unknown = /\s(--[A-Za-z][\w-]*)/.exec(rest);
  if (unknown) throw new Error(`Unknown option ${unknown[1]}. Usage: ${nextStepsUsage}`);
  const sources = rest.replace(/\s+/g, ' ').trim();
  if (!sources) throw new Error(`Usage: ${nextStepsUsage}`);
  const request: NextStepsRequest = { sources };
  if (count !== undefined) {
    const value = Number(count);
    if (!/^\d+$/.test(count) || value < nextStepsLimits.min || value > nextStepsLimits.max)
      throw new Error(`--n must be a whole number from ${nextStepsLimits.min} to ${nextStepsLimits.max}, not "${count}".`);
    request.count = value;
  }
  if (focus !== undefined) {
    if (!(nextStepsFocuses as readonly string[]).includes(focus)) throw new Error(`--focus must be ${nextStepsFocuses.join(', ')}, not "${focus}".`);
    request.focus = focus as NextStepsFocus;
  }
  return request;
}

/** The filled-in prompt, the parsed request, and which file the prompt came from. */
export function nextStepsPrompt(cwd: string, args: string): { text: string; request: NextStepsRequest; source: 'project' | 'user' | 'default'; path: string } {
  const request = parseNextSteps(args);
  const location = nextStepsLocations(cwd).find(entry => existsSync(entry.path))!;
  const raw = readFileSync(location.path, 'utf8');
  const body = raw.startsWith('---') ? raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '') : raw;
  if (!body.trim()) throw new Error(`${location.path} has no prompt body.`);
  // An edited prompt that leaves out a placeholder still receives the request and options, never silently drops them.
  let template = /\$ARGUMENTS|\$@|\$\{@|\$\{?\d/.test(body) ? body : `${body.trimEnd()}\n\n$ARGUMENTS`;
  if (request.count && !template.includes('{{count}}')) template += `\n\nPropose exactly ${request.count} ideas.`;
  if (request.focus && !template.includes('{{focus')) template += `\n\nFocus: ${request.focus}. ${focusGuidance[request.focus]}`;
  const vars = { count: request.count ? `exactly ${request.count}` : nextStepsLimits.default, focus: request.focus,
    focus_guidance: request.focus ? focusGuidance[request.focus] : undefined };
  return { text: render(template, request.sources, vars), request, source: location.source, path: location.path };
}
