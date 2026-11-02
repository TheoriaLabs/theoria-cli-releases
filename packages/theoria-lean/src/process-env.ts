import { withElan } from '@theoria/shared/paths';
import { variables, type Environment } from './environment.ts';

/**
 * The agent's shell. Pi's own `bash` tool is left as it is: it builds each command's environment from this process's
 * environment when the command runs, so setting `ELAN_TOOLCHAIN` and `LEAN_PATH` here is enough for a plain `lean`
 * in the agent's shell to use the choice. Values the user had before Theoria changed them are restored when the
 * choice is cleared or no longer usable.
 */
const managed = ['ELAN_TOOLCHAIN', 'LEAN_PATH', 'PATH'] as const;
const original = new Map<string, string | undefined>();

export function applyToProcess(environment: Environment) {
  const wanted: Record<string, string> = variables(environment);
  if (Object.keys(wanted).length) wanted.PATH = withElan(original.has('PATH') ? original.get('PATH') : process.env.PATH);
  for (const key of managed) {
    if (key in wanted) {
      if (!original.has(key)) original.set(key, process.env[key]);
      process.env[key] = wanted[key];
    } else if (original.has(key)) {
      const before = original.get(key);
      if (before === undefined) delete process.env[key]; else process.env[key] = before;
      original.delete(key);
    }
  }
}
