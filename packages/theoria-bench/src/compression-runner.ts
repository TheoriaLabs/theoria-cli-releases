import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { config } from '@theoria/shared/config';
import { appendRunEvent } from '@theoria/shared/events';
import { limit, storedLimit } from '@theoria/shared/limits';
import { keepAwake } from '@theoria/shared/process';
import { setStatus, appendJsonl } from '@theoria/pi-research/api';
import { writeSandboxProfile } from '@theoria/pi-telegram/sandbox';
import { prepareCompression, checkCompressedFile, compressionRounds, compressionDetails, sourceHash, withCompressSkill, compressionSkillLabel,
  type CompressionBaseline, type CompressionHost } from '@theoria/pi-workflows/api';
import type { Environment } from '@theoria/pi-lean/api';
import { ExperimentAgent } from './experiment-agent.ts';
import { readCompressionInputs } from './compression-inputs.ts';
import { ensureEnv, makeLakeProject, type ExtraWorkspace } from './env.ts';
import { buildComparator, judge } from './comparator.ts';
import { aggregate, benchRunDir, cancelRequested, readBenchRun, saveTrial, trialDir, trials, writeBenchRun, type Aggregate } from './store.ts';
import { trialExtra, type RunnerEvents } from './runner.ts';
import type { BenchmarkRun, BenchmarkTrial } from './types.ts';
import type { CompressionInputs } from './compression-types.ts';
import { cleanupAfterRun } from './cleanup.ts';
import { appendPrompt } from './prompt.ts';
import { appendContext, stageContext, verifyContextSnapshot } from './context.ts';

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
function gateEnvironment(root: string, inputs: CompressionInputs, mathlib?: string, extra?: ExtraWorkspace): Environment {
  makeLakeProject(root, inputs.lean, mathlib, { name: 'compression_check', libs: ['Solution'], ...(extra ? { extra } : {}) });
  mkdirSync(join(root, '.tmp'), { recursive: true });
  return { source: 'lean-project', projectRoot: root, toolchain: inputs.lean.toolchain, checkTmpDir: join(root, '.tmp'),
    sandboxProfile: writeSandboxProfile({ project: root, projectsDir: root, mathlib: [], experiment: true }) };
}

