import { existsSync } from 'node:fs';
import { projectRecord } from '@theoria/shared/project';
import { buildText } from './build.ts';
import { environment, type TexEnvironment } from './environment.ts';
import { paperSettings, pdfCurrent, projectFile, readState, rootOf } from './state.ts';

export const usage = '/latex paper create [brief] · paper update [request] · pdf · status';
export type LatexCommand = { name: 'create' | 'update'; request: string } | { name: 'pdf' } | { name: 'status' } | { name: 'menu' };
export function parseCommand(args: string): LatexCommand {
  const value = args.trim();
  if (!value) return { name: 'menu' };
  if (value === 'pdf' || value === 'status') return { name: value };
  const paper = /^paper\s+(create|update)(?:\s+([\s\S]*))?$/.exec(value);
  if (paper) return { name: paper[1] as 'create' | 'update', request: paper[2]?.trim() ?? '' };
  throw new Error(`Usage: ${usage}`);
}

export async function status(cwd: string): Promise<{ text: string; environment: TexEnvironment }> {
  const settings = paperSettings(cwd);
  const env = await environment(cwd);
  const state = readState(cwd);
  const exists = existsSync(projectFile(cwd, settings.main));
  const current = pdfCurrent(cwd, state.lastSuccess, settings);
  return {
    environment: env,
    text: [
      `Project: ${projectRecord(cwd)?.name ?? 'not selected'} · ${rootOf(cwd)}`,
      `Paper: ${settings.main}${exists ? '' : ' (not created yet)'}`,
      `Compiler: ${env.compilerVersion ?? `${settings.engine} unavailable`}`,
      `latexmk: ${env.latexmkVersion ?? 'not installed'}`,
      ...(env.problem ? [`Unavailable: ${env.problem}`] : ['Compiler environment ready.']),
      ...(env.missingPackages.length ? [`Missing standard packages: ${env.missingPackages.join(', ')}`] : []),
      `Bibliography: BibTeX ${env.bibtex ? 'available' : 'missing'}; Biber ${env.biber ? 'available' : 'not installed (needed only for Biber documents)'}`,
      ...(state.lastSuccess?.pdf ? [`PDF: ${current ? 'current' : 'stale or missing'} · ${state.lastSuccess.pdf}`] : ['PDF: not compiled yet.']),
      ...(state.lastBuild ? [`Last build (${state.lastBuild.at}):\n${buildText(state.lastBuild)}`] : []),
      ...(state.workflow ? [`Last paper ${state.workflow.mode}: ${state.workflow.status} · $${state.workflow.costUsd.toFixed(3)}${state.workflow.snapshot ? `\nPrevious sources: ${state.workflow.snapshot}` : ''}`] : []),
    ].join('\n'),
  };
}
