// Live CTFd-compatible contest adapter (CTFd / DASCTF and most forks).
// list → detail → download attachments → submit flags. Optional URL-inject overlay.
import { createHash } from "node:crypto";
import type {
  ContestCapabilities,
  RemoteChallenge,
  RemoteChallengeDetail,
  HintResult,
  SubmissionResult,
  DownloadResult,
} from "@rio/domain";
import type { ContestAdapter } from "./adapter.js";
import { normalizeTrustedOrigins, shouldAttachContestCredential } from "./credential.js";
import { MAX_REDIRECTS } from "./fetch-guard.js";
import { streamResponseToSink } from "./stream-body.js";

const UA = "rio-misc-agent/0.1 (CTF solver; authorized use)";
const DETAIL_TTL_MS = 60_000;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface CtfdAdapterOptions {
  baseUrl: string;
  token?: string | null;
  cookie?: string | null;
  /** When true (default), only ingest Misc / Crypto / 杂项 / 密码. */
  miscCryptoOnly?: boolean;
  fetchImpl?: FetchLike;
  /** Extra origins that may receive Token/Cookie/CSRF (e.g. the contest CDN). */
  trustedCredentialOrigins?: string[];
}

export interface ExternalChallengeInput {
  id: string;
  title: string;
  category: string;
  description: string;
  attachments: { name: string; data: Buffer }[];
}

const MISC_CRYPTO_MARKERS = [
  "misc",
  "crypto",
  "cryptography",
  "forensic",
  "osint",
  "杂项",
  "密码",
  "取证",
];

export function normalizeContestBaseUrl(raw: string): string {
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
  path = path.replace(/\/challenges(?:\/.*)?$/i, "");
  path = path.replace(/\/api\/v1(?:\/.*)?$/i, "");
  return `${parsed.origin}${path}`;
}

export function isMiscOrCryptoCategory(raw: string): boolean {
  const s = raw.trim().toLowerCase();
  if (!s) return true;
  return MISC_CRYPTO_MARKERS.some((m) => s.includes(m));
}

export function mapCtfdSubmitStatus(status: string, raw: unknown): SubmissionResult {
  const s = status.toLowerCase().replace(/[\s-]+/g, "_");
  if (s === "correct" || s === "already_solved") {
    return { ok: true, correct: true, status: "CORRECT", raw };
  }
  if (s === "incorrect" || s === "wrong") {
    return { ok: true, correct: false, status: "WRONG", raw };
  }
  if (s === "ratelimited" || s === "rate_limited" || s === "paused") {
    return { ok: false, correct: false, status: "RATE_LIMITED", cooldownMs: 60_000, message: status, raw };
  }
  return { ok: false, correct: false, status: "UNKNOWN", message: status || "unrecognized submit status", raw };
}

export function parseCtfdRemoteId(remoteId: string): number {
  const m = /^ctfd:[^:]+:(\d+)$/.exec(remoteId) ?? /^(\d+)$/.exec(remoteId);
  if (!m) throw new Error(`not a CTFd challenge id: ${remoteId}`);
  return Number(m[1]);
}

export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<li>/gi, "- ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function fileNameFromUrl(url: string): string {
  try {
    const path = new URL(url, "http://local.invalid").pathname;
    return decodeURIComponent(path.split("/").filter(Boolean).pop() ?? "attachment");
  } catch {
    return "attachment";
  }
}

export function parseCtfdFiles(files: unknown, challengeId: number, baseUrl: string): RemoteChallengeDetail["attachments"] {
  if (!Array.isArray(files)) return [];
  return files.map((f, i) => {
    const url = typeof f === "string" ? f : String((f as { url?: string; location?: string }).url ?? (f as { location?: string }).location ?? "");
    const name =
      typeof f === "object" && f && "name" in f && (f as { name?: string }).name
        ? String((f as { name: string }).name)
        : fileNameFromUrl(url);
    return {
      remoteId: `file-${challengeId}-${i}`,
      name: name || `attachment-${i}`,
      url: url ? new URL(url, baseUrl).toString() : null,
      sizeBytes: null as number | null,
    };
  });
}

type CachedDetail = { fetchedAt: number; detail: RemoteChallengeDetail; hintIds: { id: number; cost: number }[] };

export class CtfdContestAdapter implements ContestAdapter {
  readonly kind = "ctfd";
  readonly baseUrl: string;
  readonly miscCryptoOnly: boolean;
  private readonly token: string | null;
  private readonly cookie: string | null;
  private readonly fetchImpl: FetchLike;
  readonly trustedCredentialOrigins: string[];
  private csrf: string | null = null;
  private cache = new Map<number, CachedDetail>();
  private extras = new Map<string, { remote: RemoteChallengeDetail; files: Map<string, Buffer> }>();
  private hostKey: string;

