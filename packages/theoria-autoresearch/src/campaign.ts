import { readFileSync, realpathSync, readdirSync, statfsSync, writeFileSync } from 'node:fs';
import { freemem, loadavg } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { sourceHash } from '@theoria/pi-workflows/api';
import { nextId, writeJson } from '@theoria/pi-research/api';
import { keepAwake } from '@theoria/shared/process';
import { config } from '@theoria/shared/config';
import { limit, showLimit, storedLimit } from '@theoria/shared/limits';
import { executionHash, runCompressionBenchmark, createBenchmarkRun, findBenchmark, aggregate,
  readBenchRun, saveTrial, trials, StatusReader, type Plan, type RunnerEvents, type BenchmarkRun } from '@theoria/pi-bench/backend';
import { campaignAlive, campaignBudget, campaignDir, campaignManifest, readCampaign, updateCampaign,
  type CampaignJob, type CampaignManifest, type CampaignState } from './campaign-store.ts';
import { campaignResults, campaignSelection, collectCampaignEvidence } from './campaign-evidence.ts';
import { fetchLiterature, literatureQueryUrl, type LiteratureResponse } from './campaign-literature.ts';
import { readCandidate, readTrajectory } from './campaign-artifacts.ts';

export interface ExperimentRequest { skill: string; model: string; split?: string; tasks?: string[]; repeat?: number; rounds?: number; workers?: number }
export interface CampaignServices {
  research: (prompt: string, budget: number, signal: AbortSignal, onSpend: (spent: number) => void) => Promise<{ costUsd: number; aborted?: boolean; error?: string }>;
  evaluate?: (run: BenchmarkRun, signal: AbortSignal, events: RunnerEvents) => ReturnType<typeof runCompressionBenchmark>;
  resources?: () => { load: number; freeMemoryMiB: number; freeDiskMiB: number };
  evidence?: typeof collectCampaignEvidence;
  literature?: typeof fetchLiterature;
  notify?: (message: string) => void;
}

