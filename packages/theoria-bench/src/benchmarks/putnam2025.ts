import type { Benchmark } from '../types.ts';
import { putnambench } from './putnambench.ts';

/** The twelve 2025 competition problems from the same pinned, answer-inlined PutnamBench source. */
export const putnam2025: Benchmark = {
  id: 'putnam2025',
  title: 'Putnam 2025 (Lean 4)',
  description: 'The 12 Putnam 2025 problems: 6 train (A1–A6), 6 test (B1–B6), no val; PutnamBench statements, answer inlining and shared split labels',
  get version() { return putnambench.version; },
  installed: () => putnambench.installed(),
  install: onLine => putnambench.install(onLine),
  lean: () => putnambench.lean(),
  splitSource: putnambench,
  listTasks() {
    const tasks = putnambench.listTasks().filter(task => /^putnam_2025_[ab][1-6]$/.test(task.id));
    if (tasks.length !== 12) throw new Error(`The pinned PutnamBench source contains ${tasks.length}, not 12, Putnam 2025 tasks.`);
    return tasks;
  },
};
