import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '@theoria/shared/config';
import { projectPath } from '@theoria/shared/paths';
import { nextId, withLock, writeJson } from '@theoria/pi-research/api';
import { compressionSkillLabel, sourceHash } from '@theoria/pi-workflows/api';
import type { CompressionInputs, BenchmarkRunConfig } from '@theoria/pi-bench/backend';

export interface CampaignManifest {
  schemaVersion: 1; objective: string; methodology: { name: string; text: string; sha256: string };
  inputs: CompressionInputs; splits: Record<string, string>; models: string[]; parentModel: string; parentThinking: string;
  config: BenchmarkRunConfig; budget?: number; minutes?: number; workers: number;
  /** Starting candidates beyond the reference already frozen in inputs.skill. */
  additionalSkills?: CompressionInputs['skill'][];
  /** Raw-read page size; older manifests use the configured default. */
  artifactPageBytes?: number;
  maxExperiments?: number; maxDecisions?: number; parentTurnCostUsd: number; parentTurnMaxResponses: number;
  reportReserveUsd: number; evidenceChars: number; minFreeMemoryMiB: number; minFreeDiskMiB: number;
  literatureTimeoutSeconds: number; literatureMaxBytes: number; literatureMaxRequests: number;
}
export interface CampaignSkill { id: string; file: string; sha256: string; parent?: string; rationale: string; evidence: string[] }
export interface CampaignJob {
  id: string; requestId: string; skill: string; model: string; split: string; taskIds: string[];
  repeat: number; rounds: number; workers: number; hypothesis: string;
  status: 'queued' | 'running' | 'completed' | 'paused' | 'cancelled';
  allowance: number | null; spent: number; runId?: string; reason?: string;
}
export interface CampaignTurn { id: number; allowance: number; spent: number; status: 'running' | 'completed' | 'interrupted' }
export interface CampaignSource { id: string; url: string; file: string; sha256: string; retrievedAt: string }
export interface CampaignState {
  id: string; sequence: number; manifestHash: string;
  phase: 'prepared' | 'researching' | 'evaluating' | 'paused' | 'completed' | 'cancelled';
  elapsedMs: number; startedAt?: string; owner?: number; reason?: string;
  skills: CampaignSkill[]; jobs: CampaignJob[]; turns: CampaignTurn[]; sources: CampaignSource[];
  literatureRequests: number; selectedSkill?: string; summary?: string;
  resources?: { at: string; load: number; freeMemoryMiB: number; freeDiskMiB: number };
}
export const campaignRoot = (cwd: string) => projectPath(cwd, config().autoresearch.dir);
export function campaignDir(cwd: string, id: string) {
  if (!/^campaign-\d+$/.test(id)) throw new Error('Invalid campaign ID.');
  return join(campaignRoot(cwd), id);
}
export function readCampaign(cwd: string, id: string): CampaignState {
  const text = readFileSync(join(campaignDir(cwd, id), 'events.jsonl'), 'utf8');
  let state: CampaignState | undefined;
  for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean)) {
    const event = JSON.parse(line) as { state: CampaignState };
    if (event.state.id !== id || event.state.sequence !== (state?.sequence ?? 0) + 1) throw new Error('Corrupt campaign journal.');
    state = event.state;
  }
  if (!state) throw new Error(`No committed campaign ${id}.`);
  return state;
}
export function campaignManifest(cwd: string, state: CampaignState): CampaignManifest {
  const text = readFileSync(join(campaignDir(cwd, state.id), 'manifest.json'), 'utf8');
  if (sourceHash(text) !== state.manifestHash) throw new Error('Campaign manifest changed.');
  return JSON.parse(text);
}
function append(cwd: string, state: CampaignState, type: string): CampaignState {
  const dir = campaignDir(cwd, state.id); const file = join(dir, 'events.jsonl');
  if (existsSync(file)) {
    const bytes = readFileSync(file); const end = bytes.lastIndexOf(10) + 1;
    if (end !== bytes.length) {
      writeFileSync(join(dir, `uncommitted-${Date.now()}.bin`), bytes.subarray(end));
      truncateSync(file, end);
    }
  }
  const fd = openSync(file, 'a', 0o600);
  try {
    const data = Buffer.from(`${JSON.stringify({ type, at: new Date().toISOString(), state })}\n`);
    let offset = 0; while (offset < data.length) offset += writeSync(fd, data, offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  writeJson(join(dir, 'state.json'), state);
  return state;
}
export function updateCampaign(cwd: string, id: string, type: string, change: (state: CampaignState) => void): CampaignState {
  return withLock(cwd, () => {
    const state = readCampaign(cwd, id); change(state); state.sequence++;
    return append(cwd, state, type);
  });
}
export function createCampaign(cwd: string, manifest: CampaignManifest): CampaignState {
  const initial = [manifest.inputs.skill, ...manifest.additionalSkills ?? []];
  if (initial.some(skill => sourceHash(skill.text) !== skill.sha256))
    throw new Error('Starting skills do not match their frozen identities.');
  return withLock(cwd, () => {
    const root = campaignRoot(cwd); mkdirSync(root, { recursive: true });
    let id: string;
    for (;;) {
      id = nextId('campaign-', readdirSync(root), 3);
      try { mkdirSync(join(root, id)); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const dir = campaignDir(cwd, id); const text = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(dir, 'manifest.json'), text, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(dir, 'methodology.md'), manifest.methodology.text, { flag: 'wx' });
    mkdirSync(join(dir, 'skills')); mkdirSync(join(dir, 'evidence')); mkdirSync(join(dir, 'literature'));
    const skills = initial.map((skill, index) => {
      const id = `v${String(index + 1).padStart(3, '0')}`, file = `skills/${id}.md`;
      writeFileSync(join(dir, file), skill.text, { flag: 'wx' });
      return { id, file, sha256: skill.sha256, rationale: `${index === 0 ? 'Initial reference' : 'Starting candidate'}: ${compressionSkillLabel(skill)}`, evidence: [] };
    });
    return append(cwd, { id, sequence: 1, manifestHash: sourceHash(text), phase: 'prepared', elapsedMs: 0,
      skills,
      jobs: [], turns: [], sources: [], literatureRequests: 0 }, 'campaign.created');
  });
}
export function campaignBudget(state: CampaignState) {
  const spent = [...state.jobs, ...state.turns].reduce((sum, item) => sum + item.spent, 0);
  const reserved = state.jobs.filter(job => ['queued', 'running', 'paused'].includes(job.status)).reduce((sum, job) => sum + (job.allowance === null ? 0 : Math.max(0, job.allowance - job.spent)), 0)
    + state.turns.filter(turn => turn.status === 'running').reduce((sum, turn) => sum + Math.max(0, turn.allowance - turn.spent), 0);
  return { spent, reserved };
}
export const campaignAlive = (pid?: number) => {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
};
