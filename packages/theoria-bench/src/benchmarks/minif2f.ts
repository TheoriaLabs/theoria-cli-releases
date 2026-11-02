import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@theoria/shared/config';
import { blank, declarations } from '@theoria/pi-workflows/api';
import { sourceDir } from '../paths.ts';
import type { Benchmark, BenchmarkTask, LeanSpec } from '../types.ts';
import { cloneAt, sourceAt } from './git.ts';

/**
 * DeepMind's corrected Lean 4 miniF2F (Apache 2.0): the 244 primary problems in each published split. The twelve
 * extra `.variants.` declarations in Valid.lean are not additional primary tasks. Each trial gets one theorem,
 * never the other benchmarks' sorry declarations. Formal Conjectures' small utility imports are pinned by the
 * upstream manifest and copied unchanged; the complete dependency's benchmark statements are not imported.
 */
const settings = () => config().benchmarks.minif2f;
const dir = () => sourceDir('minif2f');
const supportDir = () => join(dir(), '.theoria-deps', 'formal_conjectures');
const utilities = [
  'FormalConjectures.Util.Answer.Syntax',
  'FormalConjectures.Util.Answer',
  'FormalConjecturesForMathlib.Analysis.SpecialFunctions.NthRoot',
] as const;

interface PackagePin { name: string; url?: string; rev: string; inputRev?: string; inherited?: boolean }
function manifest() {
  const parsed = JSON.parse(readFileSync(join(dir(), 'lake-manifest.json'), 'utf8')) as { packages: PackagePin[]; [key: string]: unknown };
  const mathlib = parsed.packages.find(pkg => pkg.name === 'mathlib');
  const support = parsed.packages.find(pkg => pkg.name === 'formal_conjectures');
  if (!mathlib || !support?.url || !/^[a-f0-9]{40}$/.test(support.rev)) throw new Error('miniF2F must pin Mathlib and the Formal Conjectures utilities.');
  return { parsed, mathlib, support: { ...support, url: support.url } };
}

/** Preserve complete statement text, including `let … := …`; erase upstream tactic/rfl proof bodies. */
export function miniF2fTasks(source: string, split: 'val' | 'test'): BenchmarkTask[] {
  const all = declarations(source);
  if (!all.length || all.some(declaration => declaration.kind !== 'theorem')) throw new Error('Unexpected miniF2F source layout: expected a flat file of theorem declarations.');
  const preamble = source.slice(0, all[0]!.start);
  return all.filter(declaration => !declaration.name.includes('.variants.')).map(declaration => {
    const proofs = [...blank(declaration.text).matchAll(/:=\s*(?:by|sorry|rfl)\b/g)];
    if (proofs.length !== 1) throw new Error(`Could not uniquely isolate the miniF2F proof body for ${declaration.name}.`);
    return {
      id: declaration.name, title: declaration.name, split,
      challenge: `${preamble}${declaration.text.slice(0, proofs[0]!.index).trimEnd()} := by\n  sorry\n`,
      theorems: [declaration.name], ...(declaration.docstring ? { informal: declaration.docstring } : {}),
    };
  });
}

export const minif2f: Benchmark = {
  id: 'minif2f',
  title: 'miniF2F (DeepMind Lean 4)',
  description: '488 primary Olympiad-style problems in the corrected DeepMind formalization; official val/test splits (244 each), no train split',
  get version() { return settings().commit.slice(0, 12); },
  installed() {
    if (!sourceAt(dir(), settings().commit)) return false;
    try { return sourceAt(supportDir(), manifest().support.rev); } catch { return false; }
  },
  async install(onLine) {
    await cloneAt(settings().repo, settings().commit, dir(), onLine);
    const { support } = manifest();
    await cloneAt(support.url, support.rev, supportDir(), onLine);
  },
  lean(): LeanSpec {
    const { parsed, mathlib } = manifest();
    const lakefile = readFileSync(join(dir(), 'lakefile.lean'), 'utf8');
    const leanOptions = Object.fromEntries([...lakefile.matchAll(/⟨`(\w+(?:\.\w+)*),\s*(true|false|\d+)⟩/g)].map(match => [match[1]!, match[2] === 'true' ? true : match[2] === 'false' ? false : Number(match[2])]));
    return {
      toolchain: readFileSync(join(dir(), 'lean-toolchain'), 'utf8').trim(), mathlibRev: mathlib.rev,
      ...(mathlib.inputRev ? { mathlibTag: mathlib.inputRev } : {}), leanOptions,
      // These utility modules are local library sources below, rather than an extra fetched Lake dependency.
      manifest: JSON.stringify({ ...parsed, packages: parsed.packages.filter(pkg => pkg.name !== 'formal_conjectures').map(pkg => ({ ...pkg, inherited: pkg.name !== 'mathlib' })) }),
      supportModules: [
        { name: 'MiniF2F.ProblemImports', source: readFileSync(join(dir(), 'MiniF2F', 'ProblemImports.lean'), 'utf8') },
        ...utilities.map(name => ({ name, source: readFileSync(join(supportDir(), `${name.replaceAll('.', '/')}.lean`), 'utf8') })),
      ],
    };
  },
  listTasks() {
    const tasks = (['val', 'test'] as const).flatMap(split => {
      const parsed = miniF2fTasks(readFileSync(join(dir(), 'MiniF2F', split === 'val' ? 'Valid.lean' : 'Test.lean'), 'utf8'), split);
      if (parsed.length !== 244) throw new Error(`Expected 244 primary miniF2F ${split} tasks, found ${parsed.length}.`);
      return parsed;
    });
    if (new Set(tasks.map(task => task.id)).size !== tasks.length) throw new Error('miniF2F has duplicate primary task names across splits.');
    return tasks.sort((a, b) => a.id.localeCompare(b.id));
  },
};
