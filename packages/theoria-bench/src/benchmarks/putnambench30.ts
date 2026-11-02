import type { Benchmark } from '../types.ts';
import { putnambench } from './putnambench.ts';
import { putnambench30Splits } from './putnambench30-tasks.ts';

/** A fixed sample, with disjoint train/test labels shared with the full parent suite. */
export const putnambench30: Benchmark = {
  id: 'putnambench-30',
  title: 'PutnamBench-30',
  description: '30 fixed PutnamBench problems excluding 2025: 15 train, 0 val, 15 test; shared parent statements, splits and Lean environment',
  get version() { return putnambench.version; },
  installed: () => putnambench.installed(),
  install: onLine => putnambench.install(onLine),
  lean: () => putnambench.lean(),
  splitSource: putnambench,
  listTasks() {
    const parent = new Map(putnambench.listTasks().map(task => [task.id, task]));
    return Object.keys(putnambench30Splits).sort().map(id => {
      const task = parent.get(id);
      if (!task) throw new Error(`The pinned PutnamBench source is missing PutnamBench-30 task ${id}.`);
      return task;
    });
  },
};