/** Keeps old proving execution untouched; only explicitly marked compression runs use this driver. */
export async function runCompressionBenchmark(cwd: string, initial: BenchmarkRun, sessionEnv: () => Promise<NodeJS.ProcessEnv>,
  events: RunnerEvents, signal: AbortSignal,
  createWorker: (...args: ConstructorParameters<typeof ExperimentAgent>) => Pick<ExperimentAgent, 'metrics' | 'start' | 'turn' | 'stop' | 'session'> = (...args) => new ExperimentAgent(...args)): Promise<Aggregate> {
  const notify = (line: string) => {
    try { events.progress?.(line); } catch { /* A closed UI must not interrupt the runner. */ }
  };
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) controller.abort();
  let run: BenchmarkRun = { ...initial, status: 'running', problem: undefined,
    startedAt: initial.startedAt ?? new Date().toISOString(), runner: { pid: process.pid, heartbeatAt: new Date().toISOString(), startedAt: new Date().toISOString() } };
  const started = Date.now();
  const release = keepAwake(config().benchmarks.awake.preventSleep, notify);
  const progress = (stage: NonNullable<BenchmarkRun['progress']>['stage'], completed: number, taskId?: string, check?: 'lean' | 'comparator') => {
    run.progress = { stage, completed, total: run.taskIds.length, taskId, check, at: new Date().toISOString() };
    writeBenchRun(cwd, run);
    notify(stage === 'baselines' ? `Baselines ${completed}/${run.taskIds.length} ${run.config.skipVerification ? 'prepared' : 'verified'}${taskId ? ` · ${taskId}: ${check}` : ''}` : `Compression: ${stage}`);
  };
  progress('preparing', 0);
  const heartbeat = setInterval(() => {
    if (cancelRequested(cwd, run.runId)) controller.abort();
    run.runner!.heartbeatAt = new Date().toISOString(); writeBenchRun(cwd, run);
  }, config().benchmarks.heartbeatSeconds * 1000);
  const baselines = new Map<string, { baseline: CompressionBaseline; environment: Environment }>();
  try {
    const inputs = readCompressionInputs(join(benchRunDir(cwd, initial.runId), 'inputs/compression.json'), initial.config.compression!.inputHash);
    if (!!inputs.skipVerification !== !!initial.config.skipVerification) throw new Error('Frozen baseline verification policy does not match this run.');
    if (inputs.contextHash !== initial.config.context?.sha256) throw new Error('Frozen compression context does not match this run.');
    verifyContextSnapshot(benchRunDir(cwd, run.runId), run.config.context);
    const prepared = await ensureEnv(inputs.lean, notify);
    if (!prepared.ready) throw new Error(prepared.reason);
    const extra = trialExtra(run, inputs.lean);
    await buildComparator(inputs.lean.toolchain, notify);
    // All inputs validate before the first paid worker starts. Every check is in a private, fresh workspace.
    for (const entry of inputs.tasks) {
      if (controller.signal.aborted) break;
      const root = join(benchRunDir(cwd, run.runId), 'evals', 'baselines', entry.task.id, 'gate');
      const environment = gateEnvironment(root, inputs, prepared.mathlib, extra);
      const file = join(root, 'Solution.lean'); writeFileSync(file, entry.source);
      progress('baselines', baselines.size, entry.task.id, 'lean');
      const result = await prepareCompression(environment, { cwd: root, file, before: entry.source, theorem: entry.theorem,
        allowedAxioms: [], timeoutSeconds: inputs.prompt.settings.timeoutSeconds, signal: controller.signal, policy: inputs.policy,
        skipVerification: inputs.skipVerification, cacheRoot: cwd,
        cacheIdentity: JSON.stringify({ lean: inputs.lean, codeHash: inputs.codeHash, harness: run.config.harness, extra }) });
      if (!result.baseline) throw new Error(`Invalid baseline ${entry.task.id}: ${result.verdict.diagnostics}`);
      if (!inputs.skipVerification) {
        progress('baselines', baselines.size, entry.task.id, 'comparator');
        const checked = await judge(join(root, '..', 'baseline-judge'), inputs.lean, prepared.mathlib, entry.task, entry.source, extra, controller.signal);
        if (checked.verdict !== 'passed') throw new Error(`Baseline ${entry.task.id}: ${checked.reason}`);
      }
      baselines.set(entry.task.id, { baseline: result.baseline, environment });
      progress('baselines', baselines.size);
    }
    for (const trial of trials(cwd, run.runId).filter(trial => trial.status === 'running')) {
      if (trial.workerPid && alive(trial.workerPid)) throw new Error(`Worker ${trial.workerPid} may still own ${trial.id}; stop it before resuming.`);
      // A lost request can have unreported billing. Conservatively charge its outstanding reservation.
      saveTrial(cwd, { ...trial, status: 'queued', workerPid: undefined, reservedUsd: 0,
        previousAttempts: [...trial.previousAttempts ?? [], { ...trial.metrics, costUsd: (trial.metrics.costUsd ?? 0) + (trial.reservedUsd ?? 0), reason: 'Interrupted worker; outstanding reservation charged conservatively.' }], metrics: {} });
    }
    progress('trials', baselines.size);
    const claimed = new Set<string>();
    const workers = Array.from({ length: run.config.concurrency }, async () => {
      for (;;) {
        if (controller.signal.aborted) return;
        const all = trials(cwd, run.runId);
        const spent = all.reduce((total, trial) => total + (trial.metrics.costUsd ?? 0) + (trial.previousAttempts ?? []).reduce((sum, m) => sum + (m.costUsd ?? 0), 0), 0);
        const reserved = all.reduce((total, trial) => total + (trial.reservedUsd ?? 0), 0);
        const trial = all.find(trial => trial.status === 'queued' && !claimed.has(trial.id));
        if (!trial) return;
        const prior = (trial.previousAttempts ?? []).reduce((sum, metric) => sum + (metric.costUsd ?? 0), 0);
        const allowance = Math.min(limit(run.config.maxCostUsd) - prior, limit(run.maxTotalCostUsd) - spent - reserved);
        if (allowance <= 0) { run.problem = 'Compression budget exhausted.'; return; }
        claimed.add(trial.id);
        let current: BenchmarkTrial = saveTrial(cwd, { ...trial, status: 'running', reservedUsd: Number.isFinite(allowance) ? allowance : 0, attempt: (trial.attempt ?? 0) + 1, startedAt: new Date().toISOString(), completedAt: undefined,
          activity: undefined, progress: { stage: 'starting', at: new Date().toISOString() } });
        const trialProgress = (value: Omit<NonNullable<BenchmarkTrial['progress']>, 'at'>) => {
          current = saveTrial(cwd, { ...current, progress: { ...value, at: new Date().toISOString() } });
        };
        const entry = inputs.tasks.find(entry => entry.task.id === trial.taskId)!;
        const root = trialDir(cwd, run.runId, trial.id);
        const workspace = join(root, `attempt-${current.attempt}`);
        let activeAgent: ReturnType<typeof createWorker> | undefined;
        try {
        makeLakeProject(workspace, inputs.lean, prepared.mathlib, { name: 'compression_trial', libs: ['Solution'], ...(extra ? { extra } : {}) });
        const file = join(workspace, 'Solution.lean'); writeFileSync(file, entry.source);
        const readOnly = stageContext(benchRunDir(cwd, run.runId), workspace, run.config.context);
        const preflight = baselines.get(trial.taskId)!;
        const checkRoot = join(root, `evaluation-${current.attempt}`);
        const environment = gateEnvironment(checkRoot, inputs, prepared.mathlib, extra);
        const gate = { environment, baseline: { ...preflight.baseline,
          input: { ...preflight.baseline.input, cwd: checkRoot, file: join(checkRoot, 'Solution.lean') } } };
        const agent = createWorker(workspace, run.config.model, await sessionEnv(), run.config.harness, run.config.thinking,
          { ...run.config, maxCostUsd: storedLimit(allowance) }, controller.signal, `experiment-pi/${sourceHash(`${cwd}/${run.runId}/${trial.id}/${current.attempt}`).slice(0, 20)}`,
          metrics => { current = saveTrial(cwd, { ...current, metrics: { ...metrics }, reservedUsd: Number.isFinite(allowance) ? Math.max(0, allowance - metrics.costUsd) : 0 }); },
          activity => { current = saveTrial(cwd, { ...current, activity }); }, readOnly);
        activeAgent = agent;
        events.trialStarted?.(current);
          await agent.start();
          current = saveTrial(cwd, { ...current, workerPid: agent.session.pid });
          let evaluation = 0;
          const host: CompressionHost<{ cwd: string }> = {
            signal: controller.signal, shown: (ctx, path) => relative(ctx.cwd, path), status: (_ctx, text) => text && notify(`${trial.id}: ${text}`),
            turn: (_ctx, text) => agent.turn(appendPrompt(appendContext(text, run.config.context), inputs.promptAppend)), promptNote: () => `Skill ${compressionSkillLabel(inputs.skill)}`,
            baseVars: (_environment, prompt, attempt, diagnostics) => ({ lean: inputs.lean.toolchain, attempt, max_attempts: prompt.settings.maxAttempts, diagnostics, retry: attempt > 1 }),
            progressCard: (title, lines, details) => appendJsonl(join(root, 'events.jsonl'), { at: new Date().toISOString(), title, lines, details }),
            card: (title, lines, details) => appendJsonl(join(root, 'events.jsonl'), { at: new Date().toISOString(), title, lines, details }),
          };
          const details = compressionDetails(gate.baseline);
          const result = await compressionRounds(host, { cwd: workspace }, withCompressSkill(inputs.prompt, inputs.skill.text), gate.environment,
            { ...gate.baseline, input: { ...gate.baseline.input, file } }, inputs.rounds, 'balanced', {
              request: '', statement: '', whole_file: !entry.theorem, theorems: details.theorems.join(', '), target_count: details.targetCount,
              theorems_json: JSON.stringify(entry.task.theorems), baseline_lines: gate.baseline.lines,
            }, { verification: 'comparator', directory: join(root, 'compression'), key: initial.config.compression!.inputHash, resume: current.attempt! > 1, skill: inputs.skill,
              onProgress: trialProgress,
              evaluate: async (source, best) => {
                writeFileSync(gate.baseline.input.file, source);
                return checkCompressedFile(gate.environment, gate.baseline, best, async source => {
                  trialProgress({ ...current.progress!, stage: 'judging' });
                  const checked = await judge(join(root, 'judgements', String(++evaluation)), inputs.lean, prepared.mathlib, entry.task, source, extra, controller.signal);
                  return { ok: checked.verdict === 'passed', summary: checked.reason, diagnostics: checked.log,
                    details: { outcome: checked.verdict === 'passed' ? 'verified' : checked.verdict === 'unavailable' ? 'unavailable' : 'rejected' } };
                });
              } });
          writeFileSync(join(root, 'Solution.lean'), result.source);
          const compression = { improved: result.improved, verified: true, compress_score: Number(result.details.compress_score),
            baseline: gate.baseline.measurement, best: result.measurement, report: relative(benchRunDir(cwd, run.runId), result.reportPath), reason: result.reason };
          const retry = result.interrupted && !controller.signal.aborted && current.errors < run.config.retries && agent.metrics.costUsd < allowance;
          current = saveTrial(cwd, { ...current, workerPid: undefined, reservedUsd: 0, status: controller.signal.aborted ? 'cancelled' : retry ? 'queued' : result.interrupted ? 'error' : result.improved ? 'passed' : 'failed',
            errors: current.errors + (result.interrupted ? 1 : 0), metrics: { ...agent.metrics, compression }, completedAt: new Date().toISOString(),
            ...(retry ? { previousAttempts: [...current.previousAttempts ?? [], { ...agent.metrics }], metrics: {} } : {}) });
          if (retry) claimed.delete(trial.id);
        } catch (error) {
          const metrics = { ...activeAgent?.metrics, reason: String(error) };
          const retry = !controller.signal.aborted && current.errors < run.config.retries && (metrics.costUsd ?? 0) < allowance;
          current = saveTrial(cwd, { ...current, status: controller.signal.aborted ? 'cancelled' : 'error', workerPid: undefined, reservedUsd: 0,
            errors: current.errors + 1, metrics, completedAt: new Date().toISOString(),
            ...(retry ? { status: 'queued', previousAttempts: [...current.previousAttempts ?? [], metrics], metrics: {} } : {}) });
          if (retry) claimed.delete(trial.id);
        } finally { await activeAgent?.stop(); trialProgress({ ...current.progress!, stage: 'finished' }); }
        events.trialFinished?.(current);
      }
    });
    try { await Promise.all(workers); }
    catch (error) { controller.abort(); await Promise.allSettled(workers); throw error; }
  } catch (error) {
    run.problem = error instanceof Error ? error.message : String(error);
    appendRunEvent(cwd, run.runId, 'benchmark.error', { reason: run.problem });
    notify(`Benchmark run ${run.runId} stopped: ${run.problem}`);
  }
  finally { clearInterval(heartbeat); signal.removeEventListener('abort', abort); release(); }
  const cancelled = controller.signal.aborted || cancelRequested(cwd, run.runId);
  if (cancelled) for (const trial of trials(cwd, run.runId).filter(trial => ['queued', 'running'].includes(trial.status))) saveTrial(cwd, { ...trial, status: 'cancelled', reservedUsd: 0 });
  const pending = trials(cwd, run.runId).some(trial => ['queued', 'running'].includes(trial.status));
  run = { ...run, status: cancelled ? 'cancelled' : pending ? 'queued' : 'completed', runner: undefined, wallClockMs: (initial.wallClockMs ?? 0) + Date.now() - started };
  run.progress = { ...run.progress!, stage: 'finished', at: new Date().toISOString() };
  writeBenchRun(cwd, run);
  if (run.status !== 'queued') setStatus(cwd, run.runId, cancelled ? 'cancelled' : 'completed');
  cleanupAfterRun(cwd, run.runId, notify);
  const result = aggregate(cwd, run); events.finished?.(result, run); return result;
}
