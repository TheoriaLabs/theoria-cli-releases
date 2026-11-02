import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { expandHome } from '@theoria/shared/config';

export interface ContextFile { path: string; bytes: number; sha256: string }
export interface ContextManifest {
  schemaVersion: 1;
  sourceDirectory: string;
  sha256: string;
  files: ContextFile[];
}
export interface PreparedContext { manifest: ContextManifest; contents: Buffer[] }

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const manifestHash = (files: ContextFile[]) => sha256(JSON.stringify(files));
const snapshotDirectory = (runDirectory: string) => join(runDirectory, 'inputs/context');
const maxBytes = 64 * 1024 * 1024;
const maxFiles = 4096;

function contextPath(root: string, path: string) {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error(`Invalid context file path: ${path}`);
  return join(root, path);
}

/** Read once while planning. Later source edits cannot change the prepared run. */
export function prepareContext(cwd: string, directory: string): PreparedContext {
  if (typeof directory !== 'string' || !directory.trim()) throw new Error('context-dir must be a nonempty directory path.');
  const root = realpathSync(resolve(cwd, expandHome(directory)));
  if (!lstatSync(root).isDirectory()) throw new Error('context-dir must name a directory.');
  const files: ContextFile[] = [], contents: Buffer[] = [];
  let total = 0;
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Context directories cannot contain symlinks: ${path}`);
      if (stat.isDirectory()) { walk(path); continue; }
      if (!stat.isFile()) throw new Error(`Context entry is not a regular file: ${path}`);
      if (files.length >= maxFiles || total + stat.size > maxBytes) throw new Error('Context exceeds 4096 files or 64 MiB; select a smaller reference directory.');
      const content = readFileSync(path);
      total += content.length;
      if (total > maxBytes) throw new Error('Context exceeds 64 MiB.');
      const local = relative(root, path).split(sep).join('/');
      contextPath(root, local);
      files.push({ path: local, bytes: content.length, sha256: sha256(content) });
      contents.push(content);
    }
  };
  walk(root);
  if (!files.length) throw new Error('context-dir contains no files.');
  return { manifest: { schemaVersion: 1, sourceDirectory: root, files, sha256: manifestHash(files) }, contents };
}

function validateManifest(manifest: ContextManifest) {
  if (manifest.schemaVersion !== 1 || !manifest.files.length || manifest.files.length > maxFiles
    || manifestHash(manifest.files) !== manifest.sha256 || new Set(manifest.files.map(file => file.path)).size !== manifest.files.length
    || manifest.files.some(file => !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256))
    || manifest.files.reduce((sum, file) => sum + file.bytes, 0) > maxBytes) throw new Error('Invalid context manifest.');
  for (const file of manifest.files) contextPath('.', file.path);
}

/** The only canonical copy belongs to this run; workers never read the original directory. */
export function writeContextSnapshot(runDirectory: string, prepared: PreparedContext): void {
  validateManifest(prepared.manifest);
  if (prepared.contents.length !== prepared.manifest.files.length) throw new Error('Missing prepared context contents.');
  for (let i = 0; i < prepared.contents.length; i++) {
    const content = prepared.contents[i]!, file = prepared.manifest.files[i]!;
    if (content.length !== file.bytes || sha256(content) !== file.sha256) throw new Error(`Prepared context changed: ${file.path}`);
  }
  const root = snapshotDirectory(runDirectory);
  mkdirSync(root, { recursive: true });
  for (let i = 0; i < prepared.contents.length; i++) {
    const path = contextPath(root, prepared.manifest.files[i]!.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, prepared.contents[i]!, { flag: 'wx', mode: 0o444 });
  }
  writeFileSync(join(runDirectory, 'inputs/context.json'), `${JSON.stringify(prepared.manifest, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
}

export function verifyContextSnapshot(runDirectory: string, manifest?: ContextManifest): void {
  if (!manifest) return;
  validateManifest(manifest);
  const recorded = JSON.parse(readFileSync(join(runDirectory, 'inputs/context.json'), 'utf8')) as ContextManifest;
  if (JSON.stringify(recorded) !== JSON.stringify(manifest)) throw new Error('Frozen context manifest was modified.');
  const root = snapshotDirectory(runDirectory);
  const found = prepareContext(runDirectory, root).manifest;
  if (found.sha256 !== manifest.sha256) throw new Error('Frozen context files were modified.');
}

/** Copy-on-write where supported; worker-local paths need no access to the run's other inputs. */
export function stageContext(runDirectory: string, workspace: string, manifest?: ContextManifest): string[] {
  if (!manifest) return [];
  verifyContextSnapshot(runDirectory, manifest);
  const root = join(workspace, 'inputs/context');
  if (existsSync(join(workspace, 'inputs')) && lstatSync(join(workspace, 'inputs')).isSymbolicLink())
    throw new Error('Worker inputs cannot be a symlink.');
  if (existsSync(root)) throw new Error(`Worker context directory already exists: ${root}`);
  mkdirSync(root, { recursive: true });
  for (const file of manifest.files) {
    const target = contextPath(root, file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(contextPath(snapshotDirectory(runDirectory), file.path), target, constants.COPYFILE_FICLONE);
    chmodSync(target, 0o444);
    if (sha256(readFileSync(target)) !== file.sha256) throw new Error(`Context copy mismatch: ${file.path}`);
  }
  const metadata = join(workspace, 'inputs/context-manifest.json');
  writeFileSync(metadata, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  return [root, metadata];
}

export function appendContext(prompt: string, manifest?: ContextManifest): string {
  if (!manifest) return prompt;
  const files = manifest.files.slice(0, 20).map(file => `- ${JSON.stringify(`inputs/context/${file.path}`)}`);
  return `${prompt}\n\nRead-only reference context (snapshot ${manifest.sha256.slice(0, 12)}):\n${files.join('\n')}\n`
    + `${manifest.files.length > 20 ? `${manifest.files.length - 20} additional file(s); ` : ''}The complete file list is in inputs/context-manifest.json.\n`
    + 'Read relevant files for navigation and supporting context. Verify proposed proof replacements in the pinned Lean environment.';
}
