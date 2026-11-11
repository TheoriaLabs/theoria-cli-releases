import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, shippedConfigPath } from './config.ts';

/**
 * Harness profiles: which of Theoria's components a session loads (`harness.profiles`). A component that is off is
 * not loaded at all, so what a session contains follows from its profile. Selected by `theoria --harness <name>`
 * (the launcher sets `harnessEnv`), else `harness.default`.
 */

export const harnessEnv = 'THEORIA_HARNESS';
export const subagentEnv = 'THEORIA_SUBAGENT';

export const components = ['welcome', 'tui', 'project', 'actions', 'agents', 'lean', 'search', 'mcp', 'workflows', 'latex', 'research', 'plan', 'bench', 'autoresearch', 'telegram', 'goals', 'render'] as const;
export type Component = (typeof components)[number];

/** What each component adds to a session, for `theoria harness`. */
export const componentSummary: Record<Component, string> = {
  welcome: 'the header: the animated Theta logo, project, model, Lean and commands',
  tui: 'the footer (cwd, git, context, tokens, cost, model, Lean and Mathlib), framed editor, turn telemetry, thinking peek, /tui',
  project: '/project, /new-project',
  actions: 'the agent\'s `theoria` tool (Theoria commands for the model)',
  agents: 'independent subagent task delegation and /subagent status/results',
  lean: 'the lean_check tool, the Lean section of the instructions, /lean',
  search: 'Mathlib search tools (lean-lsp) and their section of the instructions',
  mcp: 'MCP servers (Pi\'s /mcp); without it none start',
  workflows: '/formalize, /prove, /compress',
  latex: '/latex: paper create, paper update, pdf and status; TeX dependencies and compiler-checked papers',
  research: 'research runs (their goal and project knowledge in the instructions), /attack, /claim, /artifact',
  plan: 'the plan tool (attack angles, milestones, lemmas, checked against Lean), its <plan> section of the instructions, /plan',
  bench: '/benchmark',
  autoresearch: '/autoresearch: bounded research campaigns using benchmark execution',
  telegram: '/connect-bot and notifications to the phone',
  goals: 'pi-goal-x: about 8 goal tools and its guidance, /goal',
  render: 'pi-better-render: Markdown, Mermaid and math rendering',
};

/** Which components need which: a profile with search but not lean is refused by the configuration check. */
export const requires: Partial<Record<Component, Component[]>> = { search: ['lean', 'mcp'], workflows: ['lean'] };

/** How a benchmark trial uses pi-goal-x: not at all, after a failed first attempt, or from the start. */
export type TrialEscalation = 'none' | 'on-failure' | 'always';
/** Whether a benchmark trial must make a proof plan before it may stop with sorry left. */
export type TrialPlan = 'none' | 'advised' | 'required';

export interface HarnessProfile { name: string; description: string; components: Component[]; trialEscalation: TrialEscalation; trialPlan: TrialPlan; leanExtras: string[]; leanLspTools: string[]; trialTools: string[] }

/** One profile field drives server availability, normal-session exposure and benchmark tool allowlists. */
export const profiles = (): HarnessProfile[] => (config().harness.profiles as unknown as HarnessProfile[]).map(profile => ({ ...profile,
  trialTools: [...new Set([...profile.trialTools, ...profile.leanLspTools.map(tool => `mcp__${config().leanSearch.server.replace(/[^A-Za-z0-9_]/g, '_')}__${tool}`)])],
}));

export function findProfile(name: string): HarnessProfile | undefined {
  return profiles().find(profile => profile.name === name);
}

/** The session's profile. An unknown name in the environment is an error, not a silent default. */
export function currentProfile(env: NodeJS.ProcessEnv = process.env): HarnessProfile {
  const name = env[harnessEnv] || config().harness.default;
  const profile = findProfile(name);
  if (!profile) throw new Error(`Harness profile "${name}" is not one of ${profiles().map(entry => entry.name).join(', ')} (harness.profiles).`);
  return profile;
}

