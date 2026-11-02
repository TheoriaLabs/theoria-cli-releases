import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { config } from '@theoria/shared/config';
import { agentDir, projectPath, projectRoot } from '@theoria/shared/paths';
import { projectRecord } from '@theoria/shared/project';
import { currentRunId } from '@theoria/shared/verdicts';
import { getRun, listArtifacts, listClaims, statusLabel } from '@theoria/pi-research/api';
import { hashFile, paperFiles, paperSettings, projectFile, rootOf, saveSettings, shown } from './state.ts';

const escapeTex = (text: string) => text.replace(/[\\{}$&#%_^~]/g, char => ({ '\\': '\\textbackslash{}', '~': '\\textasciitilde{}', '^': '\\textasciicircum{}' }[char] ?? `\\${char}`));

/** Create only in an empty paper folder. The writing workflow fills the scaffold, including outline/evidence notes. */
export function createPaper(cwd: string): string {
  const settings = paperSettings(cwd);
  const main = projectFile(cwd, settings.main);
  const dir = dirname(main);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${shown(cwd, dir)} already has files. Use /latex paper update for the existing paper.`);
  for (const folder of ['', 'sections', 'figures', 'tables']) mkdirSync(join(dir, folder), { recursive: true });
  const title = escapeTex(projectRecord(cwd)?.name ?? basename(projectRoot(cwd)));
  writeFileSync(main, `\\documentclass[11pt]{article}
\\usepackage{amsmath,amssymb,graphicx,hyperref}
\\title{${title}}
\\author{}
\\date{\\today}
\\begin{document}
\\maketitle
\\begin{abstract}
Draft in preparation. Results and their evidence will be described below.
\\end{abstract}
\\input{sections/introduction}
\\input{sections/results}
\\input{sections/discussion}
% Add \\bibliographystyle{plain} and \\bibliography{references} when there are real citations.
\\end{document}
`, { flag: 'wx' });
  for (const [name, title] of [['introduction', 'Introduction'], ['results', 'Results'], ['discussion', 'Discussion and limitations']]) {
    writeFileSync(join(dir, 'sections', `${name}.tex`), `\\section{${title}}\n% THEORIA_DRAFT: replace with evidence-based content.\n`, { flag: 'wx' });
  }
  writeFileSync(join(dir, 'references.bib'), '% References supported by project sources; do not invent entries.\n', { flag: 'wx' });
  writeFileSync(join(dir, 'outline.md'), '# Paper outline\n\n<!-- THEORIA_DRAFT: map sections and claims to project evidence. -->\n', { flag: 'wx' });
  saveSettings(cwd, settings);
  return main;
}

/** Preserve a complete source/figure snapshot before an update, without replacing current user edits on failure. */
export function snapshotPaper(cwd: string, destination: string): string[] {
  const root = dirname(projectFile(cwd, paperSettings(cwd).main));
  const files = paperFiles(cwd);
  for (const file of files) {
    const out = join(destination, relative(root, file));
    mkdirSync(dirname(out), { recursive: true });
    cpSync(file, out, { dereference: false });
  }
  return files.map(file => shown(cwd, file));
}

export interface Evidence { projectRoot: string; projectName: string; at: string; files: Record<string, string>; claims: string[]; artifacts: string[]; text: string }

/** Bounded project context with file hashes. Stale verification is labelled here without changing research records. */
export function collectEvidence(cwd: string): Evidence {
  const root = rootOf(cwd);
  const paperRoot = dirname(projectFile(cwd, paperSettings(cwd).main));
  const limits = config().latex.context;
  const files: Record<string, string> = {};
  const candidates: string[] = [];
  const skip = new Set(config().workflows.target.skipDirs);
  const walk = (dir: string, depth: number) => {
    if (depth > config().workflows.target.maxDepth || candidates.length >= limits.maxFiles) return;
    // A repository may contain several Theoria projects. Their files and .theoria stores are separate contexts.
    if (dir !== root && (existsSync(join(dir, '.git')) || existsSync(join(dir, config().paths.projectDir)))) return;
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith('.') || skip.has(name)) continue;
      const path = join(dir, name);
      if (path === paperRoot) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path, depth + 1);
      else if (limits.extensions.includes(extname(path))) candidates.push(path);
      if (candidates.length >= limits.maxFiles) break;
    }
  };
  walk(root, 0);
  const runId = currentRunId(cwd);
  const run = runId ? getRun(cwd, runId) : undefined;
  const artifacts = listArtifacts(cwd);
  const claims = listClaims(cwd);
  const lines = [`Project: ${projectRecord(cwd)?.name ?? basename(root)}`, ...(run ? [`Research objective: ${run.goal.objective}`, `Research context: ${run.goal.context ?? ''}`] : []), 'Project claims:'];
  for (const claim of claims.slice(0, limits.maxFiles)) {
    let status = statusLabel(claim);
    if (claim.verification) {
      const artifact = artifacts.find(entry => entry.id === claim.verification!.artifactId);
      try { if (!artifact || hashFile(projectFile(cwd, artifact.path)) !== claim.verification.contentHash) status = 'supported (verification stale)'; }
      catch { status = 'supported (verification unavailable)'; }
    }
    lines.push(`${claim.id} [${status}]: ${claim.statement}`);
  }
  lines.push('Artifacts:');
  for (const artifact of artifacts.slice(-limits.maxFiles)) lines.push(`${artifact.id} [${artifact.kind}] ${artifact.path}: ${artifact.description ?? ''}`);
  let text = lines.join('\n').slice(0, limits.maxChars);
  for (const path of candidates) {
    if (text.length >= limits.maxChars) break;
    files[shown(cwd, path)] = hashFile(path);
    const fd = openSync(path, 'r');
    const buffer = Buffer.alloc(limits.maxFileChars * 4);
    let content: string;
    try { content = buffer.subarray(0, readSync(fd, buffer)).toString('utf8').slice(0, limits.maxFileChars); }
    finally { closeSync(fd); }
    text += `\n\n--- Project source: ${shown(cwd, path)} ---\n${content}\n--- End source ---`;
  }
  return { projectRoot: root, projectName: projectRecord(cwd)?.name ?? basename(root), at: new Date().toISOString(), files, claims: claims.map(claim => claim.id), artifacts: artifacts.map(artifact => artifact.id), text: text.slice(0, limits.maxChars) };
}

/** Prompt overrides follow the same project → user → shipped ordering as Lean workflows. */
export function paperPrompt(cwd: string, mode: 'create' | 'update'): { path: string; text: string } {
  const name = `latex-${mode}.md`;
  const paths = [projectPath(cwd, config().paths.commandsDir, name), join(agentDir(), config().paths.commandsDir, name), join(import.meta.dirname, '..', 'commands', name)];
  const path = paths.find(existsSync)!;
  return { path, text: readFileSync(path, 'utf8') };
}

/** Mechanical checks on the generated document, separate from mathematical/scientific correctness. */
export function draftProblems(cwd: string): string[] {
  const main = projectFile(cwd, paperSettings(cwd).main);
  if (!existsSync(main)) return ['The paper entry point is missing.'];
  const problems: string[] = [];
  const sources = paperFiles(cwd).filter(file => file.endsWith('.tex'));
  if (sources.some(file => /THEORIA_DRAFT/.test(readFileSync(file, 'utf8')))) problems.push('The paper still contains untouched draft sections (THEORIA_DRAFT).');
  const source = sources.map(file => readFileSync(file, 'utf8').replace(/(?<!\\)%[^\n]*/g, '')).join('\n');
  if (!/\\begin\{document\}/.test(source) || !/\\end\{document\}/.test(source)) problems.push('The paper needs a complete document environment.');
  if (source.replace(/\\[A-Za-z]+(?:\[[^\]]*\])?|[{}\s]/g, '').length < 300) problems.push('The paper has too little content to be a draft.');
  const outline = join(dirname(main), 'outline.md');
  if (!existsSync(outline) || /THEORIA_DRAFT/.test(readFileSync(outline, 'utf8'))) problems.push('Write outline.md with the section-to-evidence mapping and unresolved gaps.');
  return problems;
}
