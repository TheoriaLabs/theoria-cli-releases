import { spawn } from 'node:child_process';
import { config } from '@theoria/shared/config';
import { serveUnavailable } from './unavailable.ts';

/** How to start a server Theoria manages in this session, or why it cannot run. */
export type LaunchPlan =
  | { command: string; args: string[]; env: Record<string, string>; cwd?: string }
  | { unavailable: string };

export type Planner = (cwd: string) => Promise<LaunchPlan>;

/** The environment without the variables `sandbox.secretEnvPattern` names: the server never sees a key or token. */
export function withoutSecretVariables(env: NodeJS.ProcessEnv, pattern = config().sandbox.secretEnvPattern): Record<string, string> {
  const secret = new RegExp(pattern);
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && !secret.test(entry[0])));
}

/**
 * `theoria mcp-launch <server>`: what Pi runs for a server Theoria manages. Pi starts it in the session's folder with
 * its own environment, secrets included; this removes them, then runs the server with stdin and stdout passed
 * through, or answers as a server with no tools when it cannot run here. Resolves with the exit code.
 */
export async function launchServer(name: string | undefined, planners: Record<string, Planner>): Promise<number> {
  const planner = name ? planners[name] : undefined;
  if (!name || !planner) {
    process.stderr.write(`theoria ${config().mcp.launchSubcommand}: unknown server "${name ?? ''}"; known: ${Object.keys(planners).join(', ')}.\n`);
    return 2;
  }
  let plan: LaunchPlan;
  try { plan = await planner(process.cwd()); } catch (error) { plan = { unavailable: error instanceof Error ? error.message : String(error) }; }
  if ('unavailable' in plan) {
    process.stderr.write(`${name}: unavailable: ${plan.unavailable}\n`);
    await serveUnavailable(name, plan.unavailable);
    return 0;
  }
  const child = spawn(plan.command, plan.args, {
    cwd: plan.cwd ?? process.cwd(),
    env: { ...withoutSecretVariables(process.env), ...plan.env },
    stdio: 'inherit',
  });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => child.kill(signal));
  return new Promise(resolve => {
    child.on('error', error => { process.stderr.write(`${name}: ${error.message}\n`); resolve(1); });
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
