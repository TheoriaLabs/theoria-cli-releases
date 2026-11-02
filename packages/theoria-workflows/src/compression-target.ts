import { config } from '@theoria/shared/config';
import { splitArgs } from './prompt.ts';
import { resolveTarget, type Parsed } from './target.ts';
import { compressionSkillArgs } from './compress-skill.ts';

/** The optional trailing integer belongs to compression, not shared /prove target resolution. */
export function compressionTarget(parsed: Parsed, cwd: string): { parsed: Parsed; rounds: number; skill?: string; skipVerification?: boolean } {
  const { args: tokens, skill } = compressionSkillArgs(splitArgs(parsed.text));
  let skip = parsed.flags['skip-verification'];
  for (let index = tokens.length - 1; index >= 0; index--) {
    if (!tokens[index]!.startsWith('skip-verification=')) continue;
    if (skip !== undefined) throw new Error('Specify skip-verification only once.');
    skip = tokens.splice(index, 1)[0]!.slice('skip-verification='.length);
  }
  if (skip !== undefined && !['true', 'false'].includes(skip)) throw new Error('skip-verification must be true or false.');
  const options = { ...(skill !== undefined ? { skill } : {}), ...(skip !== undefined ? { skipVerification: skip === 'true' } : {}) };
  const targetText = () => tokens.map(token => /\s/.test(token) ? `"${token}"` : token).join(' ');
  if (skill !== undefined || skip !== undefined) parsed = { ...resolveTarget(targetText(), cwd), flags: parsed.flags };
  let rounds = config().workflows.compression.rounds;
  const last = tokens.at(-1);
  const file = parsed.target.kind === 'file';
  const hasRound = tokens.length > 1 && (file && tokens.length >= 3 || /^[+\-]?(?:\d|\.\d|Infinity|NaN)/.test(last ?? ''));
  if (hasRound) {
    if (!last || !/^\d+$/.test(last) || !Number.isSafeInteger(Number(last)) || Number(last) < 1) throw new Error('Compression rounds must be a positive integer, for example: /compress Solution.lean 5 or /compress Solution.lean Namespace.myLemma 5.');
    rounds = Number(tokens.pop());
  }
  if (file && tokens.length > 2) throw new Error('Usage: /compress <file> [declaration] [rounds] [skill=<path>|none] [skip-verification=true] [--emphasis loc|clarity|balanced].');
  if (!hasRound) return { parsed, rounds, ...options };
  return { parsed: { ...resolveTarget(targetText(), cwd), flags: parsed.flags }, rounds, ...options };
}
