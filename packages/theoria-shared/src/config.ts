import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Theoria CLI's settings: `theoria.config.json` at the repository root, with an optional user file merged over it.
 *
 * The shipped file is also the schema. A user file may only use keys the shipped file has, with values of the same
 * type; objects merge into the defaults and arrays replace them. The merged result is then checked against the rules
 * below. Anything wrong stops the CLI with the key named, because a setting that is silently ignored is worse than
 * one that fails loudly.
 */

export type TheoriaConfig = typeof import('../../../theoria.config.json', { with: { type: 'json' } });

export const configFileName = 'theoria.config.json';
/** Points at a user config file other than `paths.userConfig`. */
export const configEnv = 'THEORIA_CONFIG';

export class ConfigError extends Error {}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const isObject = (value: unknown): value is Record<string, Json> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const expandHome = (path: string) => (path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);

/** The shipped file, found by walking up from this module, so it is the same file however the code is loaded. */
export function shippedConfigPath(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    const candidate = join(dir, configFileName);
    if (existsSync(candidate)) return candidate;
    if (dir === parse(dir).root) throw new ConfigError(`${configFileName} was not found above ${fileURLToPath(import.meta.url)}.`);
  }
}

function readJson(path: string): Json {
  try { return JSON.parse(readFileSync(path, 'utf8')) as Json; } catch (error) {
    throw new ConfigError(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Sections a user config may add entries to, and the shipped entry each new one is checked against: a new project
 * type has the shape of `other`.
 */
const openSections: Record<string, string> = { projectTypes: 'other' };
/** Settings a new entry may leave out, taking the template's value: added after types could be user-defined. */
const optionalInNew: Record<string, string[]> = { projectTypes: ['mcpServers', 'otherServers', 'latex'] };

/** Every key and type of `override` must exist in `shape`. Returns the problems, one per line. */
function conform(override: Json, shape: Json, path: string, problems: string[]) {
  if (isObject(shape)) {
    if (!isObject(override)) { problems.push(`${path || '(root)'} must be an object.`); return; }
    for (const [key, value] of Object.entries(override)) {
      if (key === '$comment') continue;
      const template = openSections[path];
      if (!(key in shape) && template && isObject(override[key])) {
        const missing = Object.keys(shape[template] as Record<string, Json>)
          .filter(name => name !== '$comment' && !(name in (override[key] as Record<string, Json>)) && !optionalInNew[path]?.includes(name));
        if (missing.length) problems.push(`${path}.${key} needs ${missing.join(', ')}, like ${path}.${template}.`);
        conform(override[key]!, shape[template]!, `${path}.${key}`, problems);
        continue;
      }
      if (!(key in shape)) { problems.push(`${path ? `${path}.` : ''}${key} is not a setting. Known here: ${Object.keys(shape).filter(name => name !== '$comment').join(', ')}.`); continue; }
      conform(value, shape[key]!, path ? `${path}.${key}` : key, problems);
    }
    return;
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(override)) { problems.push(`${path} must be a list.`); return; }
    const sample = shape[0];
    if (sample !== undefined) override.forEach((item, index) => conform(item, sample, `${path}[${index}]`, problems));
    return;
  }
  if (typeof override !== typeof shape) problems.push(`${path} must be a ${typeof shape}, not ${JSON.stringify(override)}.`);
}

function merge(base: Json, override: Json, path = ''): Json {
  if (!isObject(base) || !isObject(override)) return override;
  // Weights form one objective, not independent defaults. In particular, old LOC/HB overrides must not
  // inherit newly introduced token/compatibility weights and silently change their objective.
  if (path === 'workflows.compression.scoreWeights') return Object.fromEntries(Object.keys(base).map(key => [key, override[key] ?? 0]));
  const out: Record<string, Json> = { ...base };
  const template = openSections[path];
  for (const [key, value] of Object.entries(override)) {
    if (key in base) { out[key] = merge(base[key]!, value, path ? `${path}.${key}` : key); continue; }
    // A new entry of an open section gets the template's value for each optional setting it leaves out.
    const defaults = template && isObject(value) && isObject(base[template]) ? Object.fromEntries((optionalInNew[path] ?? []).map(name => [name, (base[template] as Record<string, Json>)[name]!])) : {};
    out[key] = isObject(value) ? { ...defaults, ...value } : value;
  }
  return out;
}

/** Rules a type alone cannot express. */
function rules(config: TheoriaConfig): string[] {
  const problems: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) problems.push(`${path} must be a number of 0 or more.`);
    if (isObject(value)) for (const [key, inner] of Object.entries(value)) walk(inner, path ? `${path}.${key}` : key);
    if (Array.isArray(value)) value.forEach((item, index) => walk(item, `${path}[${index}]`));
  };
  walk(config, '');
  const share = (path: string, value: number) => { if (value > 1) problems.push(`${path} is a share and must be at most 1.`); };
  share('workflows.target.matchThreshold', config.workflows.target.matchThreshold);
  share('workflows.target.matchBand', config.workflows.target.matchBand);
  share('workflows.target.docstringWeight', config.workflows.target.docstringWeight);
  for (const key of ['maxAttempts', 'timeoutSeconds'] as const) {
    const { min, max } = config.workflows.limits[key];
    if (min > max) problems.push(`workflows.limits.${key}.min is above its max.`);
    const fallback = config.workflows.defaults[key];
    if (fallback < min || fallback > max) problems.push(`workflows.defaults.${key} (${fallback}) is outside workflows.limits.${key}.`);
  }
  if (!['loc', 'clarity', 'balanced'].includes(config.workflows.defaults.emphasis)) problems.push('workflows.defaults.emphasis must be loc, clarity or balanced.');
  if (!Number.isSafeInteger(config.workflows.compression.rounds) || config.workflows.compression.rounds < 1) problems.push('workflows.compression.rounds must be a positive safe integer.');
  const scoreWeights = config.workflows.compression.scoreWeights;
  if (Math.abs(scoreWeights.loc + scoreWeights.tokens + scoreWeights.heartbeats + scoreWeights.compatibility - 1) > 1e-9) problems.push('workflows.compression.scoreWeights must sum to 1 (loc + tokens + heartbeats + compatibility).');
  if (!['cl100k_base', 'o200k_base'].includes(config.workflows.compression.tokenizer)) problems.push('workflows.compression.tokenizer must be cl100k_base or o200k_base.');
  if (config.workflows.compression.compatibilityProjects.some((path: unknown) => typeof path !== 'string' || !path.trim())) problems.push('workflows.compression.compatibilityProjects must contain nonempty project paths.');
  if (new Set(config.workflows.compression.compatibilityProjects).size !== config.workflows.compression.compatibilityProjects.length) problems.push('workflows.compression.compatibilityProjects must not contain duplicates.');
  if (config.workflows.compression.minImprovementPercent <= 0 || config.workflows.compression.minImprovementPercent > 100) problems.push('workflows.compression.minImprovementPercent must be above zero and at most 100.');
  if (!/^#[0-9a-fA-F]{6}$/.test(config.welcome.color.hex)) problems.push('welcome.color.hex must be a colour like #76b900.');
  if (!Number.isInteger(config.welcome.color.ansi256) || config.welcome.color.ansi256 > 255) problems.push('welcome.color.ansi256 must be a whole number from 0 to 255.');
  const widths = new Set(config.welcome.logo.map(row => [...row].length));
  if (widths.size > 1) problems.push('welcome.logo rows must all be the same width, or the logo is not centred.');
  const types = Object.entries(config.projectTypes).filter(([key]) => key !== '$comment') as [string, { workflows: string[]; lean: boolean; progress: string }][];
  if (!types.some(([key]) => key === config.project.defaultType)) problems.push(`project.defaultType "${config.project.defaultType}" is not one of the projectTypes.`);
  for (const [key, type] of types) {
    if (type.workflows.length && !type.lean) problems.push(`projectTypes.${key} has workflows but lean is false; the workflows need Lean.`);
  }
  for (const [key, type] of types) {
    if (!['lean-goal', 'none'].includes(type.progress)) problems.push(`projectTypes.${key}.progress must be lean-goal or none.`);
  }
  for (const [key, type] of types as unknown as [string, { mcpServers: unknown[]; otherServers: string }][]) {
    if (!['show', 'hide'].includes(type.otherServers)) problems.push(`projectTypes.${key}.otherServers must be show or hide.`);
    const names = new Set<string>();
    type.mcpServers.forEach((entry, index) => {
      const at = `projectTypes.${key}.mcpServers[${index}]`;
      if (!isObject(entry) || typeof entry.server !== 'string' || !/^[A-Za-z0-9_-]+$/.test(entry.server)) { problems.push(`${at}.server must be an MCP server name.`); return; }
      if (!Array.isArray(entry.directTools) || entry.directTools.some(tool => typeof tool !== 'string')) problems.push(`${at}.directTools must be a list of tool names.`);
      if (Object.keys(entry).some(name => !['server', 'directTools'].includes(name))) problems.push(`${at} may only have server and directTools.`);
      if (names.has(entry.server)) problems.push(`${at} lists ${entry.server} twice.`);
      names.add(entry.server);
    });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(config.leanSearch.server)) problems.push('leanSearch.server must be an MCP server name (letters, digits, - and _).');
  if (!/^\d+\.\d+(\.\d+)?$/.test(config.leanSearch.version)) problems.push('leanSearch.version must be a version such as 0.31.0.');
  if (!Number.isSafeInteger(config.leanSearch.topK) || config.leanSearch.topK < 1) problems.push('leanSearch.topK must be a positive safe integer.');
  if (!Number.isFinite(config.leanSearch.requestTimeoutSeconds) || config.leanSearch.requestTimeoutSeconds <= 0) problems.push('leanSearch.requestTimeoutSeconds must be positive.');
  const localPath = (path: string) => typeof path === 'string' && path.length > 0 && !path.startsWith('/') && !path.split('/').some(part => part === '..' || part === '.');
  if (!localPath(config.workflows.baselineCacheDir)) problems.push('workflows.baselineCacheDir must be project-relative.');
  if (!localPath(config.subagents.dir)) problems.push('subagents.dir must be a relative folder.');
  for (const [key, value] of Object.entries(config.subagents)) {
    if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) problems.push(`subagents.${key} must be positive.`);
  }
  for (const key of ['maxConcurrent', 'maxTasks', 'maxTurns', 'resultChars'] as const)
    if (!Number.isSafeInteger(config.subagents[key])) problems.push(`subagents.${key} must be an integer.`);
  if (config.subagents.maxCostUsd > config.subagents.maxTotalCostUsd) problems.push('subagents.maxCostUsd exceeds the parent-session total.');
  if (!localPath(config.lean.extrasDir)) problems.push('lean.extrasDir must be a relative folder below the agent directory.');
  const extraNames = new Set<string>();
  for (const [index, extra] of config.lean.extras.entries()) {
    const at = `lean.extras[${index}]`;
    if (!/^[A-Za-z0-9_-]+$/.test(extra.name ?? '')) problems.push(`${at}.name must contain only letters, digits, - or _.`);
    if (extraNames.has(extra.name)) problems.push(`${at}.name is listed twice.`);
    extraNames.add(extra.name);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(extra.package ?? '') || !/^[A-Za-z][A-Za-z0-9_.]*$/.test(extra.target ?? '')) problems.push(`${at} needs a Lake package and importable build target.`);
    if (typeof extra.repo !== 'string' || !extra.repo.startsWith('https://')) problems.push(`${at}.repo must be an HTTPS repository URL.`);
    if (!(extra.installTimeoutSeconds > 0)) problems.push(`${at}.installTimeoutSeconds must be above zero.`);
    if (!Array.isArray(extra.instructions) || extra.instructions.some(line => typeof line !== 'string')) problems.push(`${at}.instructions must be a list of strings.`);
    if (!Array.isArray(extra.versions) || !extra.versions.length) problems.push(`${at}.versions needs at least one pinned version.`);
    const versions = new Set<string>();
    for (const version of extra.versions ?? []) {
      if (!/^v\d+\.\d+\.\d+(?:-rc\d+)?$/.test(version.mathlib ?? '') || !version.rev?.trim()) problems.push(`${at}.versions needs an exact Mathlib version and an add-on revision.`);
      if (versions.has(version.mathlib)) problems.push(`${at}.versions lists ${version.mathlib} twice.`);
      versions.add(version.mathlib);
    }
    if (!Array.isArray(extra.tools)) problems.push(`${at}.tools must be a list.`);
    for (const tool of extra.tools ?? []) if (!localPath(tool.path) || !localPath(tool.link) || !tool.link.startsWith('.lake/')) problems.push(`${at}.tools needs relative paths, with links below .lake/.`);
  }
  for (const [index, entry] of config.actions.model.entries()) {
    for (const surface of ['terminal', 'bot', 'trial'] as const) {
      if (!['allow', 'ask', 'deny'].includes(entry[surface])) problems.push(`actions.model[${index}].${surface} must be allow, ask or deny.`);
    }
  }
  const splits = config.benchmarks.splits;
  if (!Number.isSafeInteger(config.benchmarks.compression.rounds) || config.benchmarks.compression.rounds < 1) problems.push('benchmarks.compression.rounds must be a positive integer.');
  for (const key of ['workerStartupTimeoutSeconds', 'workerRpcTimeoutSeconds'] as const)
    if (!Number.isFinite(config.benchmarks[key]) || config.benchmarks[key] <= 0) problems.push(`benchmarks.${key} must be positive.`);
  const campaign = config.autoresearch;
  if (!localPath(campaign.dir)) problems.push('autoresearch.dir must be project-relative.');
  if (!Number.isSafeInteger(campaign.artifactPageBytes) || campaign.artifactPageBytes < 4)
    problems.push('autoresearch.artifactPageBytes must be an integer of at least 4 (one UTF-8 character).');
  for (const key of ['workers', 'maxExperiments', 'maxDecisions', 'parentTurnMaxResponses', 'evidenceChars', 'literatureMaxBytes', 'literatureMaxRequests'] as const)
    if (!Number.isSafeInteger(campaign[key]) || campaign[key] < 1) problems.push(`autoresearch.${key} must be a positive integer.`);
  if (campaign.workers > config.benchmarks.limits.concurrency.max) problems.push('autoresearch.workers exceeds the benchmark concurrency limit.');
  for (const key of ['parentTurnCostUsd', 'literatureTimeoutSeconds'] as const)
    if (!(campaign[key] > 0)) problems.push(`autoresearch.${key} must be positive.`);
  for (const entry of config.benchmarks.comparator.tags) if (entry.exporter && !/^[a-f0-9]{40}$/.test(entry.exporter)) problems.push(`benchmarks.comparator.tags (${entry.lean}): exporter must be an exact commit, or empty for the bundled exporter.`);
  if (!splits.shares.length || splits.shares.some(entry => !(entry.share > 0))) problems.push('benchmarks.splits.shares needs at least one split, each with a share above 0.');
  if (new Set(splits.shares.map(entry => entry.split)).size !== splits.shares.length) problems.push('benchmarks.splits.shares names a split twice.');
  if (!splits.shares.some(entry => entry.split === splits.defaultRunSplit)) problems.push(`benchmarks.splits.defaultRunSplit "${splits.defaultRunSplit}" is not one of the splits.`);
  {
    const known = ['welcome', 'tui', 'project', 'actions', 'agents', 'lean', 'search', 'mcp', 'workflows', 'latex', 'research', 'plan', 'bench', 'autoresearch', 'telegram', 'goals', 'render'];
    const needs: Record<string, string[]> = { search: ['lean', 'mcp'], workflows: ['lean'] };
    const names = new Set<string>();
    for (const [index, profile] of config.harness.profiles.entries()) {
      const at = `harness.profiles[${index}] (${profile.name})`;
      if (names.has(profile.name)) problems.push(`${at}: the name is used twice.`);
      names.add(profile.name);
      if (!['none', 'on-failure', 'always'].includes(profile.trialEscalation)) problems.push(`${at}: trialEscalation must be none, on-failure or always.`);
      if (profile.trialEscalation !== 'none' && !(profile.components as string[]).includes('goals')) problems.push(`${at}: trialEscalation ${profile.trialEscalation} needs the goals component.`);
      for (const extra of profile.leanExtras) if (!config.lean.extras.some(entry => entry.name === extra)) problems.push(`${at}: leanExtras names ${extra}, which is not one of lean.extras.`);
      if (profile.leanExtras.length > 1) problems.push(`${at}: leanExtras supports only one add-on workspace at a time.`);
      if (profile.leanExtras.length && !(profile.components as string[]).includes('lean')) problems.push(`${at}: leanExtras needs the lean component.`);
      const readOnlyLsp = ['lean_goal', 'lean_term_goal', 'lean_hover_info', 'lean_diagnostic_messages', 'lean_file_outline', 'lean_completions', 'lean_declaration_file', 'lean_references',
        'lean_multi_attempt', 'lean_code_actions', 'lean_run_code', 'lean_profile_proof'];
      if (!Array.isArray(profile.leanLspTools) || profile.leanLspTools.some((tool: string) => !readOnlyLsp.includes(tool))) problems.push(`${at}: leanLspTools must contain supported read-only LSP tools.`);
      if (profile.leanLspTools.length && ['lean', 'search', 'mcp'].some(component => !(profile.components as string[]).includes(component))) problems.push(`${at}: leanLspTools needs the lean, search and mcp components.`);
      if (new Set(profile.leanLspTools).size !== profile.leanLspTools.length) problems.push(`${at}: leanLspTools lists a tool twice.`);
      if (!['none', 'advised', 'required'].includes(profile.trialPlan)) problems.push(`${at}: trialPlan must be none, advised or required.`);
      if (profile.trialPlan !== 'none' && !(profile.components as string[]).includes('plan')) problems.push(`${at}: trialPlan ${profile.trialPlan} needs the plan component.`);
      for (const component of profile.components) {
        if (!known.includes(component)) problems.push(`${at}: ${component} is not a component (${known.join(', ')}).`);
        for (const needed of needs[component] ?? []) if (!(profile.components as string[]).includes(needed)) problems.push(`${at}: ${component} needs ${needed}.`);
      }
    }
    if (!names.has(config.harness.default)) problems.push(`harness.default "${config.harness.default}" is not one of the profiles.`);
    for (const component of config.harness.trialComponents) if (!known.includes(component)) problems.push(`harness.trialComponents: ${component} is not a component.`);
  }
  const tui = config.tui;
  const latex = config.latex;
  if (!latex.latexmk.repo.startsWith('https://') || !/^[a-f0-9]{40}$/.test(latex.latexmk.rev)) problems.push('latex.latexmk needs an HTTPS repository and pinned commit.');
  for (const key of ['settingsFile', 'stateDir', 'paperDir', 'mainFile', 'installDir'] as const) if (!localPath(latex[key])) problems.push(`latex.${key} must be a relative path without parent traversal.`);
  if (!latex.mainFile.endsWith('.tex')) problems.push('latex.mainFile must end in .tex.');
  if (!latex.engines.length || latex.engines.some(engine => !['pdflatex', 'xelatex', 'lualatex'].includes(engine)) || !latex.engines.includes(latex.engine)) problems.push('latex.engine must be one of latex.engines (pdflatex, xelatex, lualatex).');
  for (const key of ['maxPasses', 'probeTimeoutSeconds', 'installTimeoutSeconds', 'compileTimeoutSeconds'] as const) if (!(latex[key] > 0)) problems.push(`latex.${key} must be above zero.`);
  for (const [key, value] of Object.entries(latex.workflow)) if (!(value > 0)) problems.push(`latex.workflow.${key} must be above zero.`);
  for (const key of ['maxFiles', 'maxFileChars', 'maxChars'] as const) if (!(latex.context[key] > 0)) problems.push(`latex.context.${key} must be above zero.`);
  if (!Number.isInteger(latex.maxPasses) || !Number.isInteger(latex.workflow.maxAttempts)) problems.push('latex.maxPasses and latex.workflow.maxAttempts must be whole numbers.');
  for (const entry of latex.packages) if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(entry.name ?? '') || !localPath(entry.file)) problems.push('latex.packages needs package names and relative probe filenames.');
  if (!['en', 'zh'].includes(tui.settingsLanguage)) problems.push('tui.settingsLanguage must be en or zh.');
  if (!['block', 'bar', 'underline'].includes(tui.cursorStyle)) problems.push('tui.cursorStyle must be block, bar or underline.');
  if (!['auto', 'nerd', 'unicode', 'ascii'].includes(tui.icons.mode)) problems.push('tui.icons.mode must be auto, nerd, unicode or ascii.');
  if (![0, 1, 2].includes(tui.thinkingPeek.lines)) problems.push('tui.thinkingPeek.lines must be 0, 1 or 2.');
  if (tui.logo.frameMs < 16) problems.push('tui.logo.frameMs must be at least 16.');
  if (tui.logo.sweepFrames < 1) problems.push('tui.logo.sweepFrames must be at least 1.');
  if (!['shear', 'sweep'].includes(tui.logo.intro)) problems.push('tui.logo.intro must be shear or sweep.');
  if (tui.logo.shearMs < 200 || tui.logo.shearMs > 20000) problems.push('tui.logo.shearMs must be from 200 to 20000.');
  if (tui.logo.holdMs > 10000) problems.push('tui.logo.holdMs must be at most 10000.');
  if (!['bonferroni', 'none'].includes(config.research.statistical.correction)) problems.push('research.statistical.correction must be bonferroni or none.');
  if (!(config.research.statistical.sigma > 0)) problems.push('research.statistical.sigma must be above 0.');
  if (config.research.statistical.minSamples < 2) problems.push('research.statistical.minSamples must be at least 2.');
  for (const key of ['concurrency', 'timeoutMinutes'] as const) {
    const { min, max } = config.benchmarks.limits[key];
    if (min > max) problems.push(`benchmarks.limits.${key}.min is above its max.`);
  }
  if (!['INFO', 'WARNING', 'ERROR', 'NONE'].includes(config.leanSearch.logLevel)) problems.push('leanSearch.logLevel must be INFO, WARNING, ERROR or NONE.');
  if (!config.project.parentDir.trim()) problems.push('project.parentDir must not be empty.');
  const ultrafast = config.bedrock.ultrafast;
  const aliases = [ultrafast, ...ultrafast.additionalModels];
  const aliasIds = new Set<string>();
  for (const [index, alias] of aliases.entries()) {
    const at = index === 0 ? 'bedrock.ultrafast' : `bedrock.ultrafast.additionalModels[${index - 1}]`;
    if (!alias.aliasId.trim() || !alias.modelId.trim() || !alias.name.trim() || alias.aliasId === alias.modelId) problems.push(`${at} needs a name and distinct nonempty aliasId/modelId.`);
    if (aliasIds.has(alias.aliasId)) problems.push(`${at}.aliasId duplicates another Ultrafast alias.`);
    if (aliases.some(other => other.modelId === alias.aliasId)) problems.push(`${at}.aliasId must not shadow a physical modelId.`);
    aliasIds.add(alias.aliasId);
  }
  if (!config.welcome.footnote.includes('{version}') && /\{\w+\}/.test(config.welcome.footnote)) problems.push('welcome.footnote may only use {version}.');
  return problems;
}

