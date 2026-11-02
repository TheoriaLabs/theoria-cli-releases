import type { Aggregate } from './store.ts';
import type { TrialMetrics } from './types.ts';

export const money = (usd: number) => `$${usd < 10 ? usd.toFixed(3) : usd.toFixed(2)}`;
export const tokens = (count: number) => count >= 1e6 ? `${(count / 1e6).toFixed(2)}M` : count >= 1e3 ? `${(count / 1e3).toFixed(1)}k` : String(count);
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
export function trialUsage(metrics: Partial<TrialMetrics>): string {
  const input = (metrics.tokensIn ?? 0) + (metrics.cacheRead ?? 0) + (metrics.cacheWrite ?? 0);
  return `${money(metrics.costUsd ?? 0)} · ${duration(metrics.durationMs ?? 0)} · tokens in ${tokens(input)}${metrics.cacheRead || metrics.cacheWrite ? ` (${tokens(metrics.cacheRead ?? 0)} cached)` : ''} / out ${tokens(metrics.tokensOut ?? 0)} · ${metrics.turns ?? 0} turns`;
}
export function usageLines(result: Aggregate): string[] {
  const finished = result.passed + result.failed + result.errors + result.cancelled;
  return [
    `Cost ${money(result.costUsd)}${result.costPerPassUsd !== null ? ` · ${money(result.costPerPassUsd)} per successful trial` : ''} · mean ${finished ? money(result.meanCostUsd) : 'n/a'} per completed trial`,
    `Wall-clock ${duration(result.wallClockMs)} · trial time ${duration(result.trialTimeMs)} (completed mean ${finished ? duration(result.meanDurationMs) : 'n/a'})`,
    `Tokens in ${tokens(result.tokensIn + result.cacheRead + result.cacheWrite)} (uncached ${tokens(result.tokensIn)}, cache read ${tokens(result.cacheRead)}, cache write ${tokens(result.cacheWrite)}) · out ${tokens(result.tokensOut)}`,
  ];
}
