// Contest credentials (Token / Cookie / CSRF) leave the contest origin only
// when the operator explicitly lists a trusted CDN origin.
export function shouldAttachContestCredential(
  requestUrl: string,
  contestBaseUrl: string,
  trustedOrigins: readonly string[] = [],
): boolean {
  let request: URL;
  let base: URL;
  try {
    base = new URL(contestBaseUrl);
    request = new URL(requestUrl, contestBaseUrl);
  } catch {
    return false;
  }
  if (request.origin === base.origin) return true;
  for (const raw of trustedOrigins) {
    try {
      if (new URL(raw).origin === request.origin) return true;
    } catch {
      if (raw.replace(/\/+$/, "") === request.origin) return true;
    }
  }
  return false;
}
