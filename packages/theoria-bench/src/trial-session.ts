import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { trialEnv } from '@theoria/shared/actions';
import { config, shippedConfigPath } from '@theoria/shared/config';
import { findProfile, harnessEnv } from '@theoria/shared/harness';
import { agentDir, theoriaAgentEnv } from '@theoria/shared/paths';
import { sandboxExec, writeSandboxProfile } from '@theoria/pi-telegram/sandbox';
import { botSessionEnv, prepareSessionPiDir } from '@theoria/pi-telegram/session';
import { isolatedGitEnv } from '@theoria/shared/process';
import { RpcSession } from '@theoria/pi-agents/rpc';
import { hermeticLeanEnv } from './env.ts';
export type { RpcEvent } from '@theoria/pi-agents/rpc';

/** Benchmark-specific launch policy around the shared child-process transport. */
export class TrialSession extends RpcSession {
  readonly workspace: string;
  readonly model: string;
  readonly env: NodeJS.ProcessEnv;
  readonly harness: string;
  readonly thinking: string;
  readonly isolation?: { piDir: string };
  readonly readOnly: string[];
  constructor(workspace: string, model: string, env: NodeJS.ProcessEnv, harness: string, thinking: string, isolation?: { piDir: string }, readOnly: string[] = []) {
    super();
    this.workspace = workspace; this.model = model; this.env = env;
    this.harness = harness; this.thinking = thinking; this.isolation = isolation;
    this.readOnly = readOnly;
  }
  start(): Promise<void> {
    const piName = this.isolation?.piDir ?? config().benchmarks.trialPiDir;
    const piDir = prepareSessionPiDir(piName);
    writeFileSync(join(piDir, config().goals.settingsFile), `${JSON.stringify({ disabled: true, maxAutonomousRuns: config().benchmarks.escalation.maxAutonomousRuns }, null, 2)}\n`, { mode: 0o600 });
    const profile = writeSandboxProfile({ project: this.workspace, projectsDir: this.workspace, mathlib: [], piDir: piName, experiment: !!this.isolation, readOnly: this.readOnly });
    if (this.isolation) {
      mkdirSync(join(this.workspace, '.tmp'), { recursive: true }); mkdirSync(join(this.workspace, 'inputs'), { recursive: true });
      writeFileSync(join(this.workspace, 'inputs/theoria.config.json'), JSON.stringify(config()));
    }
    const cli = join(dirname(shippedConfigPath()), 'bin', 'theoria.js');
    mkdirSync(join(this.workspace, '.pi', 'goals'), { recursive: true });
    const sessionDir = join(this.workspace, 'session'); mkdirSync(sessionDir, { recursive: true });
    return this.launch(sandboxExec, ['-f', profile, process.execPath, cli, '--mode', 'rpc', '--session-dir', sessionDir, '--model', this.model, '--thinking', this.thinking,
      '--tools', (findProfile(this.harness)?.trialTools ?? []).join(','), '--no-skills', '--no-context-files', '--no-approve'], {
      cwd: this.workspace,
      env: { ...hermeticLeanEnv(this.isolation ? isolatedGitEnv(this.env) : this.env), ...(this.isolation ? { THEORIA_CONFIG: join(this.workspace, 'inputs/theoria.config.json'), TMPDIR: join(this.workspace, '.tmp'), PI_OFFLINE: '1' } : {}),
        PI_CODING_AGENT_DIR: piDir, [theoriaAgentEnv]: agentDir(), [botSessionEnv]: '1', [trialEnv]: '1', [harnessEnv]: this.harness },
    }, config().benchmarks.workerStartupTimeoutSeconds * 1000, this.isolation ? config().benchmarks.workerRpcTimeoutSeconds * 1000 : 0);
  }
}
