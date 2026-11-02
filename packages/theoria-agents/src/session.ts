import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { config, shippedConfigPath } from '@theoria/shared/config';
import { activeComponents, findProfile, harnessEnv, subagentEnv } from '@theoria/shared/harness';
import { agentDir, theoriaAgentEnv } from '@theoria/shared/paths';
import { isolatedGitEnv } from '@theoria/shared/process';
import { prepareSessionPiDir, botSessionEnv } from '@theoria/pi-telegram/session';
import { sandboxExec, writeSandboxProfile } from '@theoria/pi-telegram/sandbox';
import { RpcSession } from './rpc-session.ts';

export interface SubagentLaunch {
  cwd: string; scratch: string; piName: string; model: string; thinking: string; harness: string;
  mode: 'read' | 'write'; env: NodeJS.ProcessEnv;
}
export function subagentTools(harness: string, mode: SubagentLaunch['mode']) {
  const components = activeComponents({ [harnessEnv]: harness, [subagentEnv]: '1' });
  const tools = ['read', 'grep', 'find', 'ls', 'bash'];
  if (mode === 'write') tools.push('write', 'edit', ...(components.has('lean') ? ['lean_check'] : []));
  if (components.has('mcp')) tools.push(...(findProfile(harness)?.trialTools ?? []).filter(tool => tool.startsWith('mcp__')));
  return tools;
}
export class SubagentSession extends RpcSession {
  readonly options: SubagentLaunch;
  constructor(options: SubagentLaunch) { super(); this.options = options; }
  start(): Promise<void> {
    const o = this.options;
    const piDir = prepareSessionPiDir(o.piName);
    mkdirSync(join(o.scratch, 'session'), { recursive: true }); mkdirSync(join(o.scratch, 'tmp'), { recursive: true });
    mkdirSync(join(o.scratch, 'inputs'), { recursive: true });
    const configFile = join(o.scratch, 'inputs/theoria.config.json');
    writeFileSync(configFile, JSON.stringify(config()));
    writeFileSync(join(piDir, config().goals.settingsFile), JSON.stringify({ disabled: true }));
    const profile = writeSandboxProfile({ project: o.mode === 'write' ? o.cwd : o.scratch, projectsDir: o.cwd, piDir: o.piName,
      mathlib: o.mode === 'read' ? [o.cwd] : [], experiment: o.mode === 'read' });
    const env = isolatedGitEnv({ ...o.env, PI_CODING_AGENT_DIR: piDir, [theoriaAgentEnv]: agentDir(), [harnessEnv]: o.harness,
      [subagentEnv]: '1', [botSessionEnv]: '1', THEORIA_CONFIG: configFile, PI_OFFLINE: '1', TMPDIR: join(o.scratch, 'tmp') });
    delete env.THEORIA_TRIAL;
    return this.launch(sandboxExec, ['-f', profile, process.execPath, join(dirname(shippedConfigPath()), 'bin/theoria.js'),
      '--mode', 'rpc', '--session-dir', join(o.scratch, 'session'), '--model', o.model, '--thinking', o.thinking,
      '--tools', subagentTools(o.harness, o.mode).join(','), '--no-skills', '--no-context-files', '--no-approve'], {
      cwd: o.cwd, env,
    }, config().subagents.startupTimeoutSeconds * 1000, config().subagents.rpcTimeoutSeconds * 1000);
  }
}
