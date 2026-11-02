import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { config, expandHome } from '@theoria/shared/config';
import { currentProfile, findProfile } from '@theoria/shared/harness';
import { resolveCompressionSkill, sourceHash, splitArgs } from '@theoria/pi-workflows/api';
import { prepareCompressionInputs, findBenchmark, splitsFor, type CorpusManifest } from '@theoria/pi-bench/backend';
import type { CampaignManifest } from './campaign-store.ts';

export const campaignUsage = '/autoresearch start <benchmark> [objective="..." corpus=<manifest> skill=<path>,<path>|none skip-verification=true models=provider/model,... workers=6 budget=<USD> minutes=<N> experiments=<N> decisions=<N> cost=<USD> timeout=<minutes> turns=<N>] (omitted resource limits are unlimited)';

export function planCampaign(cwd: string, args: string, parentModel: string, parentThinking = 'medium'): CampaignManifest {
  const [benchmarkId, ...tokens] = splitArgs(args);
  const values: Record<string, string> = {};
  const known = ['corpus', 'skill', 'budget', 'minutes', 'models', 'workers', 'experiments', 'decisions', 'cost', 'timeout', 'turns', 'objective', 'harness', 'thinking', 'development', 'skip-verification'];
  for (const token of tokens) {
    const equal = token.indexOf('='); const key = token.slice(0, equal);
    if (equal < 1 || !known.includes(key) || values[key] !== undefined || !token.slice(equal + 1).trim()) throw new Error(`Invalid or duplicate campaign argument: ${token}. ${campaignUsage}`);
    values[key] = token.slice(equal + 1);
  }
  const benchmark = findBenchmark(benchmarkId ?? '');
  if (!benchmark?.installed()) throw new Error('Benchmark is unknown or not installed.');
  const corpusPath = values.corpus ?? benchmark.compressionCorpus?.();
  if (!corpusPath) throw new Error('This benchmark has no default proof corpus; provide corpus=<manifest>.');
  const settings = config().benchmarks; const defaults = config().autoresearch;
  const number = (key: string, max = Infinity, integer = false) => {
    if (values[key] === undefined) return undefined;
    const n = Number(values[key]);
    if (!Number.isFinite(n) || n <= 0 || n > max || (integer && !Number.isSafeInteger(n))) throw new Error(`Invalid campaign ${key}.`);
    return n;
  };
  const models = (values.models ?? parentModel).split(',');
  if (!models.length || models.some(model => !/^[\w.-]+\/\S+$/.test(model)) || new Set(models).size !== models.length) throw new Error('models must be distinct provider/model IDs.');
  const development = (values.development ?? 'train,val').split(',');
  if (development.some(split => !['train', 'val'].includes(split))) throw new Error('Campaign development must be train and/or val; held-out test is not available to research.');
  const assignments = splitsFor(benchmark);
  const corpus = JSON.parse(readFileSync(resolve(cwd, expandHome(corpusPath)), 'utf8')) as CorpusManifest;
  if (corpus.schemaVersion !== 1 || corpus.benchmarkId !== benchmark.id || !corpus.tasks) throw new Error('Invalid campaign corpus.');
  const all = benchmark.listTasks();
  for (const id of Object.keys(corpus.tasks)) if (!all.some(task => task.id === id)) throw new Error(`Unknown corpus task ${id}.`);
  const tasks = all.filter(task => corpus.tasks[task.id] && development.includes(assignments[task.id]!));
  if (!tasks.length) throw new Error('No development tasks selected.');
  const selectors = values.skill?.split(',').map(path => path.trim());
  if (selectors?.some(path => !path) || (selectors?.includes('none') && selectors.length !== 1)) throw new Error('Use skill=<path>,<path> or skill=none on its own.');
  const paths = selectors?.map(path => path === 'none' ? path : realpathSync(resolve(cwd, expandHome(path))));
  if (paths && new Set(paths).size !== paths.length) throw new Error('Starting skill paths must be distinct.');
  if (values['skip-verification'] !== undefined && !['true', 'false'].includes(values['skip-verification'])) throw new Error('skip-verification must be true or false.');
  const skipVerification = values['skip-verification'] === 'true';
  const inputs = prepareCompressionInputs(cwd, benchmark, tasks, { corpus: expandHome(corpusPath), ...(paths ? { skill: paths[0] } : {}), rounds: settings.compression.rounds, skipVerification });
  const additionalSkills = paths?.slice(1).map(path => resolveCompressionSkill(cwd, path)) ?? [];
  if (new Set([inputs.skill, ...additionalSkills].map(skill => skill.sha256)).size !== additionalSkills.length + 1)
    throw new Error('Starting skills must have distinct contents.');
  const budget = number('budget'); const minutes = number('minutes');
  if (budget !== undefined && budget <= defaults.reportReserveUsd) throw new Error('Campaign budget must exceed the final-report reserve.');
  const harness = values.harness ?? currentProfile().name;
  if (!findProfile(harness)) throw new Error(`Unknown harness ${harness}.`);
  const thinking = values.thinking ?? settings.defaults.thinking;
  if (!['minimal', 'low', 'medium', 'high', 'xhigh'].includes(thinking)) throw new Error('Invalid thinking level.');
  const text = readFileSync(fileURLToPath(new URL('../prompts/default.md', import.meta.url)), 'utf8');
  return {
    schemaVersion: 1, objective: values.objective ?? 'Improve the compression skill with measured, generalizable changes.',
    methodology: { name: 'default', text, sha256: sourceHash(text) }, inputs,
    ...(additionalSkills.length ? { additionalSkills } : {}),
    splits: Object.fromEntries(tasks.map(task => [task.id, assignments[task.id]!])), models, parentModel, parentThinking,
    config: { ...settings.defaults, model: models[0]!, harness, thinking, mode: 'compress', ...(skipVerification ? { skipVerification } : {}),
      maxCostUsd: number('cost') ?? null, maxTurns: number('turns', Infinity, true) ?? null,
      timeoutMinutes: number('timeout', settings.limits.timeoutMinutes.max) ?? null },
    budget, minutes, workers: number('workers', settings.limits.concurrency.max, true) ?? defaults.workers,
    maxExperiments: number('experiments', 1000, true),
    maxDecisions: number('decisions', Infinity, true), parentTurnCostUsd: defaults.parentTurnCostUsd, parentTurnMaxResponses: defaults.parentTurnMaxResponses,
    reportReserveUsd: defaults.reportReserveUsd, evidenceChars: defaults.evidenceChars,
    artifactPageBytes: defaults.artifactPageBytes,
    minFreeMemoryMiB: defaults.minFreeMemoryMiB, minFreeDiskMiB: defaults.minFreeDiskMiB,
    literatureTimeoutSeconds: defaults.literatureTimeoutSeconds, literatureMaxBytes: defaults.literatureMaxBytes, literatureMaxRequests: defaults.literatureMaxRequests,
  };
}