/**
 * Loads and validates the configuration. `override` replaces reading the user file, for tests.
 * Without a user file the shipped defaults are used as they are.
 */
export function loadConfig(options: { override?: unknown } = {}): TheoriaConfig {
  const shippedPath = shippedConfigPath();
  const shipped = readJson(shippedPath);
  let override: Json | undefined = options.override as Json | undefined;
  let source = 'the override';
  if (!('override' in options)) {
    const named = process.env[configEnv];
    const path = named ? expandHome(named) : expandHome((shipped as unknown as TheoriaConfig).paths.userConfig);
    if (named && !existsSync(path)) throw new ConfigError(`${configEnv} names ${path}, which does not exist.`);
    if (existsSync(path)) { override = readJson(path); source = path; }
  }
  const problems: string[] = [];
  // Accept existing user files and frozen worker configs without mutating them. Explicit new settings win.
  if (isObject(override) && isObject(override.benchmarks) && 'campaigns' in override.benchmarks) {
    const { campaigns, ...benchmarks } = override.benchmarks;
    conform(campaigns!, (shipped as Record<string, Json>).autoresearch!, 'benchmarks.campaigns', problems);
    override = { ...override, benchmarks,
      autoresearch: override.autoresearch === undefined ? campaigns! : merge(campaigns!, override.autoresearch) };
  }
  // /benchmark improve and its settings were removed; existing user files and frozen worker configs may still carry
  // benchmarks.autoresearch. It no longer does anything, so it is dropped rather than stopping the CLI.
  if (isObject(override) && isObject(override.benchmarks) && 'autoresearch' in override.benchmarks) {
    const { autoresearch: _removed, ...benchmarks } = override.benchmarks;
    override = { ...override, benchmarks };
  }
  if (override !== undefined) conform(override, shipped, '', problems);
  if (problems.length) throw new ConfigError(`Invalid settings in ${source}:\n- ${problems.join('\n- ')}`);
  const merged = (override === undefined ? shipped : merge(shipped, override)) as unknown as TheoriaConfig;
  // Existing custom profiles predate add-ons; omitting leanExtras keeps their original environment.
  for (const profile of merged.harness.profiles) { profile.leanExtras ??= []; profile.leanLspTools ??= []; }
  const broken = rules(merged);
  if (broken.length) throw new ConfigError(`Invalid settings (${override === undefined ? shippedPath : `${shippedPath} with ${source}`}):\n- ${broken.join('\n- ')}`);
  return deepFreeze(merged);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) { for (const inner of Object.values(value)) deepFreeze(inner); Object.freeze(value); }
  return value;
}

let cached: TheoriaConfig | undefined;

/** The configuration, loaded once per process (until `reloadConfig`). */
export function config(): TheoriaConfig {
  cached ??= loadConfig();
  return cached;
}

/** Reads the configuration again, after Theoria changed the user file (`/project servers`). */
export function reloadConfig(): TheoriaConfig {
  cached = loadConfig();
  return cached;
}

/** The user config file: `THEORIA_CONFIG`, else `paths.userConfig`. */
export const userConfigPath = () => expandHome(process.env[configEnv] || config().paths.userConfig);

/** Every leaf setting, as dotted paths, without `$comment`s: what a test holds the code to reading. */
export function settingPaths(value: unknown = readJson(shippedConfigPath()), prefix = ''): string[] {
  if (!isObject(value)) return [prefix];
  return Object.entries(value).filter(([key]) => key !== '$comment')
    .flatMap(([key, inner]) => settingPaths(inner, prefix ? `${prefix}.${key}` : key));
}
