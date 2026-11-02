import { BoundedAgent } from '@theoria/pi-agents/runtime';
import type { TrialMetrics } from './types.ts';
import { TrialSession } from './trial-session.ts';

/** Benchmark policy uses the same bounded runtime as general subagents, with an isolated trial session. */
export class ExperimentAgent extends BoundedAgent {
  declare readonly session: TrialSession;
  declare readonly metrics: TrialMetrics;
  constructor(workspace: string, model: string, env: NodeJS.ProcessEnv, harness: string, thinking: string,
    limits: { maxCostUsd: number | null; maxTurns: number | null; timeoutMinutes: number | null }, signal: AbortSignal,
    piDir: string, onMetrics: (metrics: TrialMetrics) => void = () => {}, onActivity: (activity: { text: string; at: string }) => void = () => {}, readOnly: string[] = []) {
    super(new TrialSession(workspace, model, env, harness, thinking, { piDir }, readOnly), limits, signal, onMetrics, onActivity);
  }
}
