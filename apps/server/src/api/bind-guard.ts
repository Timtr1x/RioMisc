/** Non-loopback bind requires an API token (guide §73). */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
}

export function assertApiBindSafe(host: string, token?: string | null): void {
  if (isLoopbackHost(host)) return;
  if (token && token.trim().length >= 8) return;
  throw new Error(`refusing to bind ${host}: non-loopback API requires RIO_API_TOKEN (8+ chars)`);
}