  constructor(opts: CtfdAdapterOptions) {
    this.baseUrl = normalizeContestBaseUrl(opts.baseUrl);
    this.token = opts.token?.trim() || null;
    this.cookie = opts.cookie?.trim() || null;
    this.miscCryptoOnly = opts.miscCryptoOnly !== false;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.trustedCredentialOrigins = normalizeTrustedOrigins(opts.trustedCredentialOrigins);
    this.hostKey = new URL(this.baseUrl).host.replace(/[^a-zA-Z0-9.-]/g, "_");
  }

  async authenticate(): Promise<void> {
    const json = await this.#getJson("/api/v1/challenges");
    const data = Array.isArray(json) ? json : json?.data;
    if (!Array.isArray(data)) {
      throw new Error("比赛 API /api/v1/challenges 响应无法识别（需要 CTFd 兼容平台）");
    }
  }

  getCapabilities(): Promise<ContestCapabilities> {
    return Promise.resolve({
      polling: true,
      supportsStartChallenge: false,
      supportsHints: true,
      supportsLeaderboard: false,
      dynamicScoring: true,
      exposesSolveCount: true,
      hint: { unlockMode: "UNKNOWN", unlockDelayMs: null, hasPenalty: null },
      submission: { cooldownMs: null, maxWrongAttempts: null, hasPenalty: null },
      attachment: { maxConcurrentDownloads: 2 },
    });
  }

  async listChallenges(): Promise<RemoteChallenge[]> {
    const items = await this.#listAll();
    const out: RemoteChallenge[] = [];
    for (const item of items) {
      if (item.solved_by_me === true) continue;
      const category = String(item.category ?? "");
      if (this.miscCryptoOnly && !isMiscOrCryptoCategory(category)) continue;
      const id = Number(item.id);
      if (!Number.isFinite(id)) continue;
      const description = item.description != null ? stripHtml(String(item.description)) : "";
      out.push({
        remoteId: this.#remoteId(id),
        title: String(item.name ?? `challenge-${id}`),
        description,
        category,
        score: typeof item.value === "number" ? item.value : null,
        solveCount: typeof item.solves === "number" ? item.solves : null,
        createdAt: null,
        updatedAt: Date.now(),
        attachments: parseCtfdFiles(item.files, id, this.baseUrl),
      });
    }
    for (const extra of this.extras.values()) out.push(extra.remote);
    return out;
  }

  async getChallenge(remoteId: string): Promise<RemoteChallengeDetail> {
    const extra = this.extras.get(remoteId);
    if (extra) return extra.remote;
    const id = parseCtfdRemoteId(remoteId);
    const cached = this.cache.get(id);
    if (cached && Date.now() - cached.fetchedAt < DETAIL_TTL_MS) return cached.detail;
    const json = await this.#getJson(`/api/v1/challenges/${id}`);
    const d = (json?.data ?? json) as Record<string, unknown>;
    const attachments = parseCtfdFiles(d.files, id, this.baseUrl);
    let description = stripHtml(String(d.description ?? ""));
    if (d.connection_info) description = `${description}\n\n连接信息：${d.connection_info}`.trim();
    const hints = Array.isArray(d.hints) ? d.hints : [];
    const hintIds = hints
      .map((h) => {
        if (typeof h === "number") return { id: h, cost: 0 };
        const rec = h as { id?: number; cost?: number };
        return { id: Number(rec.id), cost: Number(rec.cost ?? 0) };
      })
      .filter((h) => Number.isFinite(h.id));
    const detail: RemoteChallengeDetail = {
      remoteId: this.#remoteId(id),
      title: String(d.name ?? `challenge-${id}`),
      description,
      category: String(d.category ?? ""),
      score: typeof d.value === "number" ? d.value : null,
      solveCount: typeof d.solves === "number" ? d.solves : null,
      createdAt: null,
      updatedAt: Date.now(),
      attachments,
    };
    this.cache.set(id, { fetchedAt: Date.now(), detail, hintIds });
    return detail;
  }

  async getHint(remoteId: string): Promise<HintResult> {
    if (this.extras.has(remoteId)) return { ok: false, notAvailable: true, message: "no contest hints for injected challenge" };
    const id = parseCtfdRemoteId(remoteId);
    await this.getChallenge(remoteId);
    const hintIds = this.cache.get(id)?.hintIds ?? [];
    if (hintIds.length === 0) return { ok: false, notAvailable: true, message: "platform has no hints for this challenge" };
    const sorted = [...hintIds].sort((a, b) => a.cost - b.cost);
    for (const h of sorted) {
      const text = await this.#readHint(h.id);
      if (text) return { ok: true, hint: text };
    }
    return { ok: false, notAvailable: true, message: "hints locked or unlock failed" };
  }

  async submitFlag(remoteId: string, flag: string): Promise<SubmissionResult> {
    if (this.extras.has(remoteId)) {
      return {
        ok: false,
        correct: false,
        status: "UNKNOWN",
        message: `injected challenge has no contest judge — candidate "${flag}" needs manual review`,
        raw: { needsManualReview: true },
      };
    }
    const id = parseCtfdRemoteId(remoteId);
    const json = await this.#postJson("/api/v1/challenges/attempt", { challenge_id: id, submission: flag });
    const data = (json?.data ?? json) as Record<string, unknown>;
    const status = String(data.status ?? data.result ?? "");
    return mapCtfdSubmitStatus(status, json);
  }

