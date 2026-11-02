import { existsSync, mkdirSync, renameSync, rmSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@theoria/shared/config';
import { managedMathlibDir } from '@theoria/shared/paths';
import { lastLines, minutes, run, runWithTemp, seconds } from '@theoria/shared/process';
import { compareVersions, isBuilt, partialSuffix } from './discovery.ts';

const settings = () => config().lean.install;

const gibibyte = 1024 ** 3;

/** Space one installed Mathlib takes (`lean.install.expectedGigabytes`): checkout, dependencies and build cache. */
export const expectedBytes = () => settings().expectedGigabytes * gibibyte;

export const gigabytes = (bytes: number) => `${(bytes / gibibyte).toFixed(1)} GB`;

export interface Progress { onProgress: (step: string) => void; signal?: AbortSignal }

/** Published Mathlib releases, newest first. Each tag names the Lean version it pins. */
export async function releases(): Promise<string[]> {
  const { repository, tagPattern, listTimeoutSeconds, errorChars } = settings();
  const listed = await run('git', ['ls-remote', '--tags', '--refs', repository, tagPattern], { timeoutMs: seconds(listTimeoutSeconds) });
  if (listed.code !== 0) throw new Error(`Could not list Mathlib releases: ${(listed.stderr || 'git failed').trim().slice(0, errorChars)}`);
  return listed.stdout.split('\n')
    .map(line => line.split('refs/tags/')[1]?.trim())
    .filter((tag): tag is string => !!tag && /^v\d+\.\d+\.\d+(-rc\d+)?$/.test(tag))
    .sort((a, b) => compareVersions(b, a));
}

export function freeBytes(): number | undefined {
  try {
    mkdirSync(managedMathlibDir(), { recursive: true });
    const stats = statfsSync(managedMathlibDir());
    return stats.bavail * stats.bsize;
  } catch { return undefined; }
}

export const installedPath = (version: string) => join(managedMathlibDir(), version);

class StepFailed extends Error {}

/** Reports a step's progress from its output, one line at a time and only when the line changes. */
function progressLines(version: string, options: Progress, accept: (line: string) => boolean = () => true) {
  let last = '';
  return (line: string) => {
    if (line === last || !accept(line)) return;
    last = line;
    options.onProgress(`${version}: ${line.slice(0, settings().progressChars)}`);
  };
}

/**
 * Installs one Mathlib release into Theoria's directory.
 *
 * A shallow clone at the tag, then `lake exe cache get`, which downloads Mathlib's prebuilt files instead of
 * compiling them (elan installs the Lean version the tag pins on the way), then `lake build` for anything the cache
 * did not cover, which is normally nothing. The work happens in a `.partial` directory renamed only on success, so a
 * failed or cancelled install leaves nothing that looks installed, and it is deleted.
 */
export async function install(version: string, options: Progress): Promise<string> {
  const target = installedPath(version);
  if (existsSync(target)) return target;
  const partial = `${target}${partialSuffix}`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(managedMathlibDir(), { recursive: true });
  const { repository, cloneTimeoutMinutes, cacheTimeoutMinutes } = settings();
  try {
    options.onProgress(`cloning Mathlib ${version}`);
    await step(`Cloning Mathlib ${version}`, options, run('git', ['clone', '--depth', '1', '--branch', version, '--single-branch', repository, partial], {
      timeoutMs: minutes(cloneTimeoutMinutes), signal: options.signal,
    }));
    options.onProgress(`downloading Lean and Mathlib's build cache for ${version}`);
    await step(`Downloading Mathlib ${version}'s build cache`, options, runWithTemp('lake', ['exe', 'cache', 'get'], {
      cwd: partial, timeoutMs: minutes(cacheTimeoutMinutes), signal: options.signal, onLine: progressLines(version, options),
    }));
    await build(partial, version, options);
    renameSync(partial, target);
    return target;
  } catch (error) {
    rmSync(partial, { recursive: true, force: true });
    throw error;
  }
}

/** Awaits one step and turns a cancellation or a failure into a readable error. */
async function step(name: string, options: Progress, running: ReturnType<typeof run>) {
  const result = await running;
  if (options.signal?.aborted) throw new StepFailed('The install was cancelled.');
  if (result.code !== 0) {
    const last = lastLines(`${result.stdout}\n${result.stderr}`, settings().errorChars, settings().errorLines);
    throw new StepFailed(`${name} failed${last ? `: ${last}` : '.'}`);
  }
  return result;
}

/**
 * Makes sure the checkout is fully built, compiling only what the cache did not supply.
 *
 * `lake build --no-build` checks every target without compiling anything, about 7 s for a complete Mathlib. Only if
 * it reports something out of date does a real `lake build` run, and it then compiles just those files. Throws when
 * the checkout ends up unusable. Returns whether anything was compiled.
 */
export async function build(dir: string, version: string, options: Progress): Promise<{ compiled: boolean }> {
  const { verifyTimeoutMinutes, buildTimeoutMinutes } = settings();
  options.onProgress(`checking Mathlib ${version} is fully built`);
  const checked = await runWithTemp('lake', ['build', '--no-build'], { cwd: dir, timeoutMs: minutes(verifyTimeoutMinutes), signal: options.signal });
  if (options.signal?.aborted) throw new StepFailed('The install was cancelled.');
  const compiled = checked.code !== 0;
  if (compiled) {
    options.onProgress(`${version}: the cache missed some files; compiling them with lake build`);
    await step(`Building Mathlib ${version}`, options, runWithTemp('lake', ['build'], {
      cwd: dir, timeoutMs: minutes(buildTimeoutMinutes), signal: options.signal,
      onLine: progressLines(version, options, line => /^[✔⣿✖]?\s*\[\d+\/\d+\]/.test(line)),
    }));
  }
  if (!isBuilt(dir)) throw new StepFailed(`Building Mathlib ${version} finished without Mathlib.olean, so the checkout is not usable.`);
  return { compiled };
}

export function remove(version: string) {
  rmSync(installedPath(version), { recursive: true, force: true });
}
