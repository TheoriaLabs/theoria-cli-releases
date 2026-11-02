/**
 * What other Theoria packages use from the Lean package: resolving a session's environment and checking Lean
 * against it. Everything else here is internal to /lean.
 */
export { check, elaborate, formatCheck, sorryWarning, type CheckInput, type CheckResult } from './check.ts';
export type { LeanDeclaration } from './inspect.ts';
export type { HeartbeatReport, HeartbeatCommand } from './heartbeats.ts';
export { leanChoices, type LeanChoice } from './choices.ts';
export { inventory, toolchains } from './discovery.ts';
export { label, ready, resolve, variables, type Environment } from './environment.ts';
export { leanVersionOf, toolchainFor } from './toolchain.ts';
export { save as saveLeanSelection, type Selection } from './settings.ts';
export { extraDir, extraLeanPath, extraSpec, extraState, installExtra, type ExtraState } from './extras.ts';
export { leanSearchPlan, searchState, sessionEntry, type SearchState } from './search.ts';