/** In-session campaign authority. The model proposes jobs; this controller owns dispatch and accounting. */
export class Campaign {
  readonly cwd: string;
  readonly id: string;
  readonly manifest: CampaignManifest;
  private services: CampaignServices;
  private env: () => Promise<NodeJS.ProcessEnv>;
  private workers = new AbortController();
  private parent?: AbortController;
  private stopping?: { phase: 'paused' | 'cancelled'; reason: string };
  private started = 0;
  private initialElapsed = 0;
  private lastLiterature = 0;
  private reader = new StatusReader();
  constructor(cwd: string, id: string, services: CampaignServices, env: () => Promise<NodeJS.ProcessEnv>) {
    this.cwd = cwd; this.id = id; this.services = services; this.env = env;
    this.manifest = campaignManifest(cwd, readCampaign(cwd, id));
  }
  get state() { return readCampaign(this.cwd, this.id); }
  private update(type: string, change: (state: CampaignState) => void) { return updateCampaign(this.cwd, this.id, type, change); }
  private assertResearch() {
    const state = this.state;
    if (state.owner !== process.pid || state.phase !== 'researching' || this.stopping) throw new Error('No active authorized research turn.');
    if (this.elapsed() >= limit(this.manifest.minutes) * 60000) throw new Error('Campaign time limit reached.');
    return state;
  }
  private elapsed() { return this.initialElapsed + Math.max(0, Date.now() - this.started); }
  private skill(id: string) {
    const entry = this.state.skills.find(skill => skill.id === id);
    if (!entry) throw new Error(`Unknown campaign skill ${id}.`);
    const text = readFileSync(join(campaignDir(this.cwd, this.id), entry.file), 'utf8');
    if (sourceHash(text) !== entry.sha256) throw new Error(`Immutable skill ${id} changed.`);
    return { entry, text };
  }
  stageSkill(parent: string, text: string, rationale: string, evidence: string[] = []) {
    const state = this.assertResearch(); this.skill(parent);
    if (!text.trim() || text.length > 200000 || !rationale.trim()) throw new Error('Supply a nonempty complete skill (at most 200,000 characters) and rationale.');
    if (evidence.some(id => !state.jobs.some(job => job.id === id) && !state.sources.some(source => source.id === id))) throw new Error('Evidence must reference campaign job or literature IDs.');
    const sha256 = sourceHash(text);
    const duplicate = state.skills.find(skill => skill.parent === parent && skill.sha256 === sha256);
    if (duplicate) return duplicate;
    let staged!: CampaignState['skills'][number];
    this.update('skill.staged', current => {
      const dir = campaignDir(this.cwd, this.id);
      const id = nextId('v', readdirSync(join(dir, 'skills')).map(name => name.replace(/\.md$/, '')), 3);
      staged = { id, parent, sha256, file: `skills/${id}.md`, rationale, evidence };
      writeFileSync(join(dir, staged.file), text, { flag: 'wx' }); current.skills.push(staged);
    });
    return staged;
  }
  submit(requestId: string, requests: ExperimentRequest[], hypothesis: string) {
    const state = this.assertResearch();
    if (!/^[\w.-]{1,80}$/.test(requestId) || !hypothesis.trim() || !requests.length) throw new Error('Supply a unique request_id, hypothesis, and nonempty experiments.');
    const normalized = requests.map(request => {
      this.skill(request.skill);
      if (!this.manifest.models.includes(request.model)) throw new Error(`Model ${request.model} is not authorized.`);
      const split = request.split ?? (Object.values(this.manifest.splits).includes('train') ? 'train' : 'val');
      if (!['train', 'val'].includes(split)) throw new Error('Only development splits are available.');
      const tasks = request.tasks ?? Object.keys(this.manifest.splits).filter(task => this.manifest.splits[task] === split);
      if (!tasks.length || new Set(tasks).size !== tasks.length || tasks.some(task => this.manifest.splits[task] !== split)) throw new Error('Tasks must be distinct authorized members of the requested split.');
      const repeat = request.repeat ?? 1, rounds = request.rounds ?? this.manifest.inputs.rounds, workers = request.workers ?? Math.min(2, this.manifest.workers);
      if (![repeat, rounds, workers].every(value => Number.isSafeInteger(value) && value > 0) || repeat > 100 || rounds > 20 || workers > this.manifest.workers) throw new Error('Invalid repeat (1–100), rounds (1–20), or workers.');
      return { skill: request.skill, model: request.model, split, taskIds: [...tasks].sort(), repeat, rounds, workers };
    });
    const signature = sourceHash(JSON.stringify({ normalized, hypothesis }));
    const previous = state.jobs.filter(job => job.requestId.startsWith(`${requestId}:`));
    if (previous.length) {
      if (previous.length !== requests.length || previous.some(job => job.requestId !== `${requestId}:${signature}`)) throw new Error('request_id was already used for a different batch.');
      return previous;
    }
    const budget = campaignBudget(state);
    const available = limit(this.manifest.budget) - budget.spent - budget.reserved - this.manifest.reportReserveUsd;
    // A finite campaign budget also bounds jobs without a per-trial cap.
    const cost = this.manifest.config.maxCostUsd;
    const allowances = normalized.map(job => cost === null ? available / normalized.length : job.taskIds.length * job.repeat * cost);
    if (state.jobs.length + requests.length > limit(this.manifest.maxExperiments)) throw new Error('Campaign experiment limit reached.');
    if (allowances.some(amount => amount <= 0) || allowances.reduce((sum, amount) => sum + amount, 0) > available + 1e-9)
      throw new Error('Batch exceeds remaining campaign budget, including reservations and final-report reserve.');
    const jobs: CampaignJob[] = [];
    this.update('batch.submitted', current => {
      for (const [index, request] of normalized.entries()) {
        const job: CampaignJob = { ...request, id: nextId('job-', current.jobs.map(job => job.id), 3), requestId: `${requestId}:${signature}`,
          hypothesis, status: 'queued', allowance: storedLimit(allowances[index]!), spent: 0 };
        current.jobs.push(job); jobs.push(job);
      }
    });
    return jobs;
  }
  results() { return { state: this.state, budget: campaignBudget(this.state), jobs: campaignResults(this.cwd, this.state) }; }
  readTrajectory(jobId: string, taskId: string, attempt = 1, cursor = 0, replicate = 1) {
    return readTrajectory(this.cwd, this.state, this.manifest, jobId, taskId, attempt, cursor, replicate);
  }
  readCandidate(jobId: string, taskId: string, round = 0, attempt = 0, cursor = 0, replicate = 1) {
    return readCandidate(this.cwd, this.state, this.manifest, jobId, taskId, round, attempt, cursor, replicate);
  }
  readEvidence(path: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !/^(skills\/v\d+\.md|evidence\/[\w.-]+\.json|literature\/[\w.-]+\.txt|methodology\.md)$/.test(path)) throw new Error('Read a campaign skill, evidence packet, or literature file with a nonnegative character offset.');
    const root = realpathSync(campaignDir(this.cwd, this.id)); const file = realpathSync(join(root, path));
    const rel = relative(root, file);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../')) throw new Error('Evidence path escapes campaign.');
    const text = readFileSync(file, 'utf8');
    return { path, offset, totalCharacters: text.length, text: text.slice(offset, offset + 20000), nextOffset: offset + 20000 < text.length ? offset + 20000 : null };
  }
  async literature(queryOrUrl: string, search: boolean) {
    this.assertResearch();
    if (this.state.literatureRequests >= this.manifest.literatureMaxRequests) throw new Error('Campaign literature request limit reached.');
    this.update('literature.requested', state => { state.literatureRequests++; });
    const delay = 3000 - (Date.now() - this.lastLiterature);
    if (delay > 0) await new Promise<void>((resolve, reject) => {
      const signal = this.parent!.signal;
      const abort = () => { clearTimeout(timer); reject(new Error('Literature request cancelled.')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, delay);
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
    this.lastLiterature = Date.now();
    const response: LiteratureResponse = await (this.services.literature ?? fetchLiterature)(search ? literatureQueryUrl(queryOrUrl) : queryOrUrl,
      this.manifest.literatureTimeoutSeconds, this.manifest.literatureMaxBytes, this.parent?.signal);
    this.assertResearch();
    let source!: CampaignState['sources'][number];
    this.update('literature.saved', state => {
      const id = nextId('paper-', state.sources.map(source => source.id), 3);
      const text = `${response.url}\n${response.truncated ? '[truncated source]\n' : ''}${response.text}`;
      source = { id, url: response.url, file: `literature/${id}.txt`, sha256: sourceHash(text), retrievedAt: new Date().toISOString() };
      writeFileSync(join(campaignDir(this.cwd, this.id), source.file), text, { flag: 'wx' }); state.sources.push(source);
    });
    return { ...source, ...this.readEvidence(source.file) };
  }
  finish(skill: string, summary: string) {
    const state = this.assertResearch(); this.skill(skill);
    if (!summary.trim()) throw new Error('A final summary is required.');
    if (state.jobs.some(job => ['queued', 'running', 'paused'].includes(job.status))) throw new Error('Complete or cancel outstanding experiments before finishing.');
    const selection = campaignSelection(this.cwd, state, this.manifest, skill);
    this.update('campaign.finished', current => { current.selectedSkill = skill; current.summary = summary; current.phase = 'completed'; });
    return selection;
  }
  stop(phase: 'paused' | 'cancelled', reason: string, interrupt = phase === 'cancelled') {
    this.stopping = { phase, reason }; this.parent?.abort(); if (interrupt) this.workers.abort();
    this.update(`campaign.${phase}`, state => {
      state.phase = phase; state.reason = reason;
      if (phase === 'cancelled') for (const job of state.jobs) if (job.status === 'queued' || job.status === 'paused') job.status = 'cancelled';
    });
  }
  private resourceSnapshot() {
    const disk = statfsSync(campaignDir(this.cwd, this.id));
    return this.services.resources?.() ?? { load: loadavg()[0]!, freeMemoryMiB: freemem() / 1048576, freeDiskMiB: disk.bavail * disk.bsize / 1048576 };
  }
  private checkResources() {
    const snapshot = this.resourceSnapshot();
    this.update('resources.sampled', state => { state.resources = { ...snapshot, at: new Date().toISOString() }; });
    if (snapshot.freeMemoryMiB < this.manifest.minFreeMemoryMiB || snapshot.freeDiskMiB < this.manifest.minFreeDiskMiB) throw new Error('Insufficient free memory or disk; campaign paused before dispatch.');
  }
  private checkFunds() {
    this.refreshSpending();
    const budget = campaignBudget(this.state);
    if (budget.spent + budget.reserved > limit(this.manifest.budget) + 1e-9) throw new Error('Reported spending and reservations exceed the campaign budget; no further dispatch.');
  }
  private refreshSpending() {
    const costs = this.state.jobs.filter(job => job.status === 'running' && job.runId)
      .map(job => ({ id: job.id, cost: this.reader.run(this.cwd, job.runId!)?.aggregate.costUsd }));
    if (!costs.length) return;
    this.update('experiments.usage', state => {
      for (const entry of costs) if (entry.cost !== undefined) {
        const job = state.jobs.find(job => job.id === entry.id)!; job.spent = Math.max(job.spent, entry.cost);
      }
    });
  }
  private async evaluate(job: CampaignJob) {
    let run = job.runId ? readBenchRun(this.cwd, job.runId) : undefined;
    if (run) {
      if (run.runner?.pid && run.runner.pid !== process.pid && campaignAlive(run.runner.pid)) throw new Error(`Run ${run.runId} is still owned by a live runner.`);
      for (const trial of trials(this.cwd, run.runId)) {
        if (trial.workerPid && campaignAlive(trial.workerPid)) throw new Error(`Trial ${trial.id} still has a live worker.`);
        if (trial.status === 'cancelled') saveTrial(this.cwd, { ...trial, status: 'queued', reservedUsd: 0,
          previousAttempts: [...trial.previousAttempts ?? [], trial.metrics], metrics: {}, workerPid: undefined });
      }
      if (run.status === 'completed') {
        const result = aggregate(this.cwd, run);
        this.update('experiment.reconciled', state => {
          const current = state.jobs.find(entry => entry.id === job.id)!;
          current.spent = result.costUsd; current.status = 'completed';
        });
        return;
      }
    } else {
      const skill = this.skill(job.skill);
      const inputs = { ...this.manifest.inputs, skill: { text: skill.text, sha256: skill.entry.sha256,
        selection: { mode: 'file' as const, path: join(campaignDir(this.cwd, this.id), skill.entry.file) } }, rounds: job.rounds,
        tasks: this.manifest.inputs.tasks.filter(entry => job.taskIds.includes(entry.task.id)) };
      const plan: Plan = { benchmark: findBenchmark(inputs.benchmarkId)!, split: job.split, tasks: inputs.tasks.map(entry => entry.task), compression: inputs,
        config: { ...this.manifest.config, model: job.model, repetitions: job.repeat, concurrency: job.workers },
        env: { ready: false, reason: 'prepared by compression driver' }, comparator: true, maxCostUsd: job.allowance, estimateMinutes: 0, problems: [] };
      run = createBenchmarkRun(this.cwd, plan, { model: job.model, profile: this.manifest.config.harness }, job.allowance, 'terminal');
      this.update('experiment.created', state => { state.jobs.find(entry => entry.id === job.id)!.runId = run!.runId; });
    }
    this.update('experiment.started', state => { state.jobs.find(entry => entry.id === job.id)!.status = 'running'; });
    const record = () => {
      const spent = aggregate(this.cwd, readBenchRun(this.cwd, run!.runId)!).costUsd;
      this.update('experiment.usage', state => { state.jobs.find(entry => entry.id === job.id)!.spent = spent; });
    };
    const events: RunnerEvents = { progress: text => { record(); this.services.notify?.(`${job.id}: ${text}`); }, trialFinished: record };
    try {
      const result = await (this.services.evaluate ? this.services.evaluate(run, this.workers.signal, events)
        : runCompressionBenchmark(this.cwd, run, this.env, events, this.workers.signal));
      this.update('experiment.finished', state => {
        const current = state.jobs.find(entry => entry.id === job.id)!;
        current.spent = result.costUsd;
        current.status = this.stopping?.phase === 'cancelled' ? 'cancelled' : result.pending || result.cancelled ? 'paused' : 'completed';
        current.reason = result.errors ? `${result.errors} infrastructure error(s); excluded from complete comparisons.` : result.pending ? 'Run has unfinished trials.' : undefined;
      });
    } catch (error) {
      record(); this.update('experiment.paused', state => {
        const current = state.jobs.find(entry => entry.id === job.id)!;
        current.status = this.stopping?.phase === 'cancelled' ? 'cancelled' : 'paused'; current.reason = String(error);
      });
      throw error;
    }
  }
  private async dispatch() {
    this.checkResources();
    const pending = this.state.jobs.filter(job => ['queued', 'paused', 'running'].includes(job.status));
    const running = new Map<Promise<void>, number>(); let used = 0; let failure: unknown;
    try {
      while (pending.length || running.size) {
        while (!this.stopping && !failure && pending.length && used + pending[0]!.workers <= this.manifest.workers) {
          if (this.elapsed() >= limit(this.manifest.minutes) * 60000) throw new Error('Campaign time limit reached.');
          this.checkFunds();
          this.checkResources(); const job = pending.shift()!; used += job.workers;
          const promise = this.evaluate(job).catch(error => { failure ??= error; }).finally(() => { used -= job.workers; running.delete(promise); });
          running.set(promise, job.workers);
        }
        if (!running.size) break;
        await Promise.race(running.keys());
      }
    } finally { await Promise.allSettled(running.keys()); }
    if (failure) throw failure;
    if (!this.stopping && this.state.jobs.some(job => job.status === 'paused')) throw new Error('An experiment is incomplete; inspect its reason before resuming.');
  }
  async run() {
    const initial = this.state;
    if (['completed', 'cancelled'].includes(initial.phase)) return initial;
    if (campaignAlive(initial.owner)) throw new Error(`Campaign is already running in process ${initial.owner}.`);
    if (executionHash() !== this.manifest.inputs.codeHash) throw new Error('Execution code changed since campaign creation.');
    this.initialElapsed = initial.elapsedMs; this.started = Date.now();
    this.update('campaign.started', state => {
      if (campaignAlive(state.owner)) throw new Error(`Campaign is already running in process ${state.owner}.`);
      state.owner = process.pid; state.startedAt = new Date().toISOString(); state.reason = undefined;
      for (const turn of state.turns) if (turn.status === 'running') { turn.spent = Math.max(turn.spent, turn.allowance); turn.status = 'interrupted'; }
    });
    const release = keepAwake(config().benchmarks.awake.preventSleep, this.services.notify);
    let lastCheckpoint = Date.now();
    const timer = setInterval(() => {
      if (this.elapsed() >= limit(this.manifest.minutes) * 60000 && !this.stopping) this.stop('paused', 'Campaign time limit reached.', true);
      if (Date.now() - lastCheckpoint >= 5000) {
        this.refreshSpending();
        this.update('campaign.heartbeat', state => { state.elapsedMs = this.elapsed(); }); lastCheckpoint = Date.now();
      }
    }, 250);
    try {
      while (!this.stopping && this.state.phase !== 'completed') {
        if (this.elapsed() >= limit(this.manifest.minutes) * 60000) throw new Error('Campaign time limit reached.');
        if (this.state.jobs.some(job => ['queued', 'running', 'paused'].includes(job.status))) {
          this.update('campaign.evaluating', state => { state.phase = 'evaluating'; });
          await this.dispatch(); if (this.stopping) break;
          await (this.services.evidence ?? collectCampaignEvidence)(this.cwd, this.state, this.manifest, this.workers.signal);
        }
        const state = this.state; const budget = campaignBudget(state);
        const allowance = Math.min(this.manifest.parentTurnCostUsd, limit(this.manifest.budget) - budget.spent - budget.reserved);
        if (state.turns.length >= limit(this.manifest.maxDecisions) || allowance <= 0) throw new Error('Campaign decision or spending limit reached.');
        this.parent = new AbortController();
        this.update('research.started', current => {
          current.phase = 'researching'; current.turns.push({ id: current.turns.length + 1, allowance, spent: 0, status: 'running' });
        });
        const jobsBefore = state.jobs.length;
        const onSpend = (spent: number) => this.update('research.usage', current => { current.turns.at(-1)!.spent = Math.max(current.turns.at(-1)!.spent, spent); });
        const startingSkills = state.skills.filter(skill => !skill.parent).map(skill => `${skill.id}: ${skill.rationale}`).join('\n');
        const prompt = `${this.manifest.methodology.text}\n\nObjective: ${this.manifest.objective}\nParent model: ${this.manifest.parentModel}\nAuthorized models: ${this.manifest.models.join(', ')}\nBudget: ${showLimit(this.manifest.budget, n => `$${n}`)}; this turn at most $${allowance}.\nRemaining minutes: ${showLimit(this.manifest.minutes, n => Math.max(0, n - this.elapsed() / 60000).toFixed(1))}\n\nStarting skills (v001 is the comparison reference):\n${startingSkills}\n\nCampaign results (host measured):\n${JSON.stringify(this.results())}\n\nUse read_evidence on skills/v001.md or other campaign files as needed. Existing evidence packets are named evidence/job-NNN.json. End your turn after submit_batch, or call finish.`;
        let result: Awaited<ReturnType<CampaignServices['research']>>;
        try { result = await this.services.research(prompt, allowance, this.parent.signal, onSpend); }
        catch (error) {
          this.update('research.interrupted', current => { const turn = current.turns.at(-1)!; turn.spent = Math.max(turn.spent, turn.allowance); turn.status = 'interrupted'; });
          throw error;
        }
        onSpend(result.costUsd);
        this.update('research.finished', current => { current.turns.at(-1)!.status = result.aborted || result.error ? 'interrupted' : 'completed'; });
        if (this.stopping || readCampaign(this.cwd, this.id).phase === 'completed') break;
        if (result.aborted || result.error) throw new Error(result.error ?? 'Research turn interrupted.');
        if (this.state.jobs.length === jobsBefore) throw new Error('Research turn neither submitted an experiment nor finished; paused to avoid an empty loop.');
      }
    } catch (error) {
      if (!this.stopping) this.stop('paused', error instanceof Error ? error.message : String(error), true);
    } finally {
      clearInterval(timer); release();
      this.update('campaign.checkpoint', state => {
        state.elapsedMs = this.elapsed(); delete state.owner;
        if (this.stopping && state.phase !== 'completed') { state.phase = this.stopping.phase; state.reason = this.stopping.reason; }
      });
      const state = this.state;
      if (state.phase === 'completed' && state.selectedSkill) writeJson(join(campaignDir(this.cwd, this.id), 'report.json'), {
        summary: state.summary, selectedSkill: state.selectedSkill, selection: campaignSelection(this.cwd, state, this.manifest, state.selectedSkill),
        jobs: campaignResults(this.cwd, state), budget: campaignBudget(state), elapsedMs: state.elapsedMs,
      });
    }
    return this.state;
  }
}
