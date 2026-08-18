// DASCTF / Slab-Match Agent API adapter (game/api_doc.md).
// Auth: X-Agent-AccessKey. Paths under {host}/slab-match/api/v1/agent/...
import type {
  ContestCapabilities,
  RemoteChallenge,
  RemoteChallengeDetail,
  HintResult,
  SubmissionResult,
  DownloadResult,
  StartChallengeResult,
} from "@rio/domain";
import type { ContestAdapter } from "./adapter.js";
import { normalizeTrustedOrigins, shouldAttachContestCredential } from "./credential.js";
import { MAX_REDIRECTS } from "./fetch-guard.js";
import { streamResponseToSink } from "./stream-body.js";
import { isMiscOrCryptoCategory, stripHtml, type FetchLike } from "./ctfd.js";

const UA = "rio-misc-agent/0.1 (DASCTF agent; authorized use)";
const DETAIL_TTL_MS = 60_000;
const ENV_POLL_MS = 2_000;
const ENV_POLL_MAX = 30;

export interface DasctfAdapterOptions {
  baseUrl: string;
  accessKey: string;
  miscCryptoOnly?: boolean;
  fetchImpl?: FetchLike;
  trustedCredentialOrigins?: string[];
  /** Poll interval while waiting for build-exercise-env (tests can shrink). */
  envPollMs?: number;
  envPollMax?: number;
  /** Base backoff for HTTP 429 (tests can shrink). */
  rateLimitBackoffMs?: number;
}

type DasctfEnvelope = { code?: string; message?: string; data?: unknown };

type CachedDetail = { fetchedAt: number; detail: RemoteChallengeDetail; raw: Record<string, unknown> };

/** Accept host-only or a full …/slab-match/api/v1/agent path. */
export function normalizeDasctfBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new Error(`不是合法 URL: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`仅支持 http/https: ${raw}`);
  }
  let path = parsed.pathname.replace(/\/+$/, "");
  const marker = "/slab-match/api/v1/agent";
  const idx = path.toLowerCase().indexOf(marker);
  if (idx >= 0) path = path.slice(0, idx + marker.length);
  else path = marker;
  return `${parsed.origin}${path}`;
}

export function parseDasctfRemoteId(remoteId: string): number {
  const m = /^dasctf:[^:]+:(\d+)$/.exec(remoteId) ?? /^(\d+)$/.exec(remoteId);
  if (!m) throw new Error(`not a DASCTF exercise id: ${remoteId}`);
  return Number(m[1]);
}

export function assertDasctfOk(json: DasctfEnvelope, path: string): void {
  if (json.code === "00000") return;
  const msg = json.message?.trim() || `DASCTF API error code=${json.code ?? "?"}`;
  throw new Error(`${path}: ${msg}`);
}

/** Live platform reuses code 40001 for both rate-limit and wrong-flag. */
export function isDasctfRateLimitMessage(message: string | undefined, httpStatus?: number): boolean {
  if (httpStatus === 429) return true;
  const msg = (message ?? "").toLowerCase();
  return /rate|limit|频繁|冷却|稍后重试|too many/.test(msg);
}

export function mapDasctfSubmit(json: DasctfEnvelope): SubmissionResult {
  if (json.code === "00000") {
    const data = (json.data ?? {}) as { isCorrect?: boolean };
    if (data.isCorrect === true) {
      return { ok: true, correct: true, status: "CORRECT", raw: json };
    }
    // Some platforms still return 00000 with isCorrect=false.
    return {
      ok: true,
      correct: false,
      status: "WRONG",
      message: json.message || "incorrect",
      raw: json,
    };
  }
  const msg = json.message ?? "";
  if (isDasctfRateLimitMessage(msg)) {
    return { ok: false, correct: false, status: "RATE_LIMITED", cooldownMs: 60_000, message: msg, raw: json };
  }
  // Live wrong-flag example: code=40001 message="提交flag错误，请重新提交（当前还有N次提交机会）"
  if (/flag错误|答案错误|提交.*错误|wrong|incorrect|不正确|失败/.test(msg) || /flag/i.test(msg)) {
    return { ok: true, correct: false, status: "WRONG", message: msg, raw: json };
  }
  if (json.code) {
    return { ok: true, correct: false, status: "WRONG", message: msg || `code=${json.code}`, raw: json };
  }
  return { ok: false, correct: false, status: "UNKNOWN", message: msg || "unrecognized submit", raw: json };
}

/** Live DASCTF may return either docs-style `{files:[…]}` or a single `{url,name,extension}` object. */
export function parseDasctfAttachments(
  raw: unknown,
  challengeId: number,
): RemoteChallengeDetail["attachments"] {
  const items: Array<{ name?: string; url?: string; ext?: string; extension?: string }> = [];
  if (Array.isArray(raw)) {
    for (const f of raw) {
      if (typeof f === "string") items.push({ url: f });
      else if (f && typeof f === "object") items.push(f as { name?: string; url?: string; ext?: string; extension?: string });
    }
  } else if (raw && typeof raw === "object") {
    const obj = raw as { files?: unknown; url?: string; name?: string; ext?: string; extension?: string; previewUrl?: string };
    if (Array.isArray(obj.files)) {
      for (const f of obj.files) {
        if (typeof f === "string") items.push({ url: f });
        else if (f && typeof f === "object") items.push(f as { name?: string; url?: string; ext?: string; extension?: string });
      }
    } else if (obj.url || obj.previewUrl) {
      items.push({
        name: obj.name,
        url: obj.url || obj.previewUrl,
        ext: obj.ext || obj.extension,
        extension: obj.extension,
      });
    }
  }
  return items.map((f, i) => {
    const url = f.url ? String(f.url) : null;
    const ext = f.ext || f.extension;
    const name = String(f.name || (ext ? `attachment.${ext}` : `attachment-${i}`));
    return {
      remoteId: `file-${challengeId}-${i}`,
      name,
      url,
      sizeBytes: null as number | null,
    };
  });
}

export function formatDasctfEndpoints(endpoints: unknown): string {
  if (!Array.isArray(endpoints) || endpoints.length === 0) return "";
  const lines: string[] = ["靶机 / 连接信息："];
  for (const [i, ep] of endpoints.entries()) {
    const e = ep as Record<string, unknown>;
    lines.push(`#${i + 1}`);
    const ips = Array.isArray(e.exposeIps) ? e.exposeIps.map(String) : [];
    const ports = Array.isArray(e.ports) ? e.ports.map(String) : [];
    const proxyIps = Array.isArray(e.proxyIps) ? e.proxyIps.map(String) : [];
    if (ips.length) lines.push(`  IPs: ${ips.join(", ")}`);
    if (ports.length) lines.push(`  Ports: ${ports.join(", ")}`);
    if (e.isProxy) lines.push(`  Proxy: yes${proxyIps.length ? ` (${proxyIps.join(", ")})` : ""}`);
    else if (proxyIps.length) lines.push(`  Proxy IPs: ${proxyIps.join(", ")}`);
    if (Array.isArray(e.portMappings)) {
      for (const m of e.portMappings as Record<string, unknown>[]) {
        lines.push(`  Map: ${m.type ?? "tcp"} ${m.port} → proxy ${m.proxy}`);
      }
    }
    if (Array.isArray(e.users)) {
      for (const u of e.users as Record<string, unknown>[]) {
        lines.push(`  User: ${u.username ?? "?"} / ${u.password ?? "?"}`);
      }
    }
    if (e.expireTime != null) lines.push(`  Expire: ${e.expireTime}`);
  }
  return lines.join("\n");
}

