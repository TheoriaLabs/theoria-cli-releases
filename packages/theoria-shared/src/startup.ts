import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pi lists the loaded extensions, skills and context files at startup by their file names (`actions.ts, bench.ts,
 * src, …`), which says nothing useful about Theoria. Pi's own `quietStartup: "header"` setting hides that listing and
 * keeps the header (Theoria replaces it with its own); errors and conflicts are still shown, and `theoria --verbose`
 * shows the listing. Theoria sets it once in its own Pi settings, only when the user has not chosen a value; `/settings`
 * changes it back. Returns whether the file was changed.
 */
export function defaultQuietStartup(agentDir: string): boolean {
  const file = join(agentDir, 'settings.json');
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>; }
  catch (error) {
    // An unreadable or hand-broken settings file is Pi's to report; never overwrite it.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings) || 'quietStartup' in settings) return false;
  mkdirSync(agentDir, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...settings, quietStartup: 'header' }, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
  return true;
}
