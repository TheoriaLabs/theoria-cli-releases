import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '@theoria/shared/config';
import { agentDir, projectPath } from '@theoria/shared/paths';

/**
 * A workflow's prompt, as a Markdown file with frontmatter, in the manner of a Claude Code slash command.
 *
 * Looked up first match wins: the project's `.theoria/commands/<name>.md`, then the user's
 * `~/.theoria-cli/agent/commands/<name>.md`, then the default shipped here (directories from `paths`). Settings a
 * file leaves out come from `workflows.defaults`, and `workflows.limits` bounds what it may set. The file decides how the agent is asked
 * to work. What counts as a result is decided by Theoria's checks, which a prompt cannot change, except to permit
 * more axioms explicitly.
 */

export type WorkflowName = 'prove' | 'formalize' | 'compress';
export const workflowNames: WorkflowName[] = ['formalize', 'prove', 'compress'];

export interface PromptSettings {
  description: string;
  argumentHint: string;
  maxAttempts: number;
  timeoutSeconds: number;
  model?: string;
  allowedAxioms: string[];
  emphasis: Emphasis;
  confirmStatement: boolean;
}

export interface WorkflowPrompt {
  name: WorkflowName;
  source: 'project' | 'user' | 'default';
  path: string;
  settings: PromptSettings;
  /** The first message of a run. */
  body: string;
  /** The message after a failed check, with `{{diagnostics}}`. */
  retry: string;
}

export const retryMarker = '<!-- on-retry -->';

const defaultsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'commands');

export const emphases = ['loc', 'clarity', 'balanced'] as const;
export type Emphasis = typeof emphases[number];

export const promptLocations = (name: WorkflowName, cwd: string) => [
  { source: 'project' as const, path: projectPath(cwd, config().paths.commandsDir, `${name}.md`) },
  { source: 'user' as const, path: join(agentDir(), config().paths.commandsDir, `${name}.md`) },
  { source: 'default' as const, path: join(defaultsDir, `${name}.md`) },
];

export class PromptError extends Error {}

export function loadPrompt(name: WorkflowName, cwd: string): WorkflowPrompt {
  const location = promptLocations(name, cwd).find(entry => existsSync(entry.path))!;
  return readPrompt(name, location);
}

/** Experiments snapshot the shipped prompt, independent of mutable user/project overrides. */
export function loadDefaultPrompt(name: WorkflowName): WorkflowPrompt {
  return readPrompt(name, { source: 'default', path: join(defaultsDir, `${name}.md`) });
}

function readPrompt(name: WorkflowName, location: { source: WorkflowPrompt['source']; path: string }): WorkflowPrompt {
  const text = readFileSync(location.path, 'utf8');
  const { meta, body } = splitFrontmatter(text, location.path);
  const settings = parseSettings(name, meta, location.path);
  const [main, retry] = body.split(retryMarker);
  return {
    name, source: location.source, path: location.path, settings,
    body: main!.trim(),
    retry: (retry ?? defaultRetry).trim(),
  };
}

const defaultRetry = `Theoria's check did not accept the result (attempt {{attempt}} of {{max_attempts}}):

{{diagnostics}}

Fix this in {{file}} and stop when you are done. Keep the rules of the original request.`;

function splitFrontmatter(text: string, path: string): { meta: Record<string, string | string[]>; body: string } {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) throw new PromptError(`${path}: the frontmatter has no closing ---.`);
  const meta: Record<string, string | string[]> = {};
  let listKey: string | undefined;
  for (const raw of text.slice(3, end).split('\n')) {
    const line = raw.replace(/\s+#.*$/, '');
    if (!line.trim()) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) { (meta[listKey] as string[]).push(unquote(item[1]!)); continue; }
    const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!pair) throw new PromptError(`${path}: cannot read the frontmatter line "${raw.trim()}".`);
    const [, key, value] = pair as unknown as [string, string, string];
    if (value === '') { meta[key] = []; listKey = key; continue; }
    listKey = undefined;
    meta[key] = value.startsWith('[') && value.endsWith(']')
      ? value.slice(1, -1).split(',').map(entry => unquote(entry.trim())).filter(Boolean)
      : unquote(value);
  }
  return { meta, body: text.slice(text.indexOf('\n', end + 1) + 1) };
}

