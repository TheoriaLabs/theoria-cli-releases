import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { projectRoot } from './paths.ts';

/**
 * A project's goals, as pi-goal-x keeps them: one Markdown file per open goal in `goals.dir`, starting with the
 * goal's record as JSON. Read here without pi-goal-x's code, so the bot (plain Node, outside Pi) can show them.
 * Their status and task marks are the agent's own; nothing here is verified.
 */

export interface GoalSummary {
  id: string;
  objective: string;
  status: string;
  ordered: boolean;
  tasksDone: number;
  tasksTotal: number;
  activeSeconds: number;
}

/** The leading JSON object of a goal file. */
function leadingJson(text: string): Record<string, unknown> | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(0, index + 1)) as Record<string, unknown>; } catch { return undefined; }
    }
  }
  return undefined;
}

export function parseGoal(text: string): GoalSummary | undefined {
  const record = leadingJson(text.trimStart());
  if (!record || typeof record.id !== 'string' || typeof record.objective !== 'string') return undefined;
  const tasks = ((record.taskList as { tasks?: { status?: string }[] } | undefined)?.tasks ?? []);
  return {
    id: record.id,
    objective: record.objective.trim(),
    status: typeof record.status === 'string' ? record.status : 'active',
    ordered: record.sisyphus === true,
    tasksDone: tasks.filter(task => task.status === 'complete' || task.status === 'skipped').length,
    tasksTotal: tasks.length,
    activeSeconds: Number((record.usage as { activeSeconds?: number } | undefined)?.activeSeconds ?? 0),
  };
}

/** Open goals of the project in `cwd`, newest first. */
export function openGoals(cwd: string): GoalSummary[] {
  const dir = join(projectRoot(cwd), config().goals.dir);
  let names: string[] = [];
  try { names = readdirSync(dir).filter(name => name.startsWith('active_goal_') && name.endsWith('.md')).sort().reverse(); } catch { return []; }
  return names.flatMap(name => {
    try {
      const goal = parseGoal(readFileSync(join(dir, name), 'utf8'));
      return goal && goal.status !== 'complete' ? [goal] : [];
    } catch { return []; }
  });
}

/** How many goals the project has completed (archived). */
export function completedGoals(cwd: string): number {
  try { return readdirSync(join(projectRoot(cwd), config().goals.archivedDir)).filter(name => name.endsWith('.md')).length; } catch { return 0; }
}

/** The goals section of a status message. */
export function goalLines(cwd: string): string[] {
  const goals = openGoals(cwd);
  const done = completedGoals(cwd);
  if (!goals.length) return [`Goals: none open${done ? ` (${done} completed)` : ''}. Set one with /goal <idea>.`];
  const shown = goals.slice(0, config().goals.maxShown);
  return [
    `Goals: ${goals.length} open${done ? `, ${done} completed` : ''}`,
    ...shown.map(goal => {
      const tasks = goal.tasksTotal ? ` · tasks ${goal.tasksDone}/${goal.tasksTotal}` : '';
      return `  • ${goal.objective.split('\n')[0]!.slice(0, 90)} [${goal.status}${goal.ordered ? ', ordered' : ''}${tasks}]`;
    }),
    ...(goals.length > shown.length ? [`  … ${goals.length - shown.length} more (/goal_list)`] : []),
    '  Task marks are the agent\'s; Lean checks only what /prove and /formalize submit.',
  ];
}
