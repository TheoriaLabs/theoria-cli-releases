import { existsSync, mkdirSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { config, expandHome, shippedConfigPath } from '@theoria/shared/config';
import { sourceHash, loadDefaultPrompt, resolveCompressionSkill } from '@theoria/pi-workflows/api';
import { writeJson } from '@theoria/pi-research/api';
import type { Benchmark, BenchmarkTask } from './types.ts';
import type { CompressionInputs, CompressionRequest, CorpusManifest } from './compression-types.ts';
import { validatePromptAppend } from './prompt.ts';

/** A content fingerprint, including dirty source changes; old experiment resumes cannot silently change code. */
export function executionHash(): string {
  const root = dirname(shippedConfigPath());
  const contents: string[] = [];
  const walk = (path: string) => {
    for (const name of readdirSync(path).sort()) {
      if (['node_modules', 'test', '.git', 'dist'].includes(name)) continue;
      const file = join(path, name);
      const stat = lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile() && /\.(ts|js|json|md)$/.test(name)) contents.push(`${relative(root, file)}\0${readFileSync(file, 'utf8')}`);
    }
  };
  walk(join(root, 'packages')); walk(join(root, 'bin'));
  contents.push(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  return sourceHash(contents.join('\0'));
}

export function prepareCompressionInputs(cwd: string, benchmark: Benchmark, tasks: BenchmarkTask[], request: CompressionRequest): CompressionInputs {
  validatePromptAppend(request.promptAppend);
  if (request.skipVerification !== undefined && typeof request.skipVerification !== 'boolean') throw new Error('skip-verification must be true or false.');
  const corpusFile = resolve(cwd, request.corpus);
  const corpus = JSON.parse(readFileSync(corpusFile, 'utf8')) as CorpusManifest;
  if (corpus.schemaVersion !== 1 || corpus.benchmarkId !== benchmark.id || !corpus.tasks) throw new Error('Corpus manifest must have schemaVersion 1 and the matching benchmarkId.');
  if (!Number.isSafeInteger(request.rounds) || request.rounds < 1) throw new Error('Compression rounds must be a positive integer.');
  const skill = resolveCompressionSkill(cwd, request.skill);
  const entries = tasks.map(task => {
    const entry = corpus.tasks[task.id];
    if (!entry || typeof entry.file !== 'string') throw new Error(`Corpus has no baseline for ${task.id}.`);
    const source = readFileSync(resolve(dirname(corpusFile), entry.file), 'utf8');
    return { task, source, sha256: sourceHash(source), ...(entry.theorem ? { theorem: entry.theorem } : {}) };
  });
  const prompt = loadDefaultPrompt('compress');
  prompt.settings.allowedAxioms = [];
  const policy = structuredClone(config().workflows.compression);
  policy.compatibilityProjects = policy.compatibilityProjects.map((path: string) => resolve(cwd, expandHome(path))) as typeof policy.compatibilityProjects;
  return { schemaVersion: 1, benchmarkId: benchmark.id, benchmarkVersion: benchmark.version, codeHash: executionHash(),
    lean: corpus.lean ?? benchmark.lean(), policy, prompt,
    skill, rounds: request.rounds, tasks: entries,
    ...(request.skipVerification ? { skipVerification: true } : {}),
    ...(request.promptAppend !== undefined ? { promptAppend: request.promptAppend } : {}) };
}

export const inputHash = (inputs: CompressionInputs) => sourceHash(JSON.stringify(inputs));
export function readCompressionInputs(file: string, hash: string): CompressionInputs {
  const inputs = JSON.parse(readFileSync(file, 'utf8')) as CompressionInputs;
  if (inputHash(inputs) !== hash || inputs.schemaVersion !== 1) throw new Error('Frozen compression inputs were modified.');
  if (inputs.codeHash !== executionHash()) throw new Error('Compression execution code changed; restore the recorded code before resuming.');
  return inputs;
}

/** Import paths only; proof validation runs during preparation, before any model is called. */
export function importCorpus(cwd: string, benchmark: Benchmark, source: string, output: string): { file: string; tasks: number; missing: string[] } {
  const root = resolve(cwd, source);
  const file = resolve(cwd, output);
  if (existsSync(file)) throw new Error(`Corpus manifest already exists: ${file}`);
  const tasks: CorpusManifest['tasks'] = {};
  const missing: string[] = [];
  const latest = new Map<string, { id: string; taskId: string; status: string }>();
  if (existsSync(join(root, 'trials.jsonl'))) {
    for (const line of readFileSync(join(root, 'trials.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      const trial = JSON.parse(line); latest.set(trial.id, trial);
    }
  }
  for (const task of benchmark.listTasks()) {
    const successful = [...latest.values()].filter(trial => trial.taskId === task.id && trial.status === 'passed').sort((a, b) => a.id.localeCompare(b.id));
    const candidates = [join(root, task.id, 'Solution.lean'), ...successful.map(trial => join(root, 'trials', trial.id.replace(/[^\w.-]/g, '_'), 'Solution.lean'))];
    if (!latest.size) candidates.push(join(root, 'trials', task.id, 'Solution.lean'));
    const proof = candidates.find(existsSync);
    if (proof) tasks[task.id] = { file: relative(dirname(file), proof) };
    else missing.push(task.id);
  }
  if (!Object.keys(tasks).length) throw new Error('No baseline proof files were found in the source directory.');
  mkdirSync(dirname(file), { recursive: true });
  writeJson(file, { schemaVersion: 1, benchmarkId: benchmark.id, tasks });
  return { file, tasks: Object.keys(tasks).length, missing };
}
