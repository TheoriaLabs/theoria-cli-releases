import { config as theoriaConfig, loadConfig, reloadConfig, userConfigPath } from '@theoria/shared/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IconMode } from './icons.ts';

/**
 * The interface's settings: `tui` in Theoria's configuration (validated with the rest of it), not a file of its own.
 * The settings dialog (/tui) saves what it changes to the user config file.
 */

export type SettingsLanguage = 'en' | 'zh';
export type CursorStyle = 'block' | 'bar' | 'underline';
export type ThinkingPeekLines = 0 | 1 | 2;
export type { IconMode } from './icons.ts';

export interface FooterSegments {
  projectName: boolean; cwd: boolean; hostname: boolean; sessionName: boolean; gitBranch: boolean; gitStatus: boolean; gitCommit: boolean;
  runtime: boolean; context: boolean; tokens: boolean; cost: boolean; extensionStatuses: boolean; capitalizeProviderName: boolean;
}
export interface TelemetryConfig { enabled: boolean; tps: boolean; ttft: boolean; duration: boolean; tokens: boolean; stalls: boolean; cost: boolean }
export interface ThinkingPeekConfig { lines: ThinkingPeekLines }

export interface OpenTuiConfig {
  enabled: boolean;
  inlineFooter: boolean;
  settingsLanguage: SettingsLanguage;
  cursorStyle: CursorStyle;
  icons: { mode: IconMode };
  footerSegments: FooterSegments;
  telemetry: TelemetryConfig;
  thinkingPeek: ThinkingPeekConfig;
}

const fields = ['enabled', 'inlineFooter', 'settingsLanguage', 'cursorStyle', 'icons', 'footerSegments', 'telemetry', 'thinkingPeek'] as const;
const pick = (tui: Record<string, unknown>): OpenTuiConfig => structuredClone(Object.fromEntries(fields.map(key => [key, tui[key]]))) as unknown as OpenTuiConfig;

export const DEFAULT_CONFIG: OpenTuiConfig = pick(loadConfig({ override: undefined }).tui as unknown as Record<string, unknown>);

export function loadTuiConfig(): OpenTuiConfig {
  return pick(theoriaConfig().tui as unknown as Record<string, unknown>);
}

/** Saves the dialog's settings into the user config, checked as a whole first; a refused change is not written. */
export function saveTuiConfig(next: OpenTuiConfig): string | undefined {
  const path = userConfigPath();
  let user: Record<string, unknown> = {};
  try { if (existsSync(path)) user = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>; } catch (error) { return `${path}: ${String(error)}`; }
  const updated = { ...user, tui: { ...(user.tui as Record<string, unknown> | undefined), ...next } };
  try { loadConfig({ override: updated }); } catch (error) { return error instanceof Error ? error.message : String(error); }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
  reloadConfig();
  return undefined;
}
