import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@theoria/shared/config';
import { agentDir } from '@theoria/shared/paths';

/**
 * The connector's files, under `<agent dir>/<connectors.telegram.stateDir>/`. Each has one writer, so the terminal
 * and the bot process never race on the same file:
 * - `owner.json`, written by the bot when a pairing succeeds: the bot and the one Telegram account it obeys.
 * - `pairing.json`, written by `/connect-bot`, consumed (deleted) by the bot: a one-time code with an expiry.
 * - `bot.json`, written by the bot: the update offset and the selected project.
 * - `bot.pid`, `bot.log`: the running bot process.
 */

export interface Owner {
  botId: number;
  botUsername: string;
  userId: number;
  chatId: number;
  displayName: string;
  /** The projects folder this bot serves, as a real path. Telegram reaches nothing outside it. */
  projectsDir: string;
  pairedAt: string;
}

export interface Pairing { code: string; expiresAt: string; botUsername: string; projectsDir: string }

export interface BotState {
  offset: number;
  /** The selected project, as a folder name inside the projects folder. */
  selected?: string;
}

export const stateDir = () => join(agentDir(), config().connectors.telegram.stateDir);
export const statePath = (name: string) => join(stateDir(), name);

function readJson<T>(name: string): T | undefined {
  try { return JSON.parse(readFileSync(statePath(name), 'utf8')) as T; } catch { return undefined; }
}

/** Written to a temporary file and renamed, so a reader never sees half a file. Readable by this user only. */
function writeJson(name: string, value: unknown) {
  mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const temp = statePath(`${name}.${process.pid}.tmp`);
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, statePath(name));
}

export const readOwner = () => readJson<Owner>('owner.json');
export const writeOwner = (owner: Owner) => writeJson('owner.json', owner);
export const deleteOwner = () => rmSync(statePath('owner.json'), { force: true });

export const readPairing = () => readJson<Pairing>('pairing.json');
export const deletePairing = () => rmSync(statePath('pairing.json'), { force: true });

/** A new one-time pairing code, valid for `connectors.telegram.pairingMinutes`. */
export function createPairing(botUsername: string, projectsDir: string): Pairing {
  const pairing: Pairing = {
    code: randomBytes(12).toString('base64url'),
    expiresAt: new Date(Date.now() + config().connectors.telegram.pairingMinutes * 60_000).toISOString(),
    botUsername, projectsDir,
  };
  writeJson('pairing.json', pairing);
  return pairing;
}

/**
 * Takes a pairing code from `/start <code>`: valid only if it matches the pending pairing exactly and has not
 * expired. A valid code is consumed, so it works once.
 */
export function consumePairing(code: string): Pairing | undefined {
  const pending = readPairing();
  if (!pending || !code || code !== pending.code) return undefined;
  deletePairing();
  return Date.parse(pending.expiresAt) > Date.now() ? pending : undefined;
}

export const readBotState = (): BotState => ({ offset: 0, ...readJson<BotState>('bot.json') });
export const writeBotState = (state: BotState) => writeJson('bot.json', state);

/** Names (never values) of the Keychain-held variables bot sessions get. */
export const readSecretNames = () => readJson<string[]>('secrets.json') ?? [];
export const writeSecretNames = (names: string[]) => writeJson('secrets.json', [...new Set(names)].sort());

export const pairingLink = (botUsername: string, code: string) => `https://t.me/${botUsername}?start=${code}`;
