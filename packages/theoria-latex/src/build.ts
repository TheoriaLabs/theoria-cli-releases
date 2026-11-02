import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { config } from '@theoria/shared/config';
import { projectRoot } from '@theoria/shared/paths';
import { currentRunId, recordVerdict } from '@theoria/shared/verdicts';
import { registerArtifact } from '@theoria/pi-research/api';
import { run, seconds } from '@theoria/shared/process';
import { environment, texEnv, type TexEnvironment } from './environment.ts';
import { buildId, hashFile, paperFiles, paperSettings, pdfCurrent, projectFile, readState, rootOf, saveState, shown, stateDir, writeJson, type BuildResult } from './state.ts';

export function diagnostics(text: string): { errors: string[]; warnings: string[]; missing: string[] } {
  const unique = (values: string[]) => [...new Set(values.map(line => line.trim()).filter(Boolean))];
  return {
    errors: unique(text.split('\n').filter(line => /^! |^.+:\d+: (?!warning)|^Latexmk:.*(?:error|failure)/i.test(line))).slice(0, 20),
    warnings: unique(text.split('\n').filter(line => /\bWarning:|^(?:Overfull|Underfull) \\[hv]box/i.test(line))).slice(0, 30),
    missing: unique([
      ...[...text.matchAll(/File [`']([^`'\n]+\.(?:sty|cls|bst|def))[`'] not found/g)].map(match => match[1]!),
      ...(/\bbiber\b[^\n]*(?:not found|not installed)|(?:not found|not installed)[^\n]*\bbiber\b/i.test(text) ? ['biber'] : []),
      ...(/\bbibtex\b[^\n]*(?:not found|not installed)/i.test(text) ? ['bibtex'] : []),
    ]),
  };
}

export function acquire(cwd: string, kind: 'build' | 'workflow' = 'build'): () => void {
  const dir = stateDir(cwd);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${kind}.lock`);
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid build lock: ${file}`);
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    if (alive) throw new Error(`A LaTeX ${kind} is already running for this project.`);
    rmSync(file);
  }
  writeFileSync(file, String(process.pid), { flag: 'wx' });
  return () => rmSync(file, { force: true });
}

function recordInputs(cwd: string, sourceDir: string, outputDir: string, recorder: string): Record<string, string> {
  const inputs: Record<string, string> = {};
  const root = projectRoot(cwd);
  for (const line of recorder.split('\n')) {
    if (!line.startsWith('INPUT ')) continue;
    const file = resolve(sourceDir, line.slice(6));
    if (file.startsWith(outputDir + sep) || !existsSync(file) || !statSync(file).isFile()) continue;
    inputs[file.startsWith(root + sep) ? relative(root, file) : file] = hashFile(file);
  }
  return inputs;
}

