import { readFileSync } from 'node:fs';

/**
 * Columns of numbers from a data file: CSV or TSV with a header row, JSON (an array of rows, or an object of
 * columns), or JSONL (one row per line). true/false count as 1/0. A value that is not a number is an error, not
 * skipped: silently dropping rows would change the result.
 */
export function readColumns(path: string): Record<string, number[]> {
  const text = readFileSync(path, 'utf8');
  const rows: Record<string, unknown>[] = [];
  const trimmed = text.trim();
  if (path.endsWith('.jsonl')) for (const line of trimmed.split('\n').filter(Boolean)) rows.push(JSON.parse(line) as Record<string, unknown>);
  else if (path.endsWith('.json') || trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const value = JSON.parse(trimmed) as unknown;
    if (Array.isArray(value)) rows.push(...(value as Record<string, unknown>[]));
    else if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, column]) => Array.isArray(column)).map(([name, column]) => [name, (column as unknown[]).map((cell, index) => number(cell, name, index))]));
    }
  } else {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    const separator = path.endsWith('.tsv') || (lines[0]!.includes('\t') && !lines[0]!.includes(',')) ? '\t' : ',';
    const header = lines[0]!.split(separator).map(cell => cell.trim().replace(/^"|"$/g, ''));
    for (const line of lines.slice(1)) {
      const cells = line.split(separator);
      rows.push(Object.fromEntries(header.map((name, index) => [name, cells[index]?.trim().replace(/^"|"$/g, '')])));
    }
  }
  const names = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return Object.fromEntries(names.map(name => [name, rows.flatMap((row, index) => (row[name] === undefined || row[name] === '' ? [] : [number(row[name], name, index)]))]));
}

function number(cell: unknown, column: string, index: number): number {
  if (cell === true || cell === 'true') return 1;
  if (cell === false || cell === 'false') return 0;
  const value = typeof cell === 'number' ? cell : Number(cell);
  if (!Number.isFinite(value)) throw new Error(`${column}, row ${index + 1}: "${String(cell)}" is not a number.`);
  return value;
}
