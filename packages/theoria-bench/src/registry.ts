import { formalqualbench } from './benchmarks/formalqualbench.ts';
import { putnambench } from './benchmarks/putnambench.ts';
import { putnam2025 } from './benchmarks/putnam2025.ts';
import { putnambench30 } from './benchmarks/putnambench30.ts';
import { minif2f } from './benchmarks/minif2f.ts';
import { smoke } from './benchmarks/smoke.ts';
import type { Benchmark } from './types.ts';

/** The benchmarks Theoria knows. A new one is a module implementing `Benchmark`, added here. */
export const benchmarks: Benchmark[] = [smoke, minif2f, putnambench, putnam2025, putnambench30, formalqualbench];
export const findBenchmark = (id: string) => benchmarks.find(benchmark => benchmark.id === id.toLowerCase());
