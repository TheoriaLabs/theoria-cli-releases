import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { config } from '@theoria/shared/config';
import { appendRunEvent } from '@theoria/shared/events';
import { projectRoot } from '@theoria/shared/paths';
import { noteInRun } from './runs.ts';
import { appendJsonl, nextId, now, projectId, readJsonl, researchPath, sha256, withLock } from './store.ts';

/**
 * Artifacts: files of the project that research produced (a proof, a derivation, a dataset), with identity and
 * provenance. The file system holds the data; this index holds which run made it and the content hash it had then.
 */

export const artifactKinds = ['proof', 'code', 'derivation', 'result', 'dataset', 'plot', 'paper', 'note', 'benchmark-result', 'trajectory', 'other'] as const;
export type ArtifactKind = (typeof artifactKinds)[number];

export interface Artifact {
  id: string;
  projectId: string;
  createdByRunId?: string;
  kind: ArtifactKind;
  /** Relative to the project. */
  path: string;
  contentHash?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

const indexPath = (cwd: string) => researchPath(cwd, config().research.artifactsFile);

export const listArtifacts = (cwd: string): Artifact[] => readJsonl<Artifact>(indexPath(cwd));
export const getArtifact = (cwd: string, id: string) => listArtifacts(cwd).find(artifact => artifact.id === id);
export const artifactFile = (cwd: string, artifact: Artifact) => resolve(projectRoot(cwd), artifact.path);

/** A path inside the project, relative to it; anything outside is refused. */
export function insideProject(cwd: string, path: string): string {
  const root = projectRoot(cwd);
  const inside = relative(root, resolve(cwd, path));
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`${path} is not inside the project (${root}).`);
  return inside;
}

export function guessKind(path: string): ArtifactKind {
  if (path.endsWith('.lean')) return 'proof';
  if (/\.(py|ts|js|rs|jl|c|cpp|sh)$/.test(path)) return 'code';
  if (/\.(csv|json|jsonl|parquet|npy)$/.test(path)) return 'dataset';
  if (/\.(png|svg|pdf)$/.test(path)) return path.endsWith('.pdf') ? 'paper' : 'plot';
  if (/\.(md|txt|tex)$/.test(path)) return 'note';
  return 'other';
}

/**
 * Registers a file as an artifact. The same path with the same content is the same artifact; a changed file is a new
 * artifact (a new version), so a claim keeps pointing at what it was linked to.
 */
export function registerArtifact(cwd: string, input: { path: string; kind?: ArtifactKind; runId?: string; description?: string; metadata?: Record<string, unknown> }): { artifact: Artifact; created: boolean } {
  const path = insideProject(cwd, input.path);
  const file = resolve(projectRoot(cwd), path);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`${path} is not a file.`);
  const contentHash = sha256(file);
  const result = withLock(cwd, (): { artifact: Artifact; created: boolean } => {
    const all = listArtifacts(cwd);
    const same = all.find(artifact => artifact.path === path && artifact.contentHash === contentHash);
    if (same) return { artifact: same, created: false };
    const artifact: Artifact = {
      id: nextId('A', all.map(entry => entry.id)), projectId: projectId(cwd), ...(input.runId ? { createdByRunId: input.runId } : {}),
      kind: input.kind ?? guessKind(path), path, ...(contentHash ? { contentHash } : {}),
      ...(input.description ? { description: input.description } : {}), ...(input.metadata ? { metadata: input.metadata } : {}), createdAt: now(),
    };
    appendJsonl(indexPath(cwd), artifact);
    if (input.runId) appendRunEvent(cwd, input.runId, 'artifact.created', { id: artifact.id, path, kind: artifact.kind }, artifact.projectId);
    return { artifact, created: true };
  });
  if (result.created) noteInRun(cwd, input.runId, 'artifactIds', result.artifact.id);
  return result;
}

/** Whether the file still has the content it was registered with. */
export function artifactChanged(cwd: string, artifact: Artifact): boolean {
  return sha256(artifactFile(cwd, artifact)) !== artifact.contentHash;
}

export const artifactLine = (cwd: string, artifact: Artifact) =>
  `${artifact.id} ${artifact.kind} ${artifact.path}${artifactChanged(cwd, artifact) ? ' (changed since)' : ''}${artifact.createdByRunId ? ` · ${artifact.createdByRunId}` : ''}${artifact.description ? ` · ${artifact.description}` : ''}`;
