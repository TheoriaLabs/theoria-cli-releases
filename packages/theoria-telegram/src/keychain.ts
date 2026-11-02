import { config } from '@theoria/shared/config';
import { run, seconds } from '@theoria/shared/process';

/**
 * The bot token in the macOS Keychain (`connectors.telegram.keychainService` / `keychainAccount`), through the
 * `security` tool. It is never written to a file or to the configuration. Sessions `theoria bot` starts cannot run
 * `security` (`sandbox.denyExec`), so a sandboxed agent cannot read it back.
 */

const timeoutMs = () => seconds(config().lean.discovery.gitTimeoutSeconds);
const ids = () => ['-s', config().connectors.telegram.keychainService, '-a', config().connectors.telegram.keychainAccount];

export async function readToken(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const result = await run('/usr/bin/security', ['find-generic-password', ...ids(), '-w'], { timeoutMs: timeoutMs() });
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

export async function saveToken(token: string): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('The Telegram connector keeps its token in the macOS Keychain, so it needs macOS.');
  const result = await run('/usr/bin/security', ['add-generic-password', '-U', ...ids(), '-l', 'Theoria Telegram bot', '-w', token], { timeoutMs: timeoutMs() });
  if (result.code !== 0) throw new Error(`The Keychain refused the token: ${result.stderr.trim() || `security exited with ${result.code}`}`);
}

export async function deleteToken(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  return (await run('/usr/bin/security', ['delete-generic-password', ...ids()], { timeoutMs: timeoutMs() })).code === 0;
}

/** A bot token looks like `123456789:AA…`. Checked before anything is stored or sent. */
export const looksLikeToken = (token: string) => /^\d{5,15}:[A-Za-z0-9_-]{30,}$/.test(token.trim());

// ── API keys for bot sessions ─────────────────────────────────────────────────────────────────────────────────

/**
 * Environment variables for bot sessions (e.g. `ANTHROPIC_API_KEY`), kept in the Keychain under the same service with
 * account `connectors.telegram.secretAccountPrefix` + name. Only their names are written down, in the connector's
 * state directory, so the bot knows which to load; a session started at login has no shell environment of its own.
 */
const secretIds = (name: string) => ['-s', config().connectors.telegram.keychainService, '-a', `${config().connectors.telegram.secretAccountPrefix}${name}`];
export const isSecretName = (name: string) => /^[A-Z][A-Z0-9_]{1,80}$/.test(name);

export async function readSecret(name: string): Promise<string | undefined> {
  if (process.platform !== 'darwin' || !isSecretName(name)) return undefined;
  const result = await run('/usr/bin/security', ['find-generic-password', ...secretIds(name), '-w'], { timeoutMs: timeoutMs() });
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

export async function saveSecret(name: string, value: string): Promise<void> {
  if (!isSecretName(name)) throw new Error(`${name} is not an environment variable name.`);
  const result = await run('/usr/bin/security', ['add-generic-password', '-U', ...secretIds(name), '-l', `Theoria bot ${name}`, '-w', value], { timeoutMs: timeoutMs() });
  if (result.code !== 0) throw new Error(`The Keychain refused ${name}: ${result.stderr.trim() || `security exited with ${result.code}`}`);
}

export async function deleteSecret(name: string): Promise<boolean> {
  return (await run('/usr/bin/security', ['delete-generic-password', ...secretIds(name)], { timeoutMs: timeoutMs() })).code === 0;
}
