/**
 * Just enough Lean source parsing for Theoria's checks: where each declaration starts and ends, a theorem's
 * statement, and how long a proof is. Comments and strings are blanked first so a `theorem` inside one is not read as
 * a declaration. This reads text; Lean remains the authority on what the text means.
 */
import { config } from '@theoria/shared/config';

export interface Declaration {
  kind: string;
  /** Fully qualified name, including enclosing namespaces (sections do not add name components). */
  name: string;
  /** Offsets into the source, from the first docstring or attribute line to the start of the next declaration. */
  start: number;
  end: number;
  /** The header up to the top-level `:=`, whitespace-normalized: for a theorem, its statement. */
  header: string;
  /** Offset where the header ends and the proof (`:= …`) begins. */
  bodyAt: number;
  /** Text of the whole declaration, with its docstring. */
  text: string;
  docstring?: string;
}

const kinds = ['theorem', 'lemma', 'def', 'abbrev', 'instance', 'structure', 'inductive', 'class', 'axiom', 'opaque',
  'example', 'noncomputable def', 'notation', 'macro', 'syntax'];

/** Replaces comments and string/character literals with spaces, keeping every offset where it was. */
export function blank(source: string): string {
  const out = source.split('');
  let index = 0;
  const fill = (from: number, to: number) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  while (index < source.length) {
    if (source[index] === '«') {
      const end = source.indexOf('»', index + 1);
      index = end === -1 ? source.length : end + 1;
    } else if (source.startsWith('--', index)) {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      fill(index, stop); index = stop;
    } else if (source.startsWith('/-', index)) {
      let depth = 1; let k = index + 2;
      while (k < source.length && depth > 0) {
        if (source.startsWith('/-', k)) { depth += 1; k += 2; } else if (source.startsWith('-/', k)) { depth -= 1; k += 2; } else k += 1;
      }
      fill(index, k); index = k;
    } else if (source[index] === '"') {
      let k = index + 1;
      while (k < source.length && source[k] !== '"') k += source[k] === '\\' ? 2 : 1;
      fill(index, k + 1); index = k + 1;
    } else if (source[index] === "'" && !/[\p{L}\p{N}_'!?»]/u.test(source[index - 1] ?? '')) {
      const char = /^'(?:\\(?:u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)|[^'\\\r\n])'/u.exec(source.slice(index));
      if (char) { fill(index, index + char[0].length); index += char[0].length; }
      else index += 1;
    } else index += 1;
  }
  return out.join('');
}

const headPattern = new RegExp(
  String.raw`^[ \t]*(?:@\[[^\]\n]*\][ \t\n]*)?(?:(?:private|protected|noncomputable|unsafe|partial|nonrec)[ \t]+)*`
  + String.raw`(${kinds.map(kind => kind.replace(' ', String.raw`[ \t]+`)).join('|')})\b[ \t]*((?:«[^»]*»|[^\s(:{\[⦃«])*)`,
  'gm',
);

export function declarations(source: string): Declaration[] {
  const masked = blank(source);
  type Event = { type: 'declaration'; kind: string; name: string; at: number } | { type: 'scope'; kind: string; name: string; at: number };
  const events: Event[] = [];
  for (const match of masked.matchAll(headPattern)) {
    events.push({ type: 'declaration', kind: match[1]!.replace(/\s+/g, ' '), name: match[2] ?? '', at: match.index! });
  }
  const scopePattern = /^[ \t]*(?:noncomputable[ \t]+)?(namespace|section|mutual|end)\b[ \t]*([^\n]*?)[ \t]*$/gm;
  for (const match of masked.matchAll(scopePattern)) events.push({ type: 'scope', kind: match[1]!, name: match[2]!.trim(), at: match.index! });
  events.sort((a, b) => a.at - b.at);
  const scopes: string[] = [];
  const boundaries: number[] = [];
  const found: { kind: string; name: string; at: number }[] = [];
  let cursor = 0;
  let depth = 0;
  let quoted = false;
  const qualify = (namespace: string, name: string) => name.startsWith('_root_.') ? name.slice(7) : namespace && name ? `${namespace}.${name}` : name;
  for (const event of events) {
    // Commands in syntax quotations or bracketed terms are not declarations/scopes of this file.
    while (cursor < event.at) {
      const char = masked[cursor++]!;
      if (char === '«') quoted = true;
      else if (char === '»') quoted = false;
      else if (!quoted && '([{⦃⟨'.includes(char)) depth += 1;
      else if (!quoted && ')]}⦄⟩'.includes(char)) depth -= 1;
    }
    if (depth !== 0 || quoted) continue;
    const namespace = scopes.at(-1) ?? '';
    if (event.type === 'scope') {
      boundaries.push(event.at);
      if (event.kind === 'end') scopes.pop();
      else scopes.push(event.kind === 'namespace' ? qualify(namespace, event.name) : namespace);
    } else found.push({ ...event, name: qualify(namespace, event.name) });
  }
  return found.map((entry, index) => {
    // A closing/opening namespace or section belongs to the file, not the preceding proof/definition.
    const next = Math.min(found[index + 1]?.at ?? source.length, boundaries.find(at => at > entry.at) ?? source.length);
    // A docstring or attribute directly above belongs to this declaration.
    let start = entry.at;
    const before = source.slice(0, entry.at);
    const last = before.lastIndexOf('/--');
    const tail = last >= 0 ? before.slice(last) : '';
    const doc = tail && /-\/\s*$/.test(tail) && tail.split('-/').length === 2 ? { index: last, 0: tail } : undefined;
    if (doc) start = doc.index;
    const header = headerOf(masked.slice(entry.at, next));
    return {
      kind: entry.kind, name: entry.name, start, end: next, bodyAt: entry.at + header.length,
      header: header.replace(/\s+/g, ' ').trim(),
      text: source.slice(start, next),
      ...(doc ? { docstring: doc[0].replace(/^\/--\s*|\s*-\/\s*$/g, '').trim() } : {}),
    };
  }).map((declaration, index, all) => {
    // The docstring of the next declaration is not part of this one.
    const following = all[index + 1];
    if (following && following.start < declaration.end) {
      return { ...declaration, end: following.start, text: source.slice(declaration.start, following.start) };
    }
    return declaration;
  });
}

