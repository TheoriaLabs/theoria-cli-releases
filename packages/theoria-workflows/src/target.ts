import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { config } from '@theoria/shared/config';
import { projectRoot } from '@theoria/shared/paths';
import { declarations, isTheorem, matchingDeclarations, words, type Declaration } from './lean-source.ts';
import { splitArgs } from './prompt.ts';

/**
 * What a workflow's input refers to. Tried in order: a file, an exact theorem name in the project, a close match
 * among the project's theorems, and otherwise free text describing a statement.
 */
export type Target =
  | { kind: 'file'; file: string; theorem?: string }
  | { kind: 'theorem'; file: string; theorem: string }
  | { kind: 'matches'; matches: Match[] }
  | { kind: 'text'; text: string; file?: string };

export interface Match { file: string; theorem: string; score: number; header: string }

export interface Parsed { target: Target; flags: Record<string, string>; text: string }

const settings = () => config().workflows.target;

/** The project's own Lean files, outside `workflows.target.skipDirs` (dependencies, build output, Theoria's records). */
export function leanFiles(root: string): string[] {
  const { skipDirs, maxFiles, maxDepth } = settings();
  const skipped = new Set(skipDirs);
  const found: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (found.length >= maxFiles || depth > maxDepth) return;
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (skipped.has(name) || name.startsWith('.')) continue;
      const path = join(dir, name);
      let info;
      try { info = statSync(path); } catch { continue; }
      if (info.isDirectory()) walk(path, depth + 1);
      else if (name.endsWith('.lean')) found.push(path);
    }
  };
  walk(root, 0);
  return found;
}

/** Every theorem and lemma in the project's own Lean files. */
export function projectTheorems(cwd: string): { file: string; declaration: Declaration }[] {
  const root = projectRoot(cwd);
  return leanFiles(root).flatMap(file => {
    try {
      return declarations(readFileSync(file, 'utf8')).filter(isTheorem).map(declaration => ({ file, declaration }));
    } catch { return []; }
  });
}

/** Takes `--name value` flags out of the input. */
function extractFlags(input: string): { rest: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  const rest = input.replace(/(^|\s)--([a-z][\w-]*)(?:[ =]([^\s-][^\s]*))?/g, (_m, lead: string, key: string, value?: string) => {
    flags[key] = value ?? 'true';
    return lead;
  });
  return { rest: rest.replace(/\s+/g, ' ').trim(), flags };
}

export function resolveTarget(input: string, cwd: string): Parsed {
  const { rest, flags } = extractFlags(input);
  const tokens = splitArgs(rest);
  const first = tokens[0];

  // 1. A file. A .lean file is a target; any other readable file is source text to formalize.
  if (first) {
    const path = resolve(cwd, first);
    if (existsSync(path) && statSync(path).isFile()) {
      if (extname(path) === '.lean') return { target: { kind: 'file', file: path, ...(tokens[1] ? { theorem: tokens[1] } : {}) }, flags, text: rest };
      return { target: { kind: 'text', text: tokens.slice(1).join(' '), file: path }, flags, text: rest };
    }
  }

  const theorems = projectTheorems(cwd);
  // 2. An exact theorem name, in full or by its last component.
  if (tokens.length === 1) {
    const named = new Set(matchingDeclarations(theorems.map(entry => entry.declaration), first!));
    const exact = theorems.filter(entry => named.has(entry.declaration));
    if (exact.length === 1) return { target: { kind: 'theorem', file: exact[0]!.file, theorem: exact[0]!.declaration.name }, flags, text: rest };
    if (exact.length > 1) return { target: { kind: 'matches', matches: exact.map(entry => toMatch(entry, 1)) }, flags, text: rest };
  }

  // 3. A close match: the input's words against each theorem's name, file name and docstring.
  const wanted = words(rest);
  const { matchThreshold, matchBand, docstringWeight, maxMatches } = settings();
  if (wanted.length) {
    const scored = theorems.map(entry => {
      const name = new Set([...words(entry.declaration.name), ...words(relative(projectRoot(cwd), entry.file).replace(/\.lean$/, ''))]);
      const doc = new Set(words(entry.declaration.docstring ?? ''));
      // A name hit counts fully, a docstring hit less: the name is what the user is likely to remember.
      const score = wanted.reduce((sum, word) => sum + (name.has(word) ? 1 : doc.has(word) ? docstringWeight : 0), 0) / wanted.length;
      return toMatch(entry, score);
    }).filter(match => match.score >= matchThreshold).sort((a, b) => b.score - a.score);
    if (scored.length) {
      const best = scored.filter(match => match.score >= scored[0]!.score - matchBand);
      return { target: best.length === 1 ? { kind: 'theorem', file: best[0]!.file, theorem: best[0]!.theorem } : { kind: 'matches', matches: best.slice(0, maxMatches) }, flags, text: rest };
    }
  }

  // 4. Free text.
  return { target: { kind: 'text', text: rest }, flags, text: rest };
}

const toMatch = (entry: { file: string; declaration: Declaration }, score: number): Match => ({
  file: entry.file, theorem: entry.declaration.name, score, header: entry.declaration.header,
});
