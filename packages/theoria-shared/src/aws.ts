import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { config } from './config.ts';

/**
 * The AWS region for Bedrock. Pi's Bedrock provider reads AWS_REGION and AWS_DEFAULT_REGION but not a profile's
 * `region` in ~/.aws/config, so a profile alone fails with "Region is missing". In order: the environment, then
 * `bedrock.region`, then the `region` of the profile in use (AWS_PROFILE, else `bedrock.awsProfile`, else default).
 */
export function bedrockRegion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AWS_REGION || env.AWS_DEFAULT_REGION) return env.AWS_REGION ?? env.AWS_DEFAULT_REGION;
  if (config().bedrock.region) return config().bedrock.region;
  const profile = env.AWS_PROFILE || config().bedrock.awsProfile || 'default';
  return profileRegion(profile, env.AWS_CONFIG_FILE ?? join(homedir(), '.aws', 'config'));
}

/** `region` in the profile's section of an AWS config file: `[default]` or `[profile <name>]` (or `[<name>]`). */
export function profileRegion(profile: string, file: string): string | undefined {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return undefined; }
  const headers = profile === 'default' ? ['default', 'profile default'] : [`profile ${profile}`, profile];
  let inside = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[#;].*$/, '').trim();
    const section = /^\[(.+)\]$/.exec(line);
    if (section) { inside = headers.includes(section[1]!.trim()); continue; }
    const pair = inside ? /^region\s*=\s*(\S+)$/.exec(line) : null;
    if (pair) return pair[1];
  }
  return undefined;
}

/** Sets AWS_REGION for this process and what it starts, when it is unset and a region is known. */
export function applyBedrockRegion(env: NodeJS.ProcessEnv = process.env): void {
  if (env.AWS_REGION || env.AWS_DEFAULT_REGION) return;
  const region = bedrockRegion(env);
  if (region) env.AWS_REGION = region;
}
