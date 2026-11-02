/**
 * The benchmark model. A benchmark defines only its tasks, how to prepare them and the Lean they need; agents,
 * prompts and persistence belong to Theoria, and evaluation is Comparator's for every benchmark.
 */

/** The Lean a benchmark's tasks need, pinned exactly. */
export interface LeanSpec {
  /** e.g. `leanprover/lean4:v4.33.1` */
  toolchain: string;
  /** The Mathlib commit, when the tasks import Mathlib. */
  mathlibRev?: string;
  /** The Mathlib tag it is, for installing it (`/lean install`). */
  mathlibTag?: string;
  /** The benchmark's own `leanOptions`, which change what elaborates; trials and evaluation use exactly these. */
  leanOptions: Record<string, string | number | boolean>;
  /** The benchmark's lake-manifest.json, when it has one. */
  manifest?: string;
  /** Pinned benchmark utility modules, copied unchanged into both trial and fresh judge workspaces. */
  supportModules?: { name: string; source: string }[];
}

export interface BenchmarkTask {
  id: string;
  title: string;
  /** The challenge: a complete Lean file with the theorem stated and `sorry` as its proof. */
  challenge: string;
  /** Fully qualified theorem names Comparator checks. */
  theorems: string[];
  /** Definitions the solution must fill (Comparator's definition holes); none for the tasks here. */
  definitions?: string[];
  /** The informal statement, when the benchmark has one. */
  informal?: string;
  /** Dataset-defined split, published upstream or fixed by the adapter; bypasses the random split policy. */
  split?: Split;
}

export interface Benchmark {
  id: string;
  title: string;
  description: string;
  /** The pinned source version (a commit), or a version of Theoria's own suite. */
  version: string;
  /** Default trial time limit, when it differs from `benchmarks.defaults.timeoutMinutes`. */
  timeoutMinutes?: number;
  /** Published reference results, shown with the listing. */
  reference?: string;
  /** A subset reuses its parent suite's frozen splits, preventing the same task being train in one and test in the other. */
  splitSource?: Benchmark;
  /** Optional verified input corpus for proof-refactoring benchmarks. */
  compressionCorpus?: () => string;
  installed(): boolean;
  /** Fetches the pinned source (never runs anything from it). */
  install(onLine?: (line: string) => void): Promise<void>;
  lean(): LeanSpec;
  listTasks(): BenchmarkTask[];
}

export type Split = string;

export interface TrialMetrics {
  compression?: import('./compression-types.ts').CompressionResult;
  turns: number;
  /** Provider-reported cost of the trial's model calls. */
  costUsd: number;
  /** All tokens; then the split the provider reports: input (uncached), output, cache reads and writes. */
  tokens: number;
  tokensIn: number;
  tokensOut: number;
  cacheRead: number;
  cacheWrite: number;
  /** Input tokens of the first model call (uncached + cache read + cache write): what the harness puts in front of the task. */
  firstTurnInputTokens: number;
  /** Wall-clock time of the trial, from its start to Comparator's verdict. */
  durationMs: number;
  rounds: number;
  comparator?: 'passed' | 'rejected' | 'unavailable';
  reason?: string;
  stoppedBy?: 'agent' | 'timeout' | 'turns' | 'cost' | 'cancelled' | 'error';
  /** Whether the trial ran as a pi-goal-x goal (from the start, or after a failed first attempt). */
  escalated?: boolean;
  /** Cost, tokens, turns and time of each phase: the plain task, then the goal. */
  phases?: { phase: 'task' | 'goal'; costUsd: number; tokensIn: number; tokensOut: number; turns: number; durationMs: number }[];
  /** Why a trial failed: gave up (Solution.lean unchanged), incomplete (sorry left after changes), rejected (by Comparator),
   * stopped by a limit, no-plan (stopped without a valid plan where one is required), planned (a valid plan, not finished). */
  failureKind?: 'gave-up' | 'rejected' | 'incomplete' | 'limit' | 'no-plan' | 'planned';
  /** The trial's proof plan when it ended: whether it is a valid skeleton, its angles, nodes and how many Lean proved. */
  plan?: { exists: boolean; valid: boolean; angles: number; nodes: number; proved: number; total: number };
}

export interface BenchmarkTrial {
  /** Controller-owned display telemetry, separate from verification and scheduling decisions. */
  progress?: { stage: 'starting' | 'working' | 'checking' | 'judging' | 'finished'; at: string; round?: number; rounds?: number; candidate?: number };
  activity?: { text: string; at: string };
  workerPid?: number;
  reservedUsd?: number;
  attempt?: number;
  id: string;
  runId: string;
  taskId: string;
  replicate: number;
  split: Split;
  status: 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled';
  /** Infrastructure errors so far; a failed proof is not retried. */
  errors: number;
  metrics: Partial<TrialMetrics>;
  artifactIds: string[];
  feedbackIds: string[];
  /** The harness the trial's session ran: its profile and the Theoria commit it loaded when it started. */
  harness?: { profile: string; theoriaCommit?: string };
  /** Earlier attempts of this trial that ended in an infrastructure error and were run again: their spend counts too. */
  previousAttempts?: Partial<TrialMetrics>[];
  /** On the test split: not for tuning prompts. */
  sealed: boolean;
  heartbeatAt?: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
}

export interface BenchmarkRunConfig {
  mode?: 'prove' | 'compress';
  compression?: { inputHash: string; rounds: number };
  /** Literal guidance appended to the task prompt, retained across trial retries. */
  promptAppend?: string;
  /** Skip repeated original-solution verification; candidate checks remain mandatory. */
  skipVerification?: boolean;
  /** User-selected reference directory, snapshotted during planning. */
  contextDir?: string;
  /** Identity of the run's immutable reference files. */
  context?: import('./context.ts').ContextManifest;
  model: string;
  /** The harness profile trials run with (`harness.profiles`). */
  harness: string;
  /** The model's thinking level in every trial (Pi's --thinking). */
  thinking: string;
  repetitions: number;
  concurrency: number;
  /** Null means unlimited; ordinary benchmark defaults remain finite. */
  timeoutMinutes: number | null;
  maxTurns: number | null;
  maxCostUsd: number | null;
  retries: number;
  feedbackRounds: number;
  /** How often an agent that stopped without changing Solution.lean is told its remaining budget before the trial ends. */
  continueRounds: number;
}

export interface BenchmarkRun {
  progress?: { stage: 'preparing' | 'baselines' | 'trials' | 'finished'; at: string; completed: number; total: number; taskId?: string; check?: 'lean' | 'comparator' };
  problem?: string;
  runId: string;
  benchmarkId: string;
  benchmarkVersion: string;
  split: Split;
  taskIds: string[];
  config: BenchmarkRunConfig;
  trialIds: string[];
  status: 'queued' | 'running' | 'completed' | 'cancelled';
  startedFrom: 'terminal' | 'bot';
  sealed: boolean;
  /** Total cost the run may not exceed. */
  maxTotalCostUsd: number | null;
  runner?: { pid: number; heartbeatAt: string; startedAt?: string };
  /** First start, last finish, and the wall-clock time runners spent on it (a resumed run adds up its sessions). */
  startedAt?: string;
  finishedAt?: string;
  wallClockMs?: number;
  createdAt: string;
  updatedAt: string;
}
