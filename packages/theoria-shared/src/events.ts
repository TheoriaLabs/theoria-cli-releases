import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { config } from './config.ts';
import { projectPath } from './paths.ts';

/**
 * A research run's append-only event log, `.theoria/<research.runsDir>/<run>/events.jsonl`. Here rather than in the
 * research package so anything that records into a run (workflow verdicts, the benchmark runner, the bot) can, without
 * depending on it. Events get random ids, so appends from two sessions need no lock: each is one `write` of a short
 * line to a file opened for appending.
 */

export interface RunEvent {
  id: string;
  projectId: string;
  runId: string;
  type: string;
  timestamp: string;
  payload: unknown;
}

export const runDir = (cwd: string, runId: string) => projectPath(cwd, config().research.runsDir, runId);
export const runEventsPath = (cwd: string, runId: string) => projectPath(cwd, config().research.runsDir, runId, config().research.eventsFile);

export const eventId = () => `ev-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;

export function appendRunEvent(cwd: string, runId: string, type: string, payload: unknown, projectId = ''): RunEvent | undefined {
  const event: RunEvent = { id: eventId(), projectId, runId, type, timestamp: new Date().toISOString(), payload };
  try {
    const path = runEventsPath(cwd, runId);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, 'utf8');
    return event;
  } catch { return undefined; }
}

export function readRunEvents(cwd: string, runId: string): RunEvent[] {
  let text = '';
  try { text = readFileSync(runEventsPath(cwd, runId), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as RunEvent]; } catch { return []; } });
}
