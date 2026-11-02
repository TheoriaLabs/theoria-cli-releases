/** JSON-safe resource limits: null (or an omitted optional field) means unlimited. */
export type Limit = number | null;
export const limit = (value: Limit | undefined): number => value ?? Infinity;
export const storedLimit = (value: number): Limit => Number.isFinite(value) ? value : null;
export const showLimit = (value: Limit | undefined, format: (n: number) => string = String): string =>
  Number.isFinite(limit(value)) ? format(value!) : 'unlimited';

/** Avoid infinite/overflowing setTimeout delays; long finite deadlines are re-armed. */
export function deadlineTimer(milliseconds: number, expire: () => void): () => void {
  if (!Number.isFinite(milliseconds)) return () => {};
  const deadline = Date.now() + milliseconds;
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    const left = deadline - Date.now();
    if (left <= 0) expire();
    else timer = setTimeout(arm, Math.min(left, 2_147_483_647));
  };
  arm();
  return () => clearTimeout(timer);
}
