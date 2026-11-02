import { config } from '@theoria/shared/config';
import { ago } from '@theoria/shared/verdicts';
import { listArtifacts } from './artifacts.ts';
import { listClaims, statusLabel, type Claim } from './claims.ts';
import { lineage, runEvents, type ResearchRun } from './runs.ts';

/**
 * The run's context for the agent, added to its instructions before each turn: the goal (which belongs to Theoria,
 * not to the conversation), and the project knowledge most relevant to this run, within `research.context.maxChars`.
 * Relevance is simple for now: claims and artifacts of this run and its ancestors first, then verified claims, then
 * the newest.
 */
export function runContext(cwd: string, run: ResearchRun): string {
  const limits = config().research.context;
  const runs = lineage(cwd, run.id);
  const lineageIds = new Set(runs.map(entry => entry.id));
  const claims = listClaims(cwd);
  const rank = (claim: Claim) => (lineageIds.has(claim.createdByRunId ?? '') || lineageIds.has(claim.lastUpdatedByRunId ?? '') ? 0 : claim.status === 'verified' ? 1 : 2);
  const chosen = [...claims].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt)).slice(0, limits.maxClaims);
  const artifacts = listArtifacts(cwd);
  const artifactsChosen = [...artifacts].sort((a, b) => Number(lineageIds.has(b.createdByRunId ?? '')) - Number(lineageIds.has(a.createdByRunId ?? '')) || b.createdAt.localeCompare(a.createdAt)).slice(0, limits.maxArtifacts);
  const events = runEvents(cwd, run.id).slice(-limits.maxEvents);
  const goal = run.goal;
  const lines = [
    `Research run ${run.id}${run.status !== 'active' ? ` (${run.status})` : ''}.`,
    'This conversation works on a research run of the project. Its goal is Theoria\'s record, not something to restate or change; update only the focus and notes, with the theoria tool.',
    `Objective: ${goal.objective}`,
    ...(goal.context ? [`Context: ${goal.context}`] : []),
    ...(goal.successCriteria?.length ? ['Success criteria:', ...goal.successCriteria.map(item => `- ${item}`)] : []),
    ...(goal.currentFocus ? [`Current focus: ${goal.currentFocus}`] : []),
    ...(goal.notes?.length ? ['Notes:', ...goal.notes.slice(-5).map(note => `- ${note}`)] : []),
    ...(runs.length > 1 ? [`Forked from ${runs.slice(1).map(parent => `${parent.id} (${parent.goal.objective.split('\n')[0]!.slice(0, 60)})`).join(' ← ')}. Its claims and artifacts are the project's and are listed below; its conversation is not.`] : []),
    '',
    `### Project claims (${chosen.length} of ${claims.length})`,
    ...(chosen.length ? chosen.map(claim => `- ${claim.id} [${statusLabel(claim)}] ${claim.statement.split('\n')[0]!.slice(0, 200)}`) : ['- none yet']),
    '',
    `### Artifacts (${artifactsChosen.length} of ${artifacts.length})`,
    ...(artifactsChosen.length ? artifactsChosen.map(artifact => `- ${artifact.id} ${artifact.kind} ${artifact.path}${artifact.description ? ` — ${artifact.description}` : ''}`) : ['- none yet']),
    ...(events.length ? ['', '### Recent events of this run', ...events.map(event => `- ${event.type} ${summarize(event.payload)} · ${ago(event.timestamp)}`)] : []),
    '',
    'Record what you find with the theoria tool: `claim new <statement>`, `artifact add <path>`. A claim is verified only by Theoria: '
      + 'formally, by Lean (`claim link <id> verifies <file.lean>:<theorem>`); or statistically, by a test Theoria runs on the raw data in a file '
      + `(\`claim test <id> <data.csv> welch treatment > control\`, also mean, paired, binomial), at ${config().research.statistical.sigma}σ after correcting for every test tried on the claim. `
      + 'State the direction before testing and test each claim once on data you did not tune on; repeated tests are counted against it. '
      + 'A claim you mark supported or refuted is your judgement and is shown as such.',
  ];
  let text = lines.join('\n');
  if (text.length > limits.maxChars) text = `${text.slice(0, limits.maxChars)}\n… (cut to research.context.maxChars; /claims lists everything)`;
  return text;
}

function summarize(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const parts = ['workflow', 'theorem', 'outcome', 'id', 'status', 'path', 'focus', 'note'].flatMap(key => (record[key] === undefined ? [] : [`${key === 'workflow' ? '/' : ''}${String(record[key]).slice(0, 80)}`]));
  return parts.join(' · ');
}
