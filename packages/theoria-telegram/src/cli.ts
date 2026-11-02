import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { config, shippedConfigPath } from '@theoria/shared/config';
import { bedrockRegion } from '@theoria/shared/aws';
import { agentDir } from '@theoria/shared/paths';
import { run as runProgram, seconds } from '@theoria/shared/process';
import { TheoriaBot } from './bot.ts';
import { CredentialBroker } from './credentials.ts';
import { deleteSecret, isSecretName, readToken, saveSecret } from './keychain.ts';
import { readOwner, readSecretNames, stateDir, statePath, writeSecretNames } from './store.ts';
import { TelegramApi } from './telegram.ts';

/**
 * `theoria bot start | stop | status | run | login on|off`. `run` is the bot in the foreground (what `start` and
 * launchd run); `start` runs it in the background with its output in `bot.log`.
 */

const pidFile = () => statePath('bot.pid');
const logFile = () => statePath('bot.log');
const cli = () => join(dirname(shippedConfigPath()), 'bin', 'theoria.js');

/** The pid of the running bot, when one is running. */
export function botPid(): number | undefined {
  try {
    const pid = Number(readFileSync(pidFile(), 'utf8').trim());
    if (!pid) return undefined;
    process.kill(pid, 0);
    return pid;
  } catch { return undefined; }
}

const stamp = (line: string) => `${new Date().toISOString()} ${line}`;

async function runForeground(): Promise<number> {
  const running = botPid();
  // Not a failure: launchd restarts a bot that exits with an error, which would loop against the running one.
  if (running && running !== process.pid) { console.error(stamp(`theoria bot is already running (pid ${running}); this one exits.`)); return 0; }
  const token = await readToken();
  if (!token) { console.error(stamp('No bot token in the Keychain. Run /connect-bot in theoria first.')); await waitBeforeRetry(); return 1; }
  const api = new TelegramApi(token);
  const me = await api.getMe();
  if (!me.ok || !me.result) { console.error(stamp(`Telegram did not accept the bot token: ${me.detail}`)); await waitBeforeRetry(); return 1; }
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile(), String(process.pid));
  const bot = new TheoriaBot(api, me.result, line => console.log(stamp(line)));
  const profile = config().bedrock.awsProfile;
  if (profile) {
    // Fails here, at startup, when the profile cannot sign in: better than every prompt failing later.
    bot.credentials = new CredentialBroker(profile);
    try { await bot.credentials.start(); } catch (error) {
      console.error(stamp(error instanceof Error ? error.message : String(error)));
      rmSync(pidFile(), { force: true });
      await waitBeforeRetry();
      return 1;
    }
    console.log(stamp(`AWS credentials for sessions: profile ${profile}, through the credential broker`));
  }
  const stop = () => { bot.stop(); bot.credentials?.stop(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  console.log(stamp(`theoria bot running as @${me.result.username} (pid ${process.pid}); ${bot.owner ? `owner ${bot.owner.displayName}` : 'not paired yet'}`));
  const outcome = await bot.run();
  rmSync(pidFile(), { force: true });
  console.log(stamp(`theoria bot stopped (${outcome})`));
  // The poll in flight may hold the event loop for up to the poll timeout; there is nothing left to wait for.
  process.exit(outcome === 'conflict' ? 2 : 0);
}

/** launchd restarts a failed bot at once; waiting first keeps a lasting problem from filling the log. */
const waitBeforeRetry = () => new Promise(resolve => setTimeout(resolve, seconds(config().connectors.telegram.backoffMaxSeconds)));

/** Starts the bot in the background. Resolves once it has written its pid, or with the reason it did not. */
export async function startBot(): Promise<{ ok: boolean; detail: string }> {
  const running = botPid();
  if (running) return { ok: true, detail: `theoria bot is already running (pid ${running}).` };
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const out = openSync(logFile(), 'a');
  const child = spawn(process.execPath, [cli(), 'bot', 'run'], {
    detached: true, stdio: ['ignore', out, out], env: { ...process.env, PI_CODING_AGENT_DIR: agentDir() },
  });
  child.unref();
  closeSync(out);
  for (let waited = 0; waited < 15_000; waited += 250) {
    await new Promise(resolve => setTimeout(resolve, 250));
    if (botPid()) return { ok: true, detail: `theoria bot started (pid ${botPid()}). Log: ${logFile()}` };
    if (child.exitCode !== null) break;
  }
  return { ok: false, detail: `theoria bot did not start. Last log lines:\n${tail(logFile(), 5)}` };
}

export async function stopBot(): Promise<string> {
  const pid = botPid();
  if (!pid) return 'theoria bot is not running.';
  process.kill(pid, 'SIGTERM');
  for (let waited = 0; waited < 10_000 && botPid(); waited += 250) await new Promise(resolve => setTimeout(resolve, 250));
  if (botPid()) { process.kill(pid, 'SIGKILL'); rmSync(pidFile(), { force: true }); }
  return `theoria bot stopped (pid ${pid}).`;
}

export function botStatus(): string[] {
  const owner = readOwner();
  const pid = botPid();
  return [
    pid ? `theoria bot: running (pid ${pid})` : 'theoria bot: not running',
    owner ? `Bot: @${owner.botUsername} · owner ${owner.displayName} · paired ${new Date(owner.pairedAt).toLocaleString()}` : 'Not paired: run /connect-bot in theoria.',
    owner ? `Projects: ${owner.projectsDir}` : '',
    existsSync(launchdPlist()) ? 'Starts at login (launchd).' : '',
    readSecretNames().length ? `API keys for sessions (Keychain): ${readSecretNames().join(', ')}` : '',
    config().bedrock.awsProfile ? `AWS profile for sessions: ${config().bedrock.awsProfile} (served by the bot's credential broker)` : 'Sessions use the AWS credentials of the environment the bot was started in.',
  ].filter(Boolean);
}

// ── launchd ───────────────────────────────────────────────────────────────────────────────────────────────────

const label = () => config().connectors.telegram.launchdLabel;
export const launchdPlist = () => join(homedir(), 'Library', 'LaunchAgents', `${label()}.plist`);

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The launchd agent: `theoria bot run`, kept alive, with the variables the bot needs and nothing secret. */
export function launchdPlistContent(): string {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', PI_CODING_AGENT_DIR: agentDir() };
  if (config().bedrock.awsProfile) env.AWS_PROFILE = config().bedrock.awsProfile;
  const region = bedrockRegion(env);
  if (region) env.AWS_REGION = region;
  const strings = (values: string[]) => values.map(value => `    <string>${escapeXml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${escapeXml(label())}</string>
  <key>ProgramArguments</key>
  <array>
${strings([process.execPath, cli(), 'bot', 'run'])}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>${config().connectors.telegram.backoffMaxSeconds}</integer>
  <key>StandardOutPath</key><string>${escapeXml(logFile())}</string>
  <key>StandardErrorPath</key><string>${escapeXml(logFile())}</string>
</dict>
</plist>
`;
}

export async function login(on: boolean): Promise<string> {
  const domain = `gui/${userInfo().uid}`;
  if (!on) {
    await runProgram('launchctl', ['bootout', `${domain}/${label()}`], { timeoutMs: 15_000 });
    rmSync(launchdPlist(), { force: true });
    return 'theoria bot no longer starts at login.';
  }
  if (!config().bedrock.awsProfile) {
    return 'Set bedrock.awsProfile (an SSO profile) in ~/.theoria-cli/config.json first: a bot started at login has no AWS credentials of its own.';
  }
  await stopBot();
  mkdirSync(dirname(launchdPlist()), { recursive: true });
  writeFileSync(launchdPlist(), launchdPlistContent());
  const loaded = await runProgram('launchctl', ['bootstrap', domain, launchdPlist()], { timeoutMs: 15_000 });
  return loaded.code === 0 ? `theoria bot starts at login (${launchdPlist()}).` : `launchctl refused the agent: ${loaded.stderr.trim()}`;
}

function tail(path: string, lines: number): string {
  try { return readFileSync(path, 'utf8').trim().split('\n').slice(-lines).join('\n'); } catch { return '(no log)'; }
}

/** Reads a value from the terminal without echoing it, or from stdin when it is piped. */
async function readHidden(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += String(chunk);
    return data.trim();
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise(resolve => {
    let value = '';
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString('utf8')) {
        if (char === '\r' || char === '\n') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); process.stderr.write('\n'); resolve(value.trim()); return; }
        if (char === '\u0003') { stdin.setRawMode(false); process.exit(130); }
        if (char === '\u007f') value = value.slice(0, -1); else value += char;
      }
    };
    stdin.on('data', onData);
  });
}