/** Deterministic compilation; every invocation gets a fresh output directory, never an old PDF as success. */
export async function compile(cwd: string, options: { signal?: AbortSignal; onLine?: (line: string) => void; environment?: TexEnvironment; runId?: string } = {}): Promise<BuildResult> {
  cwd = rootOf(cwd);
  const settings = paperSettings(cwd);
  const release = acquire(cwd);
  const started = Date.now();
  const id = buildId();
  const out = join(stateDir(cwd), 'builds', id);
  const result: BuildResult = { id, at: new Date().toISOString(), status: 'unavailable', main: settings.main, engine: settings.engine, durationMs: 0, errors: [], warnings: [], missing: [], inputs: {} };
  try {
    mkdirSync(out, { recursive: true });
    // Existing projects also get the generated output excluded from git.
    const ignore = join(stateDir(cwd), '.gitignore');
    if (!existsSync(ignore)) writeFileSync(ignore, '*\n');
    const main = projectFile(cwd, settings.main);
    const env = options.environment ?? await environment(cwd);
    result.compiler = env.compilerVersion;
    result.latexmk = env.latexmkVersion;
    if (options.signal?.aborted) { result.status = 'cancelled'; return result; }
    if (!existsSync(main)) { result.errors = [`No paper at ${settings.main}. Use /latex paper create, or choose an existing entry point in /latex status.`]; return result; }
    if (env.problem || !env.perl || !env.latexmk || !env.compiler) { result.errors = [env.problem ?? 'LaTeX tooling unavailable.']; return result; }
    const before = Object.fromEntries(paperFiles(cwd, settings).map(file => [shown(cwd, file), hashFile(file)]));
    const mode = { pdflatex: '-pdf', xelatex: '-xelatex', lualatex: '-lualatex' }[settings.engine]!;
    const built = await run(env.perl, [env.latexmk, '-norc', mode, '-interaction=nonstopmode', '-file-line-error', '-halt-on-error',
      '-latexoption=-no-shell-escape', '-recorder', '-jobname=paper', `-outdir=${out}`, '-e', `$max_repeat=${config().latex.maxPasses};`, main], {
      cwd: dirname(main), env: texEnv(), replaceEnv: true, timeoutMs: seconds(config().latex.compileTimeoutSeconds), killGroup: true,
      signal: options.signal, onLine: options.onLine,
    });
    const engineLog = join(out, 'paper.log');
    const text = `${built.stdout}\n${built.stderr}\n${existsSync(engineLog) ? readFileSync(engineLog, 'utf8') : ''}`;
    const log = join(out, 'build.log');
    writeFileSync(log, text);
    result.log = shown(cwd, log);
    // Early passes normally have unresolved citations; only the final engine log diagnoses the finished document.
    Object.assign(result, diagnostics(existsSync(engineLog) ? readFileSync(engineLog, 'utf8') : text));
    // Missing bibliography programs are reported by latexmk/the shell rather than by the engine's own log.
    result.missing = [...new Set([...result.missing, ...diagnostics(`${built.stdout}\n${built.stderr}`).missing])];
    if (options.signal?.aborted) result.status = 'cancelled';
    else if (built.timedOut) { result.status = 'timeout'; result.errors.push(`Compilation exceeded ${config().latex.compileTimeoutSeconds}s.`); }
    else if (result.missing.length) result.status = 'unavailable';
    else if (built.code !== 0) { result.status = built.code === null ? 'unavailable' : 'errors'; if (!result.errors.length) result.errors.push(text.trim().slice(-2000) || `latexmk exited with ${built.code}.`); }
    else {
      const pdf = join(out, 'paper.pdf');
      if (!existsSync(pdf) || !readFileSync(pdf).subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        result.status = 'errors'; result.errors.push('The compiler did not produce a PDF.');
      } else {
        const recorder = join(out, 'paper.fls');
        result.inputs = { ...before, ...recordInputs(cwd, dirname(main), out, existsSync(recorder) ? readFileSync(recorder, 'utf8') : '') };
        const changed = Object.entries(before).some(([path, hash]) => !existsSync(projectFile(cwd, path)) || hashFile(projectFile(cwd, path)) !== hash);
        if (changed) { result.status = 'errors'; result.errors.push('Paper sources changed during compilation. Compile again to get a consistent PDF.'); }
        else {
          result.status = 'ok'; result.pdf = shown(cwd, pdf); result.pdfHash = hashFile(pdf);
          registerArtifact(cwd, { path: pdf, kind: 'paper', runId: options.runId ?? currentRunId(cwd), description: 'Compiled paper PDF', metadata: { buildId: id, main: settings.main, compiler: result.compiler } });
        }
      }
    }
    return result;
  } catch (error) {
    result.status = options.signal?.aborted ? 'cancelled' : 'unavailable';
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  } finally {
    result.durationMs = Date.now() - started;
    try {
      writeJson(join(out, 'build.json'), result);
      saveState(cwd, { lastBuild: result, ...(result.status === 'ok' ? { lastSuccess: result } : {}) });
      recordVerdict(cwd, { workflow: 'latex-pdf', outcome: result.status, ok: result.status === 'ok', file: result.pdf ?? result.main, durationMs: result.durationMs });
    } finally { release(); }
  }
}

export function buildText(result: BuildResult): string {
  return [`LaTeX: ${result.status} · ${result.engine} · ${(result.durationMs / 1000).toFixed(1)}s`,
    ...(result.pdf ? [`PDF: ${result.pdf}`] : []), ...result.errors, ...result.warnings,
    ...(result.missing.length ? [`Missing dependencies: ${result.missing.join(', ')}. /latex status → Set up dependencies.`] : []),
    ...(result.log ? [`Log: ${result.log}`] : []),
  ].join('\n');
}

export async function openPdf(cwd: string, result = readState(cwd).lastSuccess): Promise<string> {
  if (!result?.pdf || !pdfCurrent(cwd, result)) throw new Error('There is no current PDF to open. Run /latex pdf to compile it.');
  const command = process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open';
  const opened = await run(command, [projectFile(cwd, result.pdf)], { env: texEnv(), replaceEnv: true, timeoutMs: seconds(config().latex.probeTimeoutSeconds) });
  if (opened.code !== 0) return `PDF compiled at ${result.pdf}; the viewer could not open it: ${opened.stderr.trim()}`;
  return `Opened ${result.pdf}.`;
}
