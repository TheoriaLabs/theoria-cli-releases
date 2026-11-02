import { join } from 'node:path';
import { writeJson } from '@theoria/pi-research/api';
import { StatusReader, buildRevisionEvidence, type EvidenceScope, type EvidenceSource } from '@theoria/pi-bench/backend';
import { campaignDir, type CampaignManifest, type CampaignState } from './campaign-store.ts';

export function sampleStats(values: number[]) {
  const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  return { n: values.length, mean, sd: values.length > 1 ? Math.sqrt(values.reduce((sum, x) => sum + (x - mean!) ** 2, 0) / (values.length - 1)) : null,
    best: values.length ? Math.max(...values) : null };
}

export function campaignResults(cwd: string, state: CampaignState) {
  const reader = new StatusReader();
  return state.jobs.map(job => {
    const run = job.runId ? reader.run(cwd, job.runId) : undefined;
    const measured = run?.trials.filter(item => ['passed', 'failed'].includes(item.trial.status) && item.metrics.compression?.verified && Number.isFinite(item.metrics.compression.compress_score)) ?? [];
    const perTask = Object.fromEntries(job.taskIds.map(task => [task, sampleStats(measured.filter(item => item.trial.taskId === task).map(item => item.metrics.compression!.compress_score))]));
    return { ...job, measured: measured.length, expected: job.taskIds.length * job.repeat,
      errors: run?.aggregate.errors ?? 0, perTask,
      meanScore: measured.length === job.taskIds.length * job.repeat ? Object.values(perTask).reduce((sum, task) => sum + task.mean!, 0) / job.taskIds.length : null };
  });
}

/** Select only matched, complete validation cells. Different repeat budgets or models never get pooled. */
export function campaignSelection(cwd: string, state: CampaignState, manifest: CampaignManifest, skill: string) {
  if (skill === 'v001') return { eligible: true, improved: false, reason: 'Initial reference retained.' };
  const split = Object.values(manifest.splits).includes('val') ? 'val' : 'train';
  const taskIds = Object.keys(manifest.splits).filter(task => manifest.splits[task] === split).sort();
  const rows = campaignResults(cwd, state);
  const deltas: number[] = [];
  for (const model of manifest.models) {
    const cells = rows.filter(row => row.status === 'completed' && row.meanScore !== null && row.model === model && row.split === split
      && JSON.stringify([...row.taskIds].sort()) === JSON.stringify(taskIds));
    // Use the latest complete candidate, never pick a favorable repeat after seeing its score.
    const candidate = cells.filter(row => row.skill === skill).at(-1);
    const baseline = candidate && cells.filter(row => row.skill === 'v001' && row.repeat === candidate.repeat && row.rounds === candidate.rounds).at(-1);
    if (!candidate || !baseline) return { eligible: false, improved: false, reason: `Missing matched full ${split} evaluation for ${model}.` };
    deltas.push(candidate.meanScore! - baseline.meanScore!);
  }
  const delta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  return { eligible: true, improved: delta >= manifest.inputs.policy.minImprovementPercent, delta,
    reason: 'Equal-weight mean improvement across permitted models on matched development tasks.' };
}

/** Adapt the existing bounded evidence builder without weakening its fixed-experiment checks. */
export async function collectCampaignEvidence(cwd: string, state: CampaignState, manifest: CampaignManifest, signal?: AbortSignal) {
  const complete = campaignResults(cwd, state).filter(job => job.status === 'completed');
  const packets: { jobId: string; file: string }[] = [];
  for (const job of complete) {
    const evidencePath = `evidence/${job.id}.json`;
    const input = { ...manifest.inputs, tasks: manifest.inputs.tasks.filter(entry => job.taskIds.includes(entry.task.id)) };
    const experiment: EvidenceSource = { id: state.id, sequence: state.sequence, manifestHash: state.manifestHash, skills: [],
      operations: [{ id: job.id, kind: 'evaluate', status: 'completed', runId: job.runId }] };
    const frozen: EvidenceScope = {
      inputs: input, splits: manifest.splits, developmentSplits: [job.split], finalSplit: 'test',
      evidenceChars: manifest.evidenceChars };
    let packaged = false;
    if (job.meanScore !== null) {
      try {
        const bundle = await buildRevisionEvidence(cwd, experiment, frozen, signal);
        writeJson(join(campaignDir(cwd, state.id), evidencePath), { evidence: bundle.evidence, trajectories: bundle.files.map(file => ({ path: file.path, data: JSON.parse(file.text) })) });
        packaged = true;
      } catch (error) {
        if (!/required summaries .*above evidenceChars/.test(String(error))) throw error;
      }
    }
    // Large-repeat runs and infrastructure failures still get complete, explicitly paged trial summaries.
    // They must not stop the supervisor merely because the richer trajectory packet cannot fit its budget.
    if (!packaged) {
      const run = new StatusReader().run(cwd, job.runId!);
      if (!run) throw new Error(`Missing campaign run ${job.runId}.`);
      const pages: { path: string; trials: unknown[] }[] = [];
      for (const item of run.trials) {
        const summary = { id: item.trial.id, status: item.trial.status, replicate: item.trial.replicate,
          score: item.metrics.compression?.verified ? item.metrics.compression.compress_score : null,
          costUsd: item.metrics.costUsd, reason: (item.reason ?? item.metrics.reason ?? '').slice(0, 600), checkpoint: item.checkpoint };
        let page = pages.at(-1);
        if (!page || JSON.stringify([...page.trials, summary]).length > manifest.evidenceChars) {
          page = { path: `evidence/${job.id}-${pages.length + 1}.json`, trials: [] }; pages.push(page);
        }
        page.trials.push(summary);
      }
      for (const page of pages) writeJson(join(campaignDir(cwd, state.id), page.path), { jobId: job.id, trials: page.trials });
      writeJson(join(campaignDir(cwd, state.id), evidencePath), { jobId: job.id, runId: job.runId,
        coverage: { trials: run.trials.length }, pages: pages.map(page => page.path),
        note: 'Paged summaries; rich trajectory excerpts omitted because measurements are incomplete or the packet exceeds the evidence budget.' });
    }
    packets.push({ jobId: job.id, file: evidencePath });
  }
  return packets;
}
