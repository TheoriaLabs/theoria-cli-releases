import { VERSION, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { actionSurface, provideActions, type ActionResult } from '@theoria/shared/actions';
import { config } from '@theoria/shared/config';
import { currentProfile, loadedCommit } from '@theoria/shared/harness';
import { startingProjectType } from '@theoria/shared/project';
import {
  benchmarkUsage, cancel, compareRuns, install, launch, listText, parseRunArgs, plan, planLines, start, statusText, stoppedRuns, terminalTrialEnv, trialUsage, usageLines,
} from '../src/operations.ts';
import type { RunnerEvents } from '../src/runner.ts';
import { benchmarks } from '../src/registry.ts';
import { splitArgs } from '@theoria/pi-workflows/api';
import { findBenchmark } from '../src/registry.ts';
import { importCorpus } from '../src/compression-inputs.ts';

/**
 * /benchmark in a terminal session. A run's runner works in this process, in the background; trials report to the
 * footer and as notifications. The agent may list benchmarks and read results; starting a run (it costs money)
 * always asks you (`actions.model`).
 */
export default function bench(pi: ExtensionAPI) {
  if (actionSurface() === 'trial') return;
  let ui: ExtensionContext['ui'] | undefined;
  const cleanup = () => { ui?.setStatus('theoria-bench', undefined); };

  pi.on('session_start', (_event, ctx) => {
    cleanup();
    if (ctx.hasUI) ui = ctx.ui;
    const stopped = stoppedRuns(ctx.cwd);
    if (stopped.length && ctx.hasUI) ctx.ui.notify(`Benchmark run${stopped.length > 1 ? 's' : ''} ${stopped.map(run => run.runId).join(', ')} stopped midway. /benchmark resume continues.`, 'info');
  });
  pi.on('session_shutdown', () => cleanup());

  const events = (): RunnerEvents => ({
    progress: line => ui?.setStatus('theoria-bench', ui.theme.fg('warning', line.slice(0, 80))),
    trialFinished: trial => ui?.notify(`Benchmark ${trial.runId}: ${trial.status === 'passed' ? '✔' : trial.status === 'failed' ? '✖' : '!'} ${trial.id} ${trial.status} · ${trialUsage(trial.metrics)}${trial.metrics.reason ? `\n${trial.metrics.reason.slice(0, 120)}` : ''}`, trial.status === 'passed' ? 'info' : 'warning'),
    finished: (result, run) => {
      ui?.setStatus('theoria-bench', undefined);
      ui?.notify([`Benchmark ${run.runId} ${run.status}: ${result.passed}/${result.passed + result.failed} passed (Comparator) · ${result.errors} errors`, ...usageLines(result)].join('\n'), 'info');
    },
  });

  function harness(ctx: Pick<ExtensionContext, 'model'>) {
    const commit = loadedCommit();
    return { profile: currentProfile().name, piVersion: VERSION, ...(commit ? { theoriaCommit: commit } : {}), ...(startingProjectType() ? { projectType: startingProjectType()!.type } : {}), ...(ctx.model ? { model: `${ctx.model.provider}/${ctx.model.id}` } : {}) };
  }

  async function runCommand(args: string, ctx: Pick<ExtensionContext, 'cwd' | 'hasUI' | 'ui' | 'model' | 'modelRegistry'>, invokedBy: 'user' | 'model'): Promise<ActionResult> {
    let options;
    try { options = parseRunArgs(args, ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined, 'terminal', ctx.cwd); }
    catch (error) { return { ok: false, text: String(error) }; }
    if (!options.benchmarkId) return { ok: false, text: `Usage: ${benchmarkUsage}` };
    const slash = options.model.indexOf('/');
    if (!ctx.modelRegistry.find(options.model.slice(0, slash), options.model.slice(slash + 1))) {
      return { ok: false, text: `Model is not available: ${options.model}. Use /model to see registered models.` };
    }
    let planned;
    try { planned = await plan(options); } catch (error) { return { ok: false, text: error instanceof Error ? error.message : String(error) }; }
    const lines = planLines(planned);
    if (planned.problems.length) return { ok: false, text: lines.join('\n') };
    if (!ctx.hasUI) return { ok: false, text: 'Starting a benchmark needs your confirmation, and no one can answer here.' };
    const title = `Run ${planned.benchmark.title} on ${planned.tasks.length} task(s)?${invokedBy === 'model' ? ' (the agent asks)' : ''}`;
    if (!await ctx.ui.confirm(title, lines.join('\n'))) return { ok: false, text: 'Not started.' };
    if (planned.split === 'test' && config().benchmarks.splits.confirmTest
      && !await ctx.ui.confirm('Run on the test split?', 'Test results are for the final report only. Tuning prompts on them makes them worthless; these trials are marked sealed.')) return { ok: false, text: 'Not started.' };
    const run = start(ctx.cwd, planned, harness(ctx), planned.maxCostUsd, 'terminal', terminalTrialEnv, events());
    return { ok: true, text: `Started ${run.runId}: ${planned.tasks.length} task(s) of ${planned.benchmark.id} (${planned.split}) using ${planned.config.model}. /benchmark status shows progress.`, details: { runId: run.runId, model: planned.config.model } };
  }

  const subcommands = ['list', 'install', 'run', 'status', 'compare', 'resume', 'cancel', 'corpus'];
  pi.registerCommand('benchmark', {
    description: `Benchmarks: ${benchmarkUsage}`,
    getArgumentCompletions: prefix => [...subcommands, ...benchmarks.flatMap(benchmark => [`install ${benchmark.id}`, `run ${benchmark.id}`])]
      .filter(value => value.startsWith(prefix.trim())).map(value => ({ value, label: value })),
    handler: async (args, ctx: ExtensionCommandContext) => {
      ui = ctx.ui;
      let [action = '', ...rest] = splitArgs(args);
      if (!action && ctx.hasUI) action = (await ctx.ui.select('Benchmarks', subcommands))?.trim() ?? '';
      const tail = rest.map(token => /[\s"\\]/.test(token)
        ? `"${token.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : token).join(' ');
      switch (action) {
        case '': return;
        case 'list': ctx.ui.notify(await listText(), 'info'); return;
        case 'install': {
          const id = tail || (await ctx.ui.select('Install which benchmark?', benchmarks.map(benchmark => benchmark.id))) || '';
          if (!id) return;
          if (!await ctx.ui.confirm(`Install ${id}?`, 'Fetches the pinned source, freezes its train/val/test splits, prepares a copy-on-write clone of the matching Mathlib, and builds Comparator for its Lean version. Runs in the background.')) return;
          void install(id, line => ctx.ui.setStatus('theoria-bench', ctx.ui.theme.fg('warning', line.slice(0, 80))))
            .then(text => { ctx.ui.setStatus('theoria-bench', undefined); ui?.notify(text, 'info'); }, error => { ctx.ui.setStatus('theoria-bench', undefined); ui?.notify(error instanceof Error ? error.message : String(error), 'error'); });
          return;
        }
        case 'run': { const result = await runCommand(tail, ctx, 'user'); ctx.ui.notify(result.text, result.ok ? 'info' : 'warning'); return; }
        case 'corpus': {
          try {
            const [operation, benchmarkId, source, output] = rest;
            const benchmark = findBenchmark(benchmarkId ?? '');
            if (operation !== 'import' || !benchmark || !source || !output) throw new Error('Usage: /benchmark corpus import <benchmark> <source-directory> <manifest.json>');
            const result = importCorpus(ctx.cwd, benchmark, source, output);
            ctx.ui.notify(`Imported ${result.tasks} paths into ${result.file}. Baseline verification happens before model execution. Missing tasks: ${result.missing.join(', ') || 'none'}.`, 'info');
          } catch (error) { ctx.ui.notify(String(error), 'error'); }
          return;
        }
        case 'status': ctx.ui.notify(statusText(ctx.cwd, tail || undefined).text, 'info'); return;
        case 'compare': {
          const [first = '', second = ''] = rest;
          if (!first || !second) { ctx.ui.notify('Usage: /benchmark compare <run> <run>', 'info'); return; }
          const result = compareRuns(ctx.cwd, first, second);
          ctx.ui.notify(result.text, result.ok ? 'info' : 'warning');
          return;
        }
        case 'resume': {
          const runId = tail || stoppedRuns(ctx.cwd)[0]?.runId;
          if (!runId) { ctx.ui.notify('No benchmark run stopped midway.', 'info'); return; }
          try { launch(ctx.cwd, runId, terminalTrialEnv, events()); ctx.ui.notify(`Resuming ${runId}.`, 'info'); } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error'); }
          return;
        }
        case 'cancel': {
          const runId = tail || stoppedRuns(ctx.cwd)[0]?.runId || '';
          ctx.ui.notify(runId ? cancel(ctx.cwd, runId) : 'Name the run: /benchmark cancel run-004.', 'info');
          return;
        }
        default: ctx.ui.notify(`Usage: ${benchmarkUsage}`, 'error');
      }
    },
  });

  provideActions(pi, () => [
    { name: 'benchmark-list', usage: '/benchmark list', summary: 'The benchmarks, their splits and Lean compatibility.', execution: 'inline', run: async () => ({ ok: true, text: await listText() }) },
    { name: 'benchmark-status', usage: '/benchmark status [run]', summary: 'Results of a benchmark run, as Comparator judged them.', execution: 'inline', run: async (args, actx) => { const result = statusText(actx.cwd, args.trim() || undefined); return { ok: true, text: result.text, details: result.aggregate ?? null }; } },
    {
      name: 'benchmark-run', usage: '/benchmark run <id> [train|val|test] [N|tasks] [model=<provider>/<id>] [cost=$]', summary: 'Start a benchmark run (costs money; the user confirms).', execution: 'inline',
      promptGuidelines: ['benchmark-run accepts model=<provider>/<id> for each new run; omission uses the session model. To evaluate several models, submit one run per model with an explicit model= argument.'],
      run: async (args, actx) => runCommand(args, actx, 'model'),
    },
  ]);
}
