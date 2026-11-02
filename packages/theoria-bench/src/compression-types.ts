import type { CompressionMeasurement, CompressionPolicy, CompressionSkill, WorkflowPrompt } from '@theoria/pi-workflows/api';
import type { BenchmarkTask, LeanSpec } from './types.ts';

export interface CorpusManifest {
  schemaVersion: 1;
  benchmarkId: string;
  tasks: Record<string, { file: string; theorem?: string }>;
  /** Optional exact environment for ported proof corpora; never inferred from the active session. */
  lean?: LeanSpec;
}
export interface CompressionRequest { corpus: string; skill?: string; rounds: number; promptAppend?: string; skipVerification?: boolean }
export interface CompressionInputs {
  schemaVersion: 1;
  benchmarkId: string;
  benchmarkVersion: string;
  codeHash: string;
  lean: LeanSpec;
  policy: CompressionPolicy;
  prompt: WorkflowPrompt;
  /** Literal guidance appended after rendering each round/repair prompt. */
  promptAppend?: string;
  /** Binds the run's reference files to its compression checkpoint identity. */
  contextHash?: string;
  skipVerification?: boolean;
  skill: CompressionSkill;
  rounds: number;
  tasks: { task: BenchmarkTask; source: string; sha256: string; theorem?: string }[];
}
export interface CompressionResult {
  improved: boolean;
  verified: boolean;
  compress_score: number;
  baseline?: CompressionMeasurement;
  best?: CompressionMeasurement;
  report?: string;
  reason: string;
}
