/** Lean's internal allocation counter is 1000 times finer than maxHeartbeats / #count_heartbeats units. */
export interface HeartbeatCommand {
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  command: string;
  heartbeats: number;
}

export interface HeartbeatReport {
  total: number;
  commands: HeartbeatCommand[];
  method: 'serial-command-profiler';
  internalPerHeartbeat: 1000;
}

/** Enable only top-level command traces. Nested nodes are timed but kept below the reporting threshold. */
export const heartbeatArgs = ['-DElab.async=false', '-Dtrace.Elab.command=true', '-Dtrace.profiler=true',
  `-Dtrace.profiler.threshold=${Number.MAX_SAFE_INTEGER}`, '-Dtrace.profiler.useHeartbeats=true', '--json'];

/** Read native JSON trace messages, not agent estimates or elapsed time. Require Lean's EOF trace. */
export function readHeartbeats(output: string): { report?: HeartbeatReport; errors: string[]; problem?: string } {
  const commands: HeartbeatCommand[] = [];
  const errors: string[] = [];
  let complete = false;
  let problem: string | undefined;
  for (const line of output.split('\n')) {
    let message: { severity?: string; kind?: string; data?: string; pos?: { line: number; column?: number }; endPos?: { line: number; column?: number } };
    try { message = JSON.parse(line); } catch { continue; }
    if (message.severity === 'error') errors.push(`Line ${message.pos?.line ?? '?'}: ${message.data ?? 'Lean error'}`);
    if (message.kind !== 'trace' || typeof message.data !== 'string') continue;
    const match = /^\[Elab\.command\] \[([\d.]+)\]\s*([\s\S]*)$/.exec(message.data);
    if (!match) continue;
    const raw = Number(match[1]);
    if (!Number.isSafeInteger(raw) || raw < 0) { problem = 'Lean reported an invalid heartbeat count.'; continue; }
    const command = match[2]!.replace(/^[✅❌]\uFE0F?\s*/u, '').trim();
    if (!command) { complete = true; continue; }
    // Source-level overrides can otherwise disable part of the profile or move work onto unmeasured threads.
    if (/\bset_option\s+(?:Elab\.async\s+true|trace\.(?:profiler|Elab\.command)\b)/.test(command)) {
      problem = 'The source overrides heartbeat profiling options; remove those overrides before measuring.';
    }
    if (!Number.isInteger(message.pos?.line) || !Number.isInteger(message.endPos?.line)) { problem = 'Lean omitted a command range from its heartbeat profile.'; continue; }
    commands.push({ line: message.pos!.line, column: message.pos!.column ?? 0, endLine: message.endPos!.line,
      endColumn: message.endPos!.column ?? 0, command, heartbeats: raw / 1000 });
  }
  if (!complete) problem ??= 'Lean did not return a complete heartbeat profile (missing EOF trace or truncated output).';
  if (problem || errors.length) return { errors, problem };
  // Macro expansion can emit both `lemma` and expanded `theorem` as separate trace messages with the same
  // source range. Scoped commands also emit nested ranges. Retain outermost ranges (largest count for ties),
  // otherwise the same elaboration is charged twice.
  const le = (line: number, column: number, otherLine: number, otherColumn: number) => line < otherLine || line === otherLine && column <= otherColumn;
  const outermost = commands.filter((command, index) => !commands.some((outer, other) => {
    if (index === other || !le(outer.line, outer.column, command.line, command.column)
      || !le(command.endLine, command.endColumn, outer.endLine, outer.endColumn)) return false;
    const equal = outer.line === command.line && outer.column === command.column && outer.endLine === command.endLine && outer.endColumn === command.endColumn;
    return !equal || outer.heartbeats > command.heartbeats || outer.heartbeats === command.heartbeats && other > index;
  }));
  const rawTotal = outermost.reduce((total, command) => total + Math.round(command.heartbeats * 1000), 0);
  if (!Number.isSafeInteger(rawTotal)) return { errors, problem: 'The heartbeat total exceeds the precise numeric range.' };
  return { errors, report: { total: rawTotal / 1000, commands: outermost,
    method: 'serial-command-profiler', internalPerHeartbeat: 1000 } };
}
