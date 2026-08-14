/** Temporary prepare failures go back to DISCOVERED; fatal ones stay ERROR. */
export function isRetryablePrepareError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/HTTP 404|not found|disk|budget|unsupported category|invalid challenge/i.test(msg)) return false;
  if (/HTTP 40[0-35-9]|HTTP 41\d|HTTP 42[0-8]|HTTP 43\d/.test(msg)) return false;
  return true;
}

export function prepareBackoffMs(failures: number): number {
  return Math.min(5_000 * 2 ** Math.max(0, failures - 1), 5 * 60_000);
}
