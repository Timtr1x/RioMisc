// Bounded URL fetch + SSRF guard for contest ingest (guide § security).
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const HTML_MAX_BYTES = 8 * 1024 * 1024;
export const ATTACHMENT_MAX_BYTES = 128 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_REDIRECTS = 5;

const BLOCKED_HOSTS = new Set(["github.com"]);

export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase();
  if (v === "127.0.0.1" || v === "::1" || v === "0.0.0.0" || v === "::") return true;
  if (v.startsWith("10.")) return true;
  if (v.startsWith("192.168.")) return true;
  if (v.startsWith("169.254.")) return true;
  if (v.startsWith("127.")) return true;
  const m = /^172\.(\d+)\./.exec(v);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  if (v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80")) return true;
  return false;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`不是合法 URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`仅支持 http/https: ${raw}`);
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host.replace(/^www\./, ""))) {
    throw new Error(`${host} 是 JS 渲染页面，直接抓取不可靠`);
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`拒绝访问内网地址: ${host}`);
    return parsed;
  }
  const answers = await lookup(host, { all: true });
  for (const a of answers) {
    if (isPrivateIp(a.address)) throw new Error(`拒绝解析到内网地址: ${host} → ${a.address}`);
  }
  return parsed;
}

export async function fetchBounded(
  url: string,
  opts: { maxBytes: number; timeoutMs?: number; headers?: Record<string, string>; fetchImpl?: typeof fetch } = { maxBytes: HTML_MAX_BYTES },
): Promise<{ data: Buffer; contentType: string; finalUrl: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(current);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(current, {
        redirect: "manual",
        signal: ac.signal,
        headers: { "user-agent": "rio-misc-agent/0.1 (CTF solver; authorized use)", ...(opts.headers ?? {}) },
      });
    } catch (e) {
      clearTimeout(timer);
      if ((e as Error).name === "AbortError") throw new Error(`抓取超时 (${timeoutMs}ms): ${current}`);
      throw e;
    }
    clearTimeout(timer);
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) throw new Error(`重定向没有 Location: ${current}`);
      current = new URL(loc, current).toString();
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${current}`);
    const buf = await readLimited(res, opts.maxBytes);
    return { data: buf, contentType: res.headers.get("content-type") ?? "", finalUrl: res.url || current };
  }
  throw new Error(`重定向超过 ${MAX_REDIRECTS} 次`);
}

async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new Error(`响应过大 (${len} > ${maxBytes})`);
  if (!res.body) return Buffer.from(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new Error(`响应过大 (${total} > ${maxBytes})`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