/** The components a session loads: the profile's, and in a benchmark trial only `harness.trialComponents` of them. */
export function activeComponents(env: NodeJS.ProcessEnv = process.env): Set<Component> {
  const profile = currentProfile(env);
  if (env[subagentEnv]) return new Set(profile.components.filter(component => ['lean', 'search', 'mcp'].includes(component)));
  // A trial loads the trial components, and pi-goal-x too when its profile escalates to goal mode.
  const trialComponents = new Set<string>([...config().harness.trialComponents, ...(profile.trialEscalation !== 'none' ? ['goals'] : []), ...(profile.trialPlan !== 'none' ? ['plan'] : [])]);
  const list = env.THEORIA_TRIAL ? profile.components.filter(component => trialComponents.has(component)) : profile.components;
  return new Set(list);
}

export const componentOn = (component: Component, env: NodeJS.ProcessEnv = process.env) => activeComponents(env).has(component);

/** The Theoria code a process runs, set by the launcher when the process starts (it may differ from git HEAD later). */
export const commitEnv = 'THEORIA_COMMIT';

/** Written into release archives (`npm run release`): which version and commit an installed copy is. */
export const releaseFile = 'release.json';

export interface ReleaseInfo { version: string; commit: string; shortCommit: string; date: string }

/** The release this copy was installed from, or undefined in a git checkout (where `release.json` is not tracked). */
export function releaseInfo(repo = dirname(shippedConfigPath())): ReleaseInfo | undefined {
  try {
    const info = JSON.parse(readFileSync(join(repo, releaseFile), 'utf8')) as Partial<ReleaseInfo>;
    return typeof info.version === 'string' && typeof info.commit === 'string' && typeof info.shortCommit === 'string'
      ? { version: info.version, commit: info.commit, shortCommit: info.shortCommit, date: String(info.date ?? '') } : undefined;
  } catch { return undefined; }
}

/**
 * The Theoria commit in the working tree now, with `-dirty` when its code or settings have uncommitted changes. The
 * launcher records it at startup, because a long-running session keeps running the code it loaded. An installed
 * release has no git metadata: its commit comes from `release.json`, which is checked first so that a release
 * extracted inside some other git repository does not report that repository's commit.
 */
export function theoriaCommitNow(repo = dirname(shippedConfigPath())): string | undefined {
  const release = releaseInfo(repo);
  if (release) return release.shortCommit;
  const head = spawnSync('git', ['-C', repo, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
  if (!head) return undefined;
  const dirty = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--', 'bin', 'packages', 'theoria.config.json', 'package-lock.json'], { encoding: 'utf8' }).stdout?.trim();
  return dirty ? `${head}-dirty` : head;
}

/** The commit this process loaded. */
export const loadedCommit = () => process.env[commitEnv] || theoriaCommitNow();

/**
 * Which of `paths` (package directories) a session loads under its profile: those holding an active component. In a
 * bot session the connector always loads, for its file guard and secret stripping, which add nothing to the context.
 */
export function packagesFor(paths: string[], env: NodeJS.ProcessEnv = process.env): string[] {
  const active = activeComponents(env);
  return paths.filter(path => {
    const name = path.split('/').pop() ?? '';
    if (name === 'theoria-telegram' && env.THEORIA_BOT_SESSION) return true;
    return (packageComponents[name] ?? []).some(component => active.has(component));
  });
}

/** The local packages and npm Pi packages each component lives in. A package loads when any of its components is on. */
export const packageComponents: Record<string, Component[]> = {
  'theoria-core': ['project', 'actions'],
  'theoria-agents': ['agents'],
  'theoria-tui': ['welcome', 'tui'],
  'theoria-lean': ['lean'],
  'theoria-workflows': ['workflows'],
  'theoria-latex': ['latex'],
  'theoria-research': ['research', 'plan'],
  'theoria-bench': ['bench'],
  'theoria-autoresearch': ['autoresearch'],
  'theoria-telegram': ['telegram'],
  'pi-goal-x': ['goals'],
  'pi-better-render': ['render'],
};