function parseScore(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

export class DasctfAgentContestAdapter implements ContestAdapter {
  readonly kind = "dasctf";
  readonly baseUrl: string;
  readonly miscCryptoOnly: boolean;
  private readonly accessKey: string;
  private readonly fetchImpl: FetchLike;
  readonly trustedCredentialOrigins: string[];
  private readonly envPollMs: number;
  private readonly envPollMax: number;
  private readonly rateLimitBackoffMs: number;
  private cache = new Map<number, CachedDetail>();
  private hostKey: string;

  constructor(opts: DasctfAdapterOptions) {
    if (!opts.accessKey?.trim()) throw new Error("DASCTF AccessKey 不能为空");
    this.baseUrl = normalizeDasctfBaseUrl(opts.baseUrl);
    this.accessKey = opts.accessKey.trim();
    this.miscCryptoOnly = opts.miscCryptoOnly !== false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.trustedCredentialOrigins = normalizeTrustedOrigins(opts.trustedCredentialOrigins);
    this.envPollMs = opts.envPollMs ?? ENV_POLL_MS;
    this.envPollMax = opts.envPollMax ?? ENV_POLL_MAX;
    this.rateLimitBackoffMs = opts.rateLimitBackoffMs ?? 1500;
    this.hostKey = new URL(this.baseUrl).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  }

  async authenticate(): Promise<void> {
    const json = await this.#getJson("/match/notice/match-info");
    assertDasctfOk(json, "/match/notice/match-info");
  }

  getCapabilities(): Promise<ContestCapabilities> {
    return Promise.resolve({
      polling: true,
      supportsStartChallenge: true,
      supportsHints: false,
      supportsLeaderboard: false,
      dynamicScoring: true,
      exposesSolveCount: false,
      hint: { unlockMode: "UNKNOWN", unlockDelayMs: null, hasPenalty: null },
      submission: { cooldownMs: null, maxWrongAttempts: null, hasPenalty: null },
      attachment: { maxConcurrentDownloads: 2 },
    });
  }

  async listChallenges(): Promise<RemoteChallenge[]> {
    const json = await this.#getJson("/ctf/exercise-list");
    assertDasctfOk(json, "/ctf/exercise-list");
    const cats = Array.isArray(json.data) ? json.data : [];
    const out: RemoteChallenge[] = [];
    for (const cat of cats) {
      const category = String((cat as { name?: string }).name ?? "");
      if (this.miscCryptoOnly && !isMiscOrCryptoCategory(category)) continue;
      const corpus = Array.isArray((cat as { corpus?: unknown }).corpus)
        ? ((cat as { corpus: unknown[] }).corpus)
        : [];
      for (const item of corpus) {
        const row = item as {
          id?: number;
          name?: string;
          isOpen?: boolean;
          hasSolved?: boolean;
        };
        if (row.hasSolved === true) continue;
        if (row.isOpen === false) continue;
        const id = Number(row.id);
        if (!Number.isFinite(id)) continue;
        out.push({
          remoteId: this.#remoteId(id),
          title: String(row.name ?? `exercise-${id}`),
          description: "",
          category,
          score: null,
          solveCount: null,
          createdAt: null,
          updatedAt: Date.now(),
          attachments: [],
        });
      }
    }
    return out;
  }

  async getChallenge(remoteId: string): Promise<RemoteChallengeDetail> {
    const id = parseDasctfRemoteId(remoteId);
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.fetchedAt < DETAIL_TTL_MS) return cached.detail;
    const { detail, raw } = await this.#fetchDetail(id);
    this.cache.set(id, { fetchedAt: Date.now(), detail, raw });
    return detail;
  }

  async startChallenge(remoteId: string): Promise<StartChallengeResult> {
    const id = parseDasctfRemoteId(remoteId);
    const first = await this.#fetchDetail(id);
    this.cache.set(id, { fetchedAt: Date.now(), detail: first.detail, raw: first.raw });
    if (first.raw.isNeedInit !== true && first.raw.isNeedCheck !== true) {
      return { ok: true, message: "environment already ready" };
    }
    if (first.raw.isNeedInit === true) {
      const built = await this.#postJson("/ctf/build-exercise-env", { exerciseId: id });
      assertDasctfOk(built, "/ctf/build-exercise-env");
    }
    for (let i = 0; i < this.envPollMax; i++) {
      if (i > 0) await sleep(this.envPollMs);
      const next = await this.#fetchDetail(id);
      this.cache.set(id, { fetchedAt: Date.now(), detail: next.detail, raw: next.raw });
      if (next.raw.isNeedCheck !== true) {
        return { ok: true, message: i === 0 ? "environment ready" : `environment ready after ${i + 1} polls` };
      }
    }
    return { ok: false, message: `environment still preparing after ${this.envPollMax} polls` };
  }

  async getHint(_remoteId: string): Promise<HintResult> {
    return { ok: false, notAvailable: true, message: "DASCTF Agent API has no hint endpoints" };
  }

  async submitFlag(remoteId: string, flag: string): Promise<SubmissionResult> {
    const id = parseDasctfRemoteId(remoteId);
    // Wrong flags also come back as code=40001 — parse business body, do not treat as transport error.
    const json = await this.#postJson("/answer-panel/answer", { exerciseId: id, flag }, { allowBusinessError: true });
    return mapDasctfSubmit(json);
  }

  async downloadAttachment(
    _challenge: RemoteChallengeDetail,
    attachment: { remoteId: string | null; name: string; url: string | null },
    sink?: import("node:stream").Writable,
  ): Promise<DownloadResult> {
    if (!attachment.url) return { ok: false, bytes: 0, sha256: "", retryable: false, message: "no attachment url" };
    const res = await this.#request(attachment.url);
    if (res.status === 429) return { ok: false, bytes: 0, sha256: "", retryable: true, message: "429 rate limited" };
    if (!res.ok) return { ok: false, bytes: 0, sha256: "", retryable: res.status >= 500, message: `HTTP ${res.status}` };
    const streamed = await streamResponseToSink(res, sink);
    if (!streamed.ok) {
      return { ok: false, bytes: streamed.bytes, sha256: streamed.sha256, retryable: streamed.retryable, message: streamed.message };
    }
    return { ok: true, retryable: false, bytes: streamed.bytes, sha256: streamed.sha256 };
  }

  #remoteId(id: number): string {
    return `dasctf:${this.hostKey}:${id}`;
  }

  async #fetchDetail(id: number): Promise<{ detail: RemoteChallengeDetail; raw: Record<string, unknown> }> {
    const json = await this.#getJson(`/ctf/exercise?exerciseId=${id}`);
    assertDasctfOk(json, `/ctf/exercise?exerciseId=${id}`);
    const d = (json.data ?? {}) as Record<string, unknown>;
    const attachments = parseDasctfAttachments(d.attachment ?? d.file ?? d.files ?? d.attachments, id);
    let description = stripHtml(String(d.description ?? ""));
    const epText = formatDasctfEndpoints(d.endpoints);
    if (epText) description = `${description}\n\n${epText}`.trim();
    const detail: RemoteChallengeDetail = {
      remoteId: this.#remoteId(id),
      title: String(d.name ?? `exercise-${id}`),
      description,
      category: String(d.category ?? d.type ?? ""),
      score: parseScore(d.score),
      solveCount: null,
      createdAt: null,
      updatedAt: Date.now(),
      attachments,
    };
    // Category may be missing on detail — keep empty; list already filtered.
    return { detail, raw: d };
  }

  async #getJson(path: string): Promise<DasctfEnvelope> {
    const res = await this.#request(path);
    return this.#parseJson(res, path);
  }

  async #postJson(
    path: string,
    body: unknown,
    opts: { allowBusinessError?: boolean } = {},
  ): Promise<DasctfEnvelope> {
    const res = await this.#request(path, { method: "POST", body: JSON.stringify(body) });
    return this.#parseJson(res, path, opts);
  }

  async #parseJson(
    res: Response,
    path: string,
    opts: { allowBusinessError?: boolean } = {},
  ): Promise<DasctfEnvelope> {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`鉴权失败 (${res.status})：请检查 X-Agent-AccessKey 是否有效`);
    }
    let parsed: DasctfEnvelope | null = null;
    try {
      parsed = JSON.parse(text) as DasctfEnvelope;
    } catch {
      parsed = null;
    }
    const rateLimited =
      res.status === 429 ||
      (parsed?.code === "40001" && isDasctfRateLimitMessage(parsed.message, res.status));
    if (rateLimited) {
      throw new DasctfRateLimitError(path, parsed?.message || text.slice(0, 120));
    }
    if (!res.ok) {
      throw new Error(`DASCTF API ${res.status} ${path}: ${text.slice(0, 200)}`);
    }
    if (!parsed) throw new Error("DASCTF API 返回的不是 JSON");
    if (opts.allowBusinessError) return parsed;
    return parsed;
  }

  async #request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    let url = this.#absoluteUrl(pathOrUrl);
    let rateAttempts = 0;
    for (let hop = 0; hop <= MAX_REDIRECTS + 6; hop++) {
      const headers = this.#headersFor(url, init);
      const res = await this.fetchImpl(url, { ...init, headers, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`redirect without Location from ${url}`);
        url = new URL(loc, url).toString();
        continue;
      }
      if (res.status === 429 && rateAttempts < 5) {
        rateAttempts += 1;
        const retryAfter = Number(res.headers.get("retry-after") || 0);
        const waitMs = Math.max(retryAfter * 1000, this.rateLimitBackoffMs * rateAttempts);
        await sleep(waitMs);
        continue;
      }
      return res;
    }
    throw new Error(`too many redirects/retries fetching ${pathOrUrl}`);
  }

  #absoluteUrl(pathOrUrl: string): string {
    return /^https?:\/\//i.test(pathOrUrl)
      ? pathOrUrl
      : `${this.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
  }

  #headersFor(url: string, init: RequestInit): Headers {
    const headers = new Headers(init.headers);
    headers.set("User-Agent", UA);
    headers.set("Accept", "application/json, application/octet-stream, */*");
    if (this.#shouldAttach(url)) {
      headers.set("X-Agent-AccessKey", this.accessKey);
    }
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return headers;
  }

  #shouldAttach(url: string): boolean {
    if (shouldAttachContestCredential(url, this.baseUrl, this.trustedCredentialOrigins)) return true;
    // Live attachments often live on pro-resource.dasctf.com (signed OSS) — same org as the contest host.
    try {
      const host = new URL(url, this.baseUrl).hostname.toLowerCase();
      return host === "dasctf.com" || host.endsWith(".dasctf.com");
    } catch {
      return false;
    }
  }
}

export class DasctfRateLimitError extends Error {
  constructor(path: string, detail: string) {
    super(`DASCTF rate limited on ${path}: ${detail}`);
    this.name = "DasctfRateLimitError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
