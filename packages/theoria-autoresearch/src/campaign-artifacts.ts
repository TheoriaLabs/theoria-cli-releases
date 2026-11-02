import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { config } from '@theoria/shared/config';
import { benchRunDir, readBenchRun, trialDir, trials } from '@theoria/pi-bench/backend';
import type { CampaignManifest, CampaignState } from './campaign-store.ts';

const integer = (name: string, value: number, minimum: number) => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be an integer >= ${minimum}.`);
};

/** Resolve only host-selected artifacts; reject symlinked runs, trials, directories and files. */
function scoped(root: string, path: string) {
  const local = relative(root, path);
  if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) throw new Error('Artifact path escapes its authorized root.');
  let current = root;
  for (const part of local.split(sep)) {
    current = join(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error('Campaign artifacts cannot be symlinks.');
  }
  return current;
}

function authorizedTrial(cwd: string, state: CampaignState, manifest: CampaignManifest, jobId: string, taskId: string, replicate: number) {
  integer('replicate', replicate, 1);
  const job = state.jobs.find(job => job.id === jobId);
  if (!job || !['train', 'val'].includes(job.split) || !job.taskIds.includes(taskId)
    || manifest.splits[taskId] !== job.split || !manifest.inputs.tasks.some(entry => entry.task.id === taskId))
    throw new Error('Read artifacts only for an authorized development job and task.');
  if (!job.runId || !/^run-\d+$/.test(job.runId)) throw new Error('This job has no recorded benchmark run.');
  if (replicate > job.repeat) throw new Error('Replicate is outside this job.');
  const root = realpathSync(dirname(benchRunDir(cwd, job.runId)));
  const runRoot = join(root, job.runId);
  scoped(root, join(runRoot, 'benchmark.json'));
  scoped(root, join(runRoot, 'trials.jsonl'));
  const run = readBenchRun(cwd, job.runId);
  if (!run || run.runId !== job.runId || run.benchmarkId !== manifest.inputs.benchmarkId || run.benchmarkVersion !== manifest.inputs.benchmarkVersion
    || run.sealed || run.split !== job.split || run.config.mode !== 'compress' || run.config.model !== job.model
    || run.config.repetitions !== job.repeat || run.taskIds.length !== job.taskIds.length || job.taskIds.some(id => !run.taskIds.includes(id)))
    throw new Error('Recorded run does not match the authorized development job.');
  const matches = trials(cwd, job.runId).filter(trial => trial.taskId === taskId && trial.replicate === replicate);
  const trial = matches[0];
  if (matches.length !== 1 || !trial || trial.sealed || trial.split !== job.split || trial.runId !== job.runId || !run.trialIds.includes(trial.id))
    throw new Error('No matching authorized development trial.');
  return { root, runRoot, job, trial, trialRoot: join(runRoot, 'trials', basename(trialDir(cwd, job.runId, trial.id))), runId: job.runId,
    pageBytes: manifest.artifactPageBytes ?? config().autoresearch.artifactPageBytes };
}

/** Byte cursors traverse ordered files, one file per page, without splitting UTF-8 characters. */
function readPage({ root, runRoot, pageBytes }: ReturnType<typeof authorizedTrial>, files: string[], cursor: number) {
  integer('cursor', cursor, 0);
  integer('artifactPageBytes', pageBytes, 4);
  if (!files.length) throw new Error('No recorded artifact files are available.');
  const entries = files.map(path => {
    const file = scoped(root, path), stat = lstatSync(file);
    if (!stat.isFile()) throw new Error('Campaign artifacts must be regular files.');
    return { file, size: stat.size };
  });
  const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (cursor > totalBytes) throw new Error('Cursor is beyond the end of this artifact.');
  let offset = cursor, entry = entries.at(-1)!;
  for (const candidate of entries) {
    entry = candidate;
    if (offset < entry.size) break;
    offset -= entry.size;
  }
  const file = relative(runRoot, entry.file);
  if (cursor === totalBytes) return { file, cursor, nextCursor: null, totalBytes, pageBytes, text: '' };
  const fd = openSync(entry.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== entry.size) throw new Error('Artifact changed while being read.');
    const buffer = Buffer.alloc(Math.min(pageBytes, entry.size - offset));
    const count = readSync(fd, buffer, 0, buffer.length, offset);
    if (count !== buffer.length) throw new Error('Artifact changed while being read.');
    if ((buffer[0]! & 0xc0) === 0x80) throw new Error('Cursor must be at a UTF-8 character boundary.');
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer, { stream: offset + count < entry.size });
    const next = cursor + Buffer.byteLength(text);
    return { file, cursor, nextCursor: next < totalBytes ? next : null, totalBytes, pageBytes, text };
  } finally { closeSync(fd); }
}

export function readTrajectory(cwd: string, state: CampaignState, manifest: CampaignManifest,
  jobId: string, taskId: string, attempt = 1, cursor = 0, replicate = 1) {
  integer('attempt', attempt, 1);
  const target = authorizedTrial(cwd, state, manifest, jobId, taskId, replicate);
  if (attempt > (target.trial.attempt ?? 1)) throw new Error('Worker attempt is not recorded.');
  if (target.trial.status === 'running' && attempt === (target.trial.attempt ?? 1)) throw new Error('Wait for this worker attempt to finish before reading its trajectory.');
  const directory = scoped(target.root, join(target.trialRoot, `attempt-${attempt}`, 'session'));
  const files = readdirSync(directory).filter(name => name.endsWith('.jsonl')).sort().map(name => join(directory, name));
  return { jobId, taskId, runId: target.runId, replicate, attempt, format: 'raw-jsonl',
    ...readPage(target, files, cursor) };
}

export function readCandidate(cwd: string, state: CampaignState, manifest: CampaignManifest,
  jobId: string, taskId: string, round = 0, attempt = 0, cursor = 0, replicate = 1) {
  integer('round', round, 0); integer('attempt', attempt, round === 0 ? 0 : 1);
  if (round === 0 && attempt !== 0) throw new Error('Read the baseline with round=0 and attempt=0.');
  const target = authorizedTrial(cwd, state, manifest, jobId, taskId, replicate);
  if (target.trial.status === 'running') throw new Error('Wait for the trial to finish before reading its candidates.');
  if (round > target.job.rounds) throw new Error('Round is outside this job.');
  const directory = join(target.trialRoot, 'compression');
  const report = JSON.parse(readFileSync(scoped(target.root, join(directory, 'report.json')), 'utf8'));
  const recorded = round === 0 ? { baseline: true, sourceHash: report.baseline.sourceHash }
    : report.attempts.find((entry: { round: number; attempt: number }) => entry.round === round && entry.attempt === attempt);
  if (!recorded) throw new Error('Candidate is not recorded in this trial.');
  const file = join(directory, round === 0 ? 'baseline.lean' : `round-${round}-attempt-${attempt}.lean`);
  return { jobId, taskId, runId: target.runId, replicate, round, attempt, format: 'lean-source',
    recordedVerdict: round === 0 ? recorded : { accepted: recorded.accepted, verified: recorded.verified, sourceHash: recorded.measurement?.sourceHash },
    ...readPage(target, [file], cursor) };
}
