import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerCard, type CardDetails, type CardLine } from '@theoria/shared/card';
import { recordVerdict } from '@theoria/shared/verdicts';
import { label, type Environment } from '@theoria/pi-lean/api';
import { config } from '@theoria/shared/config';
import { AgentTurn, type TurnResult } from '@theoria/shared/agent-turn';
import { projectPath, shownPath } from '@theoria/shared/paths';
import { read } from './gate.ts';
import type { WorkflowPrompt } from './prompt.ts';

export type Ctx = ExtensionCommandContext;
export type { CardLine };

const statusKey = 'theoria-workflow';

/**
 * What every workflow needs from Pi: running one agent turn and waiting for it to settle, posting the verdict card,
 * the footer status, and putting a file back after a failed attempt. One per extension instance.
 */
export class WorkflowRuntime {
  private readonly agent: AgentTurn;
  private readonly pi: ExtensionAPI;
  private readonly verdict: ReturnType<typeof registerCard>;
  private readonly progress: ReturnType<typeof registerCard>;
  /** When the current workflow command started; every card it posts carries its duration. */
  startedAt: number | undefined;
  /** The theorem the current workflow works on, once known, for the run history. */
  theorem: string | undefined;
  /** The file the current workflow works on, relative to the project, for its verdict. */
  file: string | undefined;
  /** The project folder of the current workflow, for the run history. */
  cwd: string | undefined;
  targetDetails: Record<string, unknown> = {};
  signal: AbortSignal | undefined;

  constructor(pi: ExtensionAPI) {
    this.pi = pi;
    this.agent = new AgentTurn(pi);
    this.verdict = registerCard(pi, 'theoria-verdict');
    this.progress = registerCard(pi, 'theoria-compression-progress');
  }

  /** One agent run: send the message, return when Pi will not continue on its own. */
  async turn(ctx: Ctx, text: string): Promise<Pick<TurnResult, 'aborted' | 'reply' | 'error'>> {
    try { return await this.agent.turn(ctx, text, { signal: this.signal }); }
    catch (error) { return { aborted: !!this.signal?.aborted, reply: '', error: error instanceof Error ? error.message : String(error) }; }
  }

  /** The verdict, in the conversation: the user sees it, and the agent knows the outcome of what it did. */
  card(title: string, lines: CardLine[], details: CardDetails) {
    details = { ...this.targetDetails, ...details };
    const interrupted = ['interrupted', 'cancelled', 'timeout', 'unavailable'].includes(String(details.outcome));
    const metadata = Object.fromEntries(['scope', 'theorems', 'targetCount', 'environment', 'baselineLines', 'lines', 'linesSaved', 'reductionPercent', 'checkDurationMs',
      'baselineHeartbeats', 'heartbeats', 'heartbeatsSaved', 'heartbeatReductionPercent', 'roundsRequested', 'roundsCompleted', 'roundsImproved',
      'versionsPassed', 'dependencies', 'reportPath', 'baselineDeclarations', 'declarationMetrics', 'paretoCandidates',
      'compress_score', 'scoreWeights', 'scoreComponents', 'roundSummaries', 'candidateScores',
      'baselineTokens', 'tokens', 'tokensSaved', 'tokenReductionPercent', 'tokenizer', 'versionsChecked', 'compatibilityPercent']
      .filter(key => details[key] !== undefined).map(key => [key, details[key]]));
    const durationMs = this.startedAt === undefined ? undefined : Date.now() - this.startedAt;
    // Every verdict goes into the project's run history, as the check gave it.
    const [workflow = '', ...rest] = title.replace(/^\//, '').split(' · ');
    const theorem = typeof details.theorem === 'string' ? details.theorem : this.theorem;
    const file = typeof details.file === 'string' ? details.file : this.file;
    if (this.cwd) recordVerdict(this.cwd, { workflow, outcome: rest.join(' · ') || title, ok: !!details.ok, ...metadata, ...(interrupted ? { interrupted } : {}), ...(theorem ? { theorem } : {}), ...(file ? { file } : {}), ...(durationMs === undefined ? {} : { durationMs }) });
    this.pi.sendMessage(this.verdict(title, lines, { ...details, interrupted, ...(theorem ? { theorem } : {}), ...(file ? { file } : {}), ...(durationMs === undefined ? {} : { durationMs }) }));
  }

  /** Progress is visible to the user/model but is not a final workflow verdict or a claim-verification event. */
  progressCard(title: string, lines: CardLine[], details: CardDetails) {
    this.pi.sendMessage(this.progress(title, lines, { ...this.targetDetails, file: this.file, ...details }));
  }

  status(ctx: Ctx, text: string | undefined) {
    ctx.ui.setStatus(statusKey, text === undefined ? undefined : ctx.ui.theme.fg('warning', text));
  }

  shown = (ctx: Ctx, path: string) => shownPath(ctx.cwd, path);

  promptNote = (ctx: Ctx, prompt: WorkflowPrompt) =>
    `Prompt: ${prompt.source === 'default' ? 'Theoria default' : `${prompt.source} ${this.shown(ctx, prompt.path)}`}`;

  /** Lean's last report, as a fenced block bounded by `workflows.card.diagnosticsChars`. */
  diagnostics = (text: string): CardLine[] => ['The last check reported:', '', '```text', text.slice(0, config().workflows.card.diagnosticsChars), '```'];

  /** The variables every prompt can use. */
  baseVars = (environment: Environment, prompt: WorkflowPrompt, attempt: number, diagnostics: string) => ({
    lean: label(environment), attempt, max_attempts: prompt.settings.maxAttempts, diagnostics, retry: attempt > 1,
  });

  /**
   * Keeps a failed attempt under the project's attempts directory and puts the file back as it was: as `before`, or
   * deleted when it did not exist before. Returns where the attempt was kept, when it changed anything.
   */
  restore(ctx: Ctx, file: string, before: string | undefined, theorem: string): string | undefined {
    const now = read(file);
    let kept: string | undefined;
    if (now !== undefined && now !== before) {
      kept = projectPath(ctx.cwd, config().paths.attemptsDir, `${theorem.replace(/[^\p{L}\p{N}_.-]/gu, '_')}-${new Date().toISOString().replace(/[:.]/g, '-')}.lean`);
      mkdirSync(dirname(kept), { recursive: true });
      writeFileSync(kept, now, 'utf8');
    }
    if (before === undefined) rmSync(file, { force: true });
    else if (now !== before) writeFileSync(file, before, 'utf8');
    return kept;
  }
}
