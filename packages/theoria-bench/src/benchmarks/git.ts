import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { lastLines, run, seconds } from '@theoria/shared/process';

/** A pinned source: cloned once at exactly `commit`, never updated in place. Nothing in it is run. */
export const sourceAt = (dir: string, commit: string) => existsSync(join(dir, '.git')) && spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() === commit;

export async function cloneAt(repo: string, commit: string, dir: string, onLine?: (line: string) => void) {
  if (sourceAt(dir, commit)) return;
  onLine?.(`Fetching ${repo} at ${commit.slice(0, 12)}…`);
  const steps: [string, string[]][] = [
    ['git', ['init', '-q', dir]],
    ['git', ['-C', dir, 'remote', 'add', 'origin', repo]],
    ['git', ['-C', dir, 'fetch', '-q', '--depth=1', 'origin', commit]],
    ['git', ['-C', dir, 'checkout', '-q', '--detach', 'FETCH_HEAD']],
  ];
  for (const [command, args] of steps) {
    const result = await run(command, args, { timeoutMs: seconds(600) });
    if (result.code !== 0 && !(args.includes('remote') && /already exists/.test(result.stderr))) throw new Error(`${command} ${args.slice(2).join(' ')} failed: ${lastLines(result.stderr, 300, 3)}`);
  }
  if (!sourceAt(dir, commit)) throw new Error(`${dir} is not at ${commit} after fetching.`);
}
