#!/usr/bin/env node
/**
 * Theoria CLI: Pi's own command line, with Theoria's packages loaded.
 *
 * Every directory under packages/ that is a Pi package (its package.json has a `pi` manifest) is passed to Pi with
 * `--extension`, so the packages stay ordinary Pi packages that also work with plain `pi -e <path>`. Pi packages from
 * npm listed in `launcher.piPackages` load the same way. Settings come from theoria.config.json. Pi's built-in MCP
 * extension gets Theoria's config loader (packages/theoria-mcp), which applies the project type.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '@earendil-works/pi-coding-agent';
import { config, ConfigError } from '@theoria/shared/config';
import { agentDir } from '@theoria/shared/paths';
import { defaultQuietStartup } from '@theoria/shared/startup';
import { applyBedrockRegion } from '@theoria/shared/aws';
import { assertProjectType, launchDirEnv, projectTypeEnv } from '@theoria/shared/project';
import { activeComponents, commitEnv, componentSummary, findProfile, harnessEnv, packagesFor, profiles, theoriaCommitNow } from '@theoria/shared/harness';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

/** @type {import('@theoria/shared/config').TheoriaConfig} */
let settings;
try { settings = config(); } catch (error) {
  console.error(`theoria: ${error instanceof ConfigError ? error.message : String(error)}`);
  process.exit(1);
}

// Pi's Bedrock provider needs AWS_REGION; take it from bedrock.region or the AWS profile when it is unset.
applyBedrockRegion();

// Theoria keeps its own Pi configuration, sessions and credentials, apart from a personal ~/.pi.
process.env.PI_CODING_AGENT_DIR ??= agentDir();

// Hide Pi's startup listing of extension file names (Pi's quietStartup "header"), unless the user chose otherwise.
defaultQuietStartup(process.env.PI_CODING_AGENT_DIR);

// pi-better-render keeps its downloads (Mermaid renderer, CJK fonts) under ~/.pi/agent unless told otherwise.
const renderDir = join(process.env.PI_CODING_AGENT_DIR, settings.launcher.betterRenderDir);
process.env.PI_BETTER_RENDER_DEPS_DIR ??= join(renderDir, 'deps');
process.env.PI_BETTER_RENDER_FONTS_DIR ??= join(renderDir, 'fonts');

// The code this process runs: recorded now, since a session keeps running it after the repository moves on.
process.env[commitEnv] = theoriaCommitNow() ?? '';

// New projects are created relative to where theoria was started, even after the session moves into one.
process.env[launchDirEnv] ??= process.cwd();

// `theoria bot …` is Theoria's own subcommand: the Telegram bot process, not a Pi session.
if (process.argv[2] === 'bot') {
  const { botCli } = await import('../packages/theoria-telegram/src/cli.ts');
  process.exit(await botCli(process.argv.slice(3)));
}

// `theoria mcp-launch <server>`: how Pi's mcp.json starts a server Theoria manages. stdout is the MCP channel.
if (process.argv[2] === settings.mcp.launchSubcommand) {
  const { launchServer } = await import('../packages/theoria-mcp/src/launch.ts');
  const { leanSearchPlan } = await import('../packages/theoria-lean/src/search.ts');
  process.exit(await launchServer(process.argv[3], { [settings.leanSearch.server]: cwd => leanSearchPlan(cwd) }));
}

// `theoria harness`: the profiles and what each component adds.
if (process.argv[2] === 'harness') {
  console.log(harnessListing().join('\n'));
  process.exit(0);
}

// `theoria version`: this copy's version and commit (from release.json when installed, else git). Pi's own
// `--version` still reports Pi's version.
if (process.argv[2] === 'version') {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  console.log(`Theoria CLI ${version} (${process.env[commitEnv] || 'unknown commit'})`);
  process.exit(0);
}