const unquote = (value: string) => value.trim().replace(/^(['"])(.*)\1$/, '$2');

const known = ['description', 'argument-hint', 'max-attempts', 'timeout-seconds', 'model', 'allowed-axioms', 'emphasis', 'confirm-statement'];

/** Every key is validated, so a misspelt or out-of-range setting is an error rather than silently ignored. */
function parseSettings(name: WorkflowName, meta: Record<string, string | string[]>, path: string): PromptSettings {
  const { defaults, limits } = config().workflows;
  const fail = (message: string): never => { throw new PromptError(`${path}: ${message}`); };
  for (const key of Object.keys(meta)) if (!known.includes(key)) fail(`unknown setting "${key}". Known: ${known.join(', ')}.`);
  const text = (key: string) => {
    const value = meta[key];
    if (value === undefined) return undefined;
    if (Array.isArray(value)) fail(`"${key}" must be a single value.`);
    return value as string;
  };
  const integer = (key: string, fallback: number, { min, max }: { min: number; max: number }) => {
    const value = text(key);
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) fail(`"${key}" must be a whole number from ${min} to ${max}, not "${value}".`);
    return parsed;
  };
  const axioms = meta['allowed-axioms'];
  const allowedAxioms = axioms === undefined ? [] : Array.isArray(axioms) ? axioms : [axioms];
  for (const axiom of allowedAxioms) if (!/^[\w.']+$/.test(axiom)) fail(`"${axiom}" in allowed-axioms is not an axiom name.`);
  const emphasis = text('emphasis') ?? defaults.emphasis;
  if (!isEmphasis(emphasis)) fail(`"emphasis" must be ${emphases.join(', ')}, not "${emphasis}".`);
  if (meta.emphasis !== undefined && name !== 'compress') fail('"emphasis" applies only to compress.');
  const confirm = text('confirm-statement');
  if (confirm !== undefined && !['true', 'false'].includes(confirm)) fail(`"confirm-statement" must be true or false, not "${confirm}".`);
  if (confirm !== undefined && name !== 'prove') fail('"confirm-statement" applies only to prove.');
  const model = text('model');
  if (model !== undefined && !/^[\w.-]+\/\S+$/.test(model)) fail(`"model" must be provider/model-id, not "${model}".`);
  return {
    description: text('description') ?? `Theoria /${name}`,
    argumentHint: text('argument-hint') ?? '',
    maxAttempts: integer('max-attempts', defaults.maxAttempts, limits.maxAttempts),
    timeoutSeconds: integer('timeout-seconds', defaults.timeoutSeconds, limits.timeoutSeconds),
    ...(model ? { model } : {}),
    allowedAxioms,
    emphasis: emphasis as Emphasis,
    confirmStatement: confirm === undefined ? defaults.confirmStatement : confirm === 'true',
  };
}

export const isEmphasis = (value: string): value is Emphasis => (emphases as readonly string[]).includes(value);

/**
 * Fills a prompt: `$ARGUMENTS`, `$1`… and `${1:-default}` as in Pi and Claude Code templates, `{{name}}` for
 * Theoria's variables, and `{{#if name}}…{{/if}}` / `{{#unless name}}…{{/unless}}` for sections that apply only
 * sometimes, such as free-text input or a retry.
 */
export function render(template: string, args: string, vars: Record<string, string | number | boolean | undefined>): string {
  const positional = splitArgs(args);
  let text = template;
  for (let pass = 0; pass < 4; pass += 1) {
    text = text
      .replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_m, key: string, inner: string) => (vars[key] ? inner : ''))
      .replace(/\{\{#unless (\w+)\}\}([\s\S]*?)\{\{\/unless\}\}/g, (_m, key: string, inner: string) => (vars[key] ? '' : inner));
  }
  text = text
    .replace(/\{\{(\w+)\}\}/g, (_m, key: string) => (vars[key] === undefined || vars[key] === false ? '' : String(vars[key])))
    .replace(/\$\{(\d+):-([^}]*)\}/g, (_m, index: string, fallback: string) => positional[Number(index) - 1] ?? fallback)
    .replace(/\$\{@:-([^}]*)\}/g, (_m, fallback: string) => args.trim() || fallback)
    .replace(/\$ARGUMENTS|\$@/g, args.trim())
    .replace(/\$(\d+)/g, (_m, index: string) => positional[Number(index) - 1] ?? '');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

/** Quoted arguments and option values keep their spaces; bare Lean names may contain apostrophes. */
export function splitArgs(args: string): string[] {
  const tokens: string[] = [];
  let word = '', quote = '', started = false;
  for (let i = 0; i < args.length; i++) {
    const char = args[i]!, next = args[i + 1];
    if (quote) {
      if (char === quote) quote = '';
      else if (quote === '"' && char === '\\' && (next === '"' || next === '\\')) { word += next; i++; }
      else word += char;
    } else if (/\s/.test(char)) {
      if (started) tokens.push(word);
      word = ''; started = false;
    } else if (char === '"' || char === "'" && (!started || word.endsWith('='))) {
      quote = char; started = true;
    } else {
      if (char === '\\' && next !== undefined && (/\s/.test(next) || next === '"' || next === "'" || next === '\\')) { word += next; i++; }
      else word += char;
      started = true;
    }
  }
  if (quote) throw new Error('Unterminated quoted argument; use matching straight quotes.');
  if (started) tokens.push(word);
  return tokens;
}
