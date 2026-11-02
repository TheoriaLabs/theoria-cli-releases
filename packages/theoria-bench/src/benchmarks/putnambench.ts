import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@theoria/shared/config';
import { sourceDir } from '../paths.ts';
import type { Benchmark, BenchmarkTask, LeanSpec } from '../types.ts';
import { cloneAt, sourceAt } from './git.ts';
import { putnambench30Splits } from './putnambench30-tasks.ts';

/**
 * PutnamBench (trishullab/PutnamBench, Apache 2.0), its Lean 4 problems: Putnam competition problems from 1962 on.
 * The task is the variant with each problem's answer written into the statement (the benchmark's own
 * scripts/rewrite_solutions.py, ported here), so the agent proves the stated theorem. The maintainers ask that proofs
 * are not published: trial outputs stay in the project's gitignored .theoria/benchmarks.
 */

const settings = () => config().benchmarks.putnambench;
const dir = () => sourceDir('putnambench');
const lean4 = () => join(dir(), 'lean4');

/** The answer-inlined version of a problem file: each `abbrev X_solution : T := sorry` with `-- answer` below it. */
export function inlineSolutions(source: string): string {
  // Lines with their endings, as Python's readlines gives them.
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const solutions = new Map<string, { solution: string; type: string }>();
  lines.forEach((line, index) => {
    if (!line.includes('abbrev')) return;
    const words = line.split(' ');
    const name = words[words.indexOf('abbrev') + 1]?.trim();
    const answer = lines[index + 1]?.split('--')[1]?.trim();
    const type = /.*?:\s*(.*)\s*:=\s*sorry\n/.exec(line)?.[1];
    if (!name || answer === undefined || type === undefined) throw new Error(`Could not read the solution in: ${line.trim()}`);
    solutions.set(name, { solution: answer.replace(/\n/g, ''), type });
  });
  let out = '';
  for (let line of lines) {
    for (const [name, { solution, type }] of solutions) {
      if (line.includes(name) && !line.includes('abbrev')) {
        const bare = solution.startsWith('(') && solution.endsWith(')') ? solution.slice(1, -1) : solution;
        line = line.split(name).join(`((${bare}) : ${type})`);
      }
    }
    if (line.includes('abbrev')) continue;
    out += line;
  }
  return out;
}

export const putnambench: Benchmark = {
  id: 'putnambench',
  title: 'PutnamBench (Lean 4)',
  description: 'Putnam competition problems formalized in Lean 4 with Mathlib; answers written into the statements',
  get version() { return settings().commit.slice(0, 12); },
  installed: () => sourceAt(dir(), settings().commit),
  install: onLine => cloneAt(settings().repo, settings().commit, dir(), onLine),
  lean(): LeanSpec {
    const manifest = readFileSync(join(lean4(), 'lake-manifest.json'), 'utf8');
    const mathlib = (JSON.parse(manifest) as { packages: { name: string; rev: string; inputRev?: string }[] }).packages.find(entry => entry.name === 'mathlib');
    const lakefile = readFileSync(join(lean4(), 'lakefile.lean'), 'utf8');
    const options = Object.fromEntries([...lakefile.matchAll(/⟨`(\w+(?:\.\w+)*),\s*(true|false|\d+)⟩/g)].map(match => [match[1]!, match[2] === 'true' ? true : match[2] === 'false' ? false : Number(match[2])]));
    return {
      toolchain: readFileSync(join(lean4(), 'lean-toolchain'), 'utf8').trim(),
      ...(mathlib ? { mathlibRev: mathlib.rev, ...(mathlib.inputRev ? { mathlibTag: mathlib.inputRev } : {}) } : {}),
      leanOptions: options, manifest,
    };
  },
  listTasks(): BenchmarkTask[] {
    const src = join(lean4(), 'src');
    return readdirSync(src).filter(name => name.endsWith('.lean')).sort().map(name => {
      const id = name.replace(/\.lean$/, '');
      const original = readFileSync(join(src, name), 'utf8');
      const informal = /\/--\s*([\s\S]*?)-\//.exec(original)?.[1]?.trim();
      // Fixed subset labels belong to the parent too, so overlapping views always agree.
      const part2025 = /^putnam_2025_([ab])[1-6]$/.exec(id)?.[1];
      const split = putnambench30Splits[id] ?? (part2025 === 'a' ? 'train' : part2025 === 'b' ? 'test' : undefined);
      return { id, title: id, challenge: inlineSolutions(original), theorems: [id], ...(informal ? { informal } : {}), ...(split ? { split } : {}) };
    });
  },
};
