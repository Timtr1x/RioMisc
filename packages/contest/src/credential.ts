// Contest credentials (Token / Cookie / CSRF) leave the contest origin only
// when the operator explicitly lists a trusted CDN origin.

/** Parse yaml / Dashboard input into unique http(s) origins. Host-only → https. */
export function normalizeTrustedOrigins(raw: readonly string[] | string | null | undefined): string[] {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\n,]+/)
      : [];
  const out: string[] = [];
  for (const part of parts) {
    const s = String(part).trim();
    if (!s) continue;
    try {
      const url = s.includes("://") ? new URL(s) : new URL(`https://${s}`);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("not http(s)");
      }
      out.push(url.origin);
    } catch {
      throw new Error(`invalid trustedCredentialOrigins entry: ${s}`);
    }
  }
  return [...new Set(out)];
}

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