/** Exact full names take precedence; a short/relative name is usable only after callers resolve any ambiguity. */
export function matchingDeclarations(found: Declaration[], name: string): Declaration[] {
  const absolute = name.startsWith('_root_.');
  const wanted = absolute ? name.slice(7) : name;
  const exact = found.filter(declaration => declaration.name === wanted);
  return exact.length || absolute ? exact : found.filter(declaration => declaration.name.endsWith(`.${wanted}`));
}

/** Text up to the first `:=` (or `where`, `|`) at bracket depth zero. */
function headerOf(text: string): string {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === '«') { quoted = true; continue; }
    if (char === '»') { quoted = false; continue; }
    if (quoted) continue;
    if ('([{⦃⟨'.includes(char)) depth += 1;
    else if (')]}⦄⟩'.includes(char)) depth -= 1;
    else if (depth === 0 && text.startsWith(':=', index)) return text.slice(0, index);
    else if (depth === 0 && /^\s(where|\|)\s/.test(text.slice(index, index + 7))) return text.slice(0, index);
  }
  return text;
}

export const isTheorem = (declaration: Declaration) => declaration.kind === 'theorem' || declaration.kind === 'lemma';

/** Whether a declaration's own text writes `sorry` or `admit` (outside comments). */
export function writesSorry(declaration: Declaration): boolean {
  return /\b(sorry|admit)\b/.test(blank(declaration.text));
}

/** Non-blank lines outside comments, without `import`, `open`, `set_option` and section bookkeeping. */
export function significantLines(source: string): number {
  return blank(source).split('\n')
    .map(line => line.trim())
    .filter(line => line && !/^(import|open|set_option|namespace|end|section|variable|universe)\b/.test(line))
    .length;
}

const stopWords = () => new Set(config().workflows.naming.stopWords);
const plain = (text: string) => text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/'s\b/g, '');

/**
 * `Legendre's conjecture!` → `{ file: "LegendreConjecture", theorem: "legendre_conjecture" }`: the first
 * `workflows.naming.maxWords` words of a description, without its stop words.
 */
export function namesFor(text: string): { file: string; theorem: string } {
  const { maxWords, fallbackName } = config().workflows.naming;
  const stop = stopWords();
  const kept = plain(text).split(/[^A-Za-z0-9]+/).filter(word => word && !stop.has(word.toLowerCase())).slice(0, maxWords);
  const safe = kept.length ? kept : [fallbackName];
  const file = safe.map(word => word[0]!.toUpperCase() + word.slice(1)).join('');
  const theorem = safe.map(word => word.toLowerCase()).join('_');
  // A Lean identifier cannot start with a digit.
  return { file: /^\d/.test(file) ? `T${file}` : file, theorem: /^\d/.test(theorem) ? `t_${theorem}` : theorem };
}

/** Words of a name or phrase for matching: splits camelCase, snake_case and dots, and drops stop words. */
export function words(text: string): string[] {
  const stop = stopWords();
  return plain(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1 && !stop.has(word));
}

/** A theorem's statement, as written, without its docstring or proof. */
export function statementText(declaration: Declaration): string {
  return declaration.text.slice(0, declaration.bodyAt - declaration.start).replace(/^\/--[\s\S]*?-\/\s*/, '').trim();
}

export const firstLine = (text?: string) => text?.split('\n').map(line => line.trim()).find(Boolean);