  async downloadAttachment(
    _challenge: RemoteChallengeDetail,
    attachment: { remoteId: string | null; name: string; url: string | null },
    sink?: import("node:stream").Writable,
  ): Promise<DownloadResult> {
    const extra = [...this.extras.values()].find((e) => e.files.has(attachment.name) && e.remote.attachments.some((a) => a.name === attachment.name));
    if (extra) {
      const buf = extra.files.get(attachment.name)!;
      if (sink) {
        sink.write(buf);
        sink.end();
      }
      return { ok: true, retryable: false, bytes: buf.length, sha256: createHash("sha256").update(buf).digest("hex") };
    }
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

  addExternalChallenge(input: ExternalChallengeInput): void {
    if (this.extras.has(input.id)) throw new Error(`challenge ${input.id} already exists`);
    const attachments = input.attachments.map((a, i) => ({
      remoteId: `ext-${i}`,
      name: a.name,
      url: `overlay://${input.id}/${encodeURIComponent(a.name)}`,
      sizeBytes: a.data.length,
    }));
    this.extras.set(input.id, {
      remote: {
        remoteId: input.id,
        title: input.title,
        description: input.description,
        category: input.category,
        score: null,
        solveCount: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        attachments,
      },
      files: new Map(input.attachments.map((a) => [a.name, a.data])),
    });
  }

  #remoteId(id: number): string {
    return `ctfd:${this.hostKey}:${id}`;
  }

  async #listAll(): Promise<Array<Record<string, unknown>>> {
    const items: Array<Record<string, unknown>> = [];
    let page = 1;
    for (;;) {
      const json = await this.#getJson(`/api/v1/challenges?page=${page}`);
      const data = Array.isArray(json) ? json : json?.data;
      if (!Array.isArray(data)) throw new Error("CTFd /challenges 响应格式无法识别");
      for (const row of data) items.push(row as Record<string, unknown>);
      const next = (json?.meta as { pagination?: { next?: number | null } } | undefined)?.pagination?.next;
      if (!next || next === page) break;
      page = next;
      if (page > 50) break;
    }
    return items;
  }

  async #readHint(hintId: number): Promise<string | null> {
    const first = await this.#getJson(`/api/v1/hints/${hintId}`);
    const d = (first?.data ?? first) as Record<string, unknown>;
    const content = d.content ?? d.hint;
    if (typeof content === "string" && content.trim()) return stripHtml(content);
    try {
      await this.#postJson("/api/v1/unlocks", { target: hintId, type: "hints" });
    } catch {
      return null;
    }
    const again = await this.#getJson(`/api/v1/hints/${hintId}`);
    const d2 = (again?.data ?? again) as Record<string, unknown>;
    const unlocked = d2.content ?? d2.hint;
    return typeof unlocked === "string" && unlocked.trim() ? stripHtml(unlocked) : null;
  }

  async #getJson(path: string): Promise<Record<string, unknown> & { data?: unknown; meta?: unknown; success?: boolean }> {
    const res = await this.#request(path);
    return this.#parseJson(res, path);
  }

  async #postJson(path: string, body: unknown): Promise<Record<string, unknown> & { data?: unknown }> {
    const res = await this.#request(path, { method: "POST", body: JSON.stringify(body) });
    return this.#parseJson(res, path);
  }

  async #parseJson(res: Response, path: string): Promise<Record<string, unknown> & { data?: unknown; meta?: unknown }> {
    const text = await res.text();
    if (res.status === 401 || res.status === 403) {
      throw new Error(`鉴权失败 (${res.status})：请检查 Access Token 或 Cookie 是否有效`);
    }
    if (!res.ok) {
      throw new Error(`比赛 API ${res.status} ${path}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text) as Record<string, unknown> & { data?: unknown; meta?: unknown };
    } catch {
      throw new Error("比赛 API 返回的不是 JSON（可能不是 CTFd 兼容平台，或页面需要登录）");
    }
  }

  async #request(pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
    let url = this.#absoluteUrl(pathOrUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const headers = this.#headersFor(url, init);
      const res = await this.fetchImpl(url, { ...init, headers, redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) throw new Error(`redirect without Location from ${url}`);
        url = new URL(loc, url).toString();
        continue;
      }
      return res;
    }
    throw new Error(`too many redirects (${MAX_REDIRECTS}) fetching ${pathOrUrl}`);
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
    if (this.#shouldAttachContestCredential(url)) {
      if (this.token) {
        headers.set(
          "Authorization",
          this.token.startsWith("Bearer ") || this.token.startsWith("Token ") ? this.token : `Token ${this.token}`,
        );
      }
      if (this.cookie) headers.set("Cookie", this.cookie);
      if (this.csrf) headers.set("CSRF-Token", this.csrf);
    }
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    return headers;
  }

  #shouldAttachContestCredential(url: string): boolean {
    return shouldAttachContestCredential(url, this.baseUrl, this.trustedCredentialOrigins);
  }
}
