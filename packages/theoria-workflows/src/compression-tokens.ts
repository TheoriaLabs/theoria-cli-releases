import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { blank, declarations, isTheorem } from './lean-source.ts';

export type ProofTokenizer = 'cl100k_base' | 'o200k_base';
const encodings = new Map<ProofTokenizer, Tiktoken>();

/** Remove comments, preserving strings, character literals and quoted identifiers verbatim. */
export function stripProofComments(source: string): string {
  let out = '';
  for (let i = 0; i < source.length;) {
    if (source[i] === '"' || source[i] === '«') {
      const end = source[i] === '«' ? '»' : '"';
      out += source[i++];
      while (i < source.length) {
        const char = source[i++]!; out += char;
        if (char === '\\' && end === '"' && i < source.length) out += source[i++];
        else if (char === end) break;
      }
    } else if (source[i] === "'" && !/[\p{L}\p{N}_'!?»]/u.test(source[i - 1] ?? '')) {
      const char = /^'(?:\\(?:u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|.)|[^'\\\r\n])'/u.exec(source.slice(i));
      if (char) { out += char[0]; i += char[0].length; }
      else out += source[i++];
    } else if (source.startsWith('--', i)) {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (source.startsWith('/-', i)) {
      let depth = 1; i += 2;
      while (i < source.length && depth) {
        if (source.startsWith('/-', i)) { depth += 1; i += 2; }
        else if (source.startsWith('-/', i)) { depth -= 1; i += 2; }
        else i += 1;
      }
      out += ' ';
    } else out += source[i++];
  }
  return out.split('\n').map(line => line.trimEnd()).filter(line => line.trim()).join('\n').trim();
}

/** Count each proof independently; statements/imports never dilute the reduction denominator.
 * New or rewritten non-proof helpers count in full so moving proof work into a definition is not free.
 */
export function proofTokens(source: string, tokenizer: ProofTokenizer, original = source): number {
  let encoding = encodings.get(tokenizer);
  if (!encoding) { encoding = getEncoding(tokenizer); encodings.set(tokenizer, encoding); }
  const originalDefinitions = new Map(declarations(original).map(entry => [entry.name, stripProofComments(entry.text)]));
  return declarations(source).reduce((total, entry) => {
    let body: string;
    if (isTheorem(entry) || entry.kind === 'example') {
      if (!blank(source.slice(entry.bodyAt, entry.bodyAt + 2)).startsWith(':=')) throw new Error(`Token measurement requires a := proof body for ${entry.name || 'example'}.`);
      body = source.slice(entry.bodyAt + 2, entry.end);
    } else if (originalDefinitions.get(entry.name) !== stripProofComments(entry.text)) body = entry.text;
    else return total;
    return total + encoding.encode(stripProofComments(body), [], []).length;
  }, 0);
}