const args = takeHarnessFlag(takeProjectTypeFlag(process.argv.slice(2)));
try { activeComponents(); } catch (error) {
  console.error(`theoria: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

// Pi's own MCP extension (and /mcp), with the servers and their direct tools chosen by the session's project type;
// a profile without the mcp component starts none.
const { useProjectTypeMcp } = await import('../packages/theoria-mcp/src/session.ts');
await useProjectTypeMcp();

// A Pi subcommand (`theoria mcp list`, `theoria config`, …) must come first for Pi to see it; it loads no session.
if (settings.launcher.piSubcommands.includes(args[0] ?? '')) {
  await main(args);
} else {
  // Only the packages the harness profile's components live in.
  const packages = packagesFor([...localPiPackages(), ...bundledPiPackages()]);
  // For the research run's record of the harness.
  process.env.THEORIA_PACKAGES = packages.map(path => path.split('/').pop()).join(',');
  // Provider modes add no tools or research instructions, and must resolve consistently in every profile and
  // subprocess (including benchmark trials). Register before startup model selection and --list-models.
  const providerExtensions = settings.bedrock.ultrafast.enabled ? ['--extension', join(root, 'packages/theoria-core/providers/bedrock.ts')] : [];
  await main([...providerExtensions, ...packages.flatMap(path => ['--extension', path]), ...bedrockDefault(args), ...args]);
}

/** Directories under packages/ that are Pi packages. A library such as packages/theoria-shared is not one. */
function localPiPackages() {
  const dir = join(root, 'packages');
  return readdirSync(dir)
    .map(name => join(dir, name))
    .filter(path => existsSync(join(path, 'package.json')) && safeJson(readFileSync(join(path, 'package.json'), 'utf8')).pi);
}

/**
 * Pi packages installed from npm as dependencies, listed in `launcher.piPackages`. Each resolves to its own
 * directory, wherever npm placed it. A listed package that is not installed stops the launcher: running without it
 * would look like the package was there.
 */
function bundledPiPackages() {
  const require = createRequire(join(root, 'package.json'));
  return settings.launcher.piPackages.map(name => {
    try {
      return dirname(require.resolve(`${name}/package.json`));
    } catch {
      console.error(`theoria: the Pi package ${name} is listed in launcher.piPackages but not installed. Run npm install.`);
      process.exit(1);
    }
  });
}

/**
 * Amazon Bedrock as the default model provider.
 *
 * Pi has Bedrock built in and reads the standard AWS credential chain, so all this adds is the choice of it. It
 * applies only when nothing else decided: not a Pi subcommand, no model flag on the command line, no model saved in
 * settings (a `/model` choice is saved there and wins from then on), and AWS credentials in reach. Without
 * credentials Pi's own selection is left alone rather than pointed at a provider that cannot answer.
 */
function bedrockDefault(/** @type {string[]} */ argv) {
  const { launcher, bedrock } = settings;
  if (launcher.piSubcommands.includes(argv[0] ?? '')) return [];
  const modelFlag = new RegExp(`^--(${launcher.modelFlags.join('|')})(=|$)`);
  if (argv.some(arg => modelFlag.test(arg))) return [];
  const settingsPath = join(process.env.PI_CODING_AGENT_DIR ?? '', 'settings.json');
  const piSettings = existsSync(settingsPath) ? safeJson(readFileSync(settingsPath, 'utf8')) : {};
  if (piSettings.defaultProvider || piSettings.defaultModel) return [];
  if (!bedrock.credentialEnv.some(name => process.env[name])) return [];
  return ['--model', `${bedrock.provider}/${process.env.THEORIA_BEDROCK_MODEL || bedrock.defaultModel}`];
}

/**
 * `--project-type <type>` (the name is `project.flag`) is Theoria's, not Pi's: it is taken out of the arguments and
 * passed on as THEORIA_PROJECT_TYPE, after checking the type exists.
 */
function takeProjectTypeFlag(/** @type {string[]} */ argv) {
  const flag = `--${settings.project.flag}`;
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const inline = arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined;
    if (arg !== flag && inline === undefined) { out.push(arg); continue; }
    const type = inline ?? argv[++index];
    if (!type) { console.error(`theoria: ${flag} needs a project type.`); process.exit(1); }
    try { assertProjectType(type, flag); } catch (error) {
      console.error(`theoria: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    process.env[projectTypeEnv] = type;
  }
  return out;
}

/**
 * `--harness <name>` (`harness.flag`) is Theoria's: taken out of the arguments and passed on as THEORIA_HARNESS, so
 * every process the session starts (MCP servers, trials) sees the same profile.
 */
function takeHarnessFlag(/** @type {string[]} */ argv) {
  const flag = `--${settings.harness.flag}`;
  const out = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    const inline = arg.startsWith(`${flag}=`) ? arg.slice(flag.length + 1) : undefined;
    if (arg !== flag && inline === undefined) { out.push(arg); continue; }
    const name = inline ?? argv[++index];
    if (!name || !findProfile(name)) {
      console.error(`theoria: ${flag} needs one of ${profiles().map(profile => profile.name).join(', ')}.`);
      process.exit(1);
    }
    process.env[harnessEnv] = name;
  }
  return out;
}

function harnessListing() {
  const current = process.env[harnessEnv] || settings.harness.default;
  return [
    `Harness profiles (harness.profiles; --${settings.harness.flag} <name> for one run, harness.default otherwise):`,
    ...profiles().flatMap(profile => [
      `${profile.name === current ? '●' : ' '} ${profile.name}: ${profile.description}`,
      ...(profile.components.length ? profile.components.map(component => `    ${component}: ${componentSummary[component]}`) : ['    no Theoria components: Pi alone']),
      ...(profile.leanLspTools.length ? [`    LSP inspection: ${profile.leanLspTools.join(', ')}`] : []),
      `    benchmark trial tools: ${profile.trialTools.join(', ')}`,
    ]),
  ];
}

function safeJson(/** @type {string} */ text) {
  try { return JSON.parse(text) ?? {}; } catch { return {}; }
}
