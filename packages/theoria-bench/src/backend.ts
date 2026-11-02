/** Execution and measurement API for supervisors. Importing it does not register /benchmark. */
export { executionHash, prepareCompressionInputs } from './compression-inputs.ts';
export { runCompressionBenchmark } from './compression-runner.ts';
export { createBenchmarkRun, type Plan, type RunnerEvents } from './runner.ts';
export { findBenchmark } from './registry.ts';
export { splitsFor } from './splits.ts';
export { aggregate, benchRunDir, trialDir, readBenchRun, saveTrial, trials, writeBenchRun } from './store.ts';
export { StatusReader } from './live-status.ts';
export { buildRevisionEvidence, type EvidenceScope, type EvidenceSource } from './revision-evidence.ts';
export type { CompressionInputs, CorpusManifest } from './compression-types.ts';
export type { BenchmarkRun, BenchmarkRunConfig } from './types.ts';
