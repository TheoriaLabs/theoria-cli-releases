import { config } from '@theoria/shared/config';
import type { Benchmark, BenchmarkTask } from '../types.ts';

/**
 * A small suite in core Lean, no Mathlib: cheap tasks that exercise the whole path (trial session, sandbox,
 * Comparator) in a few minutes. Part of Theoria, so its version is Theoria's.
 */
const tasks: { id: string; statement: string }[] = [
  { id: 'add_zero', statement: 'theorem smoke_add_zero (n : Nat) : n + 0 = n' },
  { id: 'add_comm', statement: 'theorem smoke_add_comm (a b : Nat) : a + b = b + a' },
  { id: 'reverse_reverse', statement: 'theorem smoke_reverse_reverse (xs : List Nat) : xs.reverse.reverse = xs' },
  { id: 'two_pow_ten', statement: 'theorem smoke_two_pow_ten : 2 ^ 10 = 1024' },
  { id: 'exists_gt', statement: 'theorem smoke_exists_gt (n : Nat) : ∃ m, n < m' },
  { id: 'length_append', statement: 'theorem smoke_length_append (xs ys : List Nat) : (xs ++ ys).length = xs.length + ys.length' },
];

export const smoke: Benchmark = {
  id: 'smoke',
  title: 'Smoke (core Lean)',
  description: `${tasks.length} small theorems in core Lean, to check the harness end to end`,
  version: 'theoria-1',
  installed: () => true,
  install: async () => {},
  lean: () => ({ toolchain: config().benchmarks.smoke.toolchain, leanOptions: {} }),
  listTasks: (): BenchmarkTask[] => tasks.map(task => ({
    id: task.id, title: task.id, challenge: `${task.statement} := by\n  sorry\n`,
    theorems: [task.statement.split(' ')[1]!],
  })),
};