/** `theoria bot secret set|unset|list`: API keys for bot sessions, in the Keychain. Values are never printed. */
async function secretCli(action: string | undefined, name: string | undefined): Promise<number> {
  const names = readSecretNames();
  if (action === 'list' || !action) {
    console.log(names.length ? `Bot sessions get: ${names.join(', ')} (values in the Keychain)` : 'No API keys stored for bot sessions. theoria bot secret set ANTHROPIC_API_KEY');
    return 0;
  }
  if (!name || !isSecretName(name)) { console.error('Usage: theoria bot secret set|unset <NAME>, e.g. ANTHROPIC_API_KEY'); return 1; }
  if (action === 'set') {
    const value = await readHidden(`${name}: `);
    if (!value) { console.error('Nothing entered; nothing stored.'); return 1; }
    await saveSecret(name, value);
    writeSecretNames([...names, name]);
    console.log(`Stored ${name} in the Keychain. Bot sessions started from now on get it; theoria bot restart applies it to running ones.`);
    return 0;
  }
  if (action === 'unset') {
    await deleteSecret(name);
    writeSecretNames(names.filter(entry => entry !== name));
    console.log(`Removed ${name}.`);
    return 0;
  }
  console.error('Usage: theoria bot secret set|unset|list [NAME]');
  return 1;
}

export async function botCli(args: string[]): Promise<number> {
  const [action = 'status', option] = args;
  if (process.platform !== 'darwin') { console.error('theoria bot runs its sessions in the macOS sandbox, so it needs macOS.'); return 1; }
  switch (action) {
    case 'run': return runForeground();
    case 'start': { const result = await startBot(); console.log(result.detail); return result.ok ? 0 : 1; }
    case 'stop': console.log(await stopBot()); return 0;
    case 'restart': console.log(await stopBot()); { const result = await startBot(); console.log(result.detail); return result.ok ? 0 : 1; }
    case 'status': console.log(botStatus().join('\n')); return 0;
    case 'log': console.log(tail(logFile(), Number(option) || 40)); return 0;
    case 'secret': return secretCli(option, args[2]);
    case 'login':
      if (option !== 'on' && option !== 'off') { console.error('Usage: theoria bot login on|off'); return 1; }
      console.log(await login(option === 'on'));
      return 0;
    default:
      console.error('Usage: theoria bot start | stop | restart | status | log [lines] | run | login on|off | secret set|unset|list [NAME]');
      return 1;
  }
}
