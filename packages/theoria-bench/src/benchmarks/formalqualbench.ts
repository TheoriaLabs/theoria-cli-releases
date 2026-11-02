import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@theoria/shared/config';
import { sourceDir } from '../paths.ts';
import type { Benchmark, BenchmarkTask, LeanSpec } from '../types.ts';
import { cloneAt, sourceAt } from './git.ts';

/**
 * FormalQualBench (math-inc/FormalQualBench, Apache 2.0): 23 graduate qualifying-exam theorems, each a Lean statement
 * an expert checked, to be proved from scratch with any definitions and lemmas the agent builds (specification-based:
 * Comparator accepts any proof of the same statement). Hard: the best agent in Math Inc's evaluation solved 8 of 23
 * with a 4-hour limit per problem.
 */

const settings = () => config().benchmarks.formalqualbench;
const dir = () => sourceDir('formalqualbench');

/** `[leanOptions]` of a lakefile.toml: `key = value` lines, values true, false, numbers or strings. */
export function tomlLeanOptions(text: string): Record<string, string | number | boolean> {
  const section = /\[leanOptions\]\n([\s\S]*?)(\n\[|$)/.exec(text)?.[1] ?? '';
  return Object.fromEntries(section.split('\n').map(line => line.replace(/#.*$/, '').trim()).filter(Boolean).flatMap(line => {
    const match = /^([\w.]+)\s*=\s*(.+)$/.exec(line);
    if (!match) return [];
    const raw = match[2]!.trim();
    const value = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? Number(raw) : raw.replace(/^"|"$/g, '');
    return [[match[1]!, value]];
  }));
}

export const formalqualbench: Benchmark = {
  id: 'formalqualbench',
  title: 'FormalQualBench',
  description: '23 graduate-level theorems (qualifying-exam style) to formalize and prove from scratch in Lean 4 with Mathlib',
  get version() { return settings().commit.slice(0, 12); },
  get timeoutMinutes() { return settings().timeoutMinutes; },
  reference: 'Math Inc (March 2026, Comparator-checked, 4 h per problem): OpenGauss 8/23, Claude Code 4–5/23, Codex 3–5/23, opencode 5/23; 15 problems solved by none.',
  installed: () => sourceAt(dir(), settings().commit),
  install: onLine => cloneAt(settings().repo, settings().commit, dir(), onLine),
  lean(): LeanSpec {
    const manifest = readFileSync(join(dir(), 'lake-manifest.json'), 'utf8');
    const mathlib = (JSON.parse(manifest) as { packages: { name: string; rev: string; inputRev?: string }[] }).packages.find(entry => entry.name === 'mathlib');
    return {
      toolchain: readFileSync(join(dir(), 'lean-toolchain'), 'utf8').trim(),
      ...(mathlib ? { mathlibRev: mathlib.rev, ...(mathlib.inputRev ? { mathlibTag: mathlib.inputRev } : {}) } : {}),
      leanOptions: tomlLeanOptions(readFileSync(join(dir(), 'lakefile.toml'), 'utf8')), manifest,
    };
  },
  listTasks(): BenchmarkTask[] {
    const root = join(dir(), 'FormalQualBench');
    return readdirSync(root).filter(name => existsSync(join(root, name, 'Main.lean'))).sort().map(name => {
      const challenge = readFileSync(join(root, name, 'Main.lean'), 'utf8');
      const namespace = /^namespace\s+(\S+)/m.exec(challenge)?.[1];
      const informal = /\/--\s*([\s\S]*?)-\/\s*theorem MainTheorem/.exec(challenge)?.[1]?.trim();
      return { id: name, title: name, challenge, theorems: [namespace ? `${namespace}.MainTheorem` : 'MainTheorem'], ...(informal ? { informal } : {}) };
    });
  },
};
