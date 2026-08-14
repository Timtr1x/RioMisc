// MockContestAdapter — a fully simulated CTF competition API.
// Serves real attachment bytes over a local HTTP server so the download
// pipeline is exercised end-to-end (streaming, hashing, retries, failures).
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import type {
  ContestCapabilities,
  RemoteChallenge,
  RemoteChallengeDetail,
  StartChallengeResult,
  HintResult,
  SubmissionResult,
  DownloadResult,
} from "@rio/domain";
import type { ContestAdapter } from "./adapter.js";
import { buildFixtures, type FixtureChallenge } from "./fixtures.js";
import { streamResponseToSink } from "./stream-body.js";

export type MockOp = "list" | "detail" | "download" | "start" | "hint" | "submit";

export interface MockFailRule {
  /** Seconds since scenario start when the rule becomes active. */
  afterSeconds: number;
  op: MockOp;
  /** Probability the rule triggers (0..1). */
  rate: number;
  kind: "429" | "500" | "timeout";
}

export interface MockScenario {
  releaseSchedule: { afterSeconds: number; challengeIds: string[] }[];
  updateSchedule?: { afterSeconds: number; challengeId: string; patch: { title?: string; description?: string } }[];
  failRules?: MockFailRule[];
  hintDelayMs?: number;
  submissionCooldownMs?: number;
  maxWrongAttempts?: number;
  maxConcurrentDownloads?: number;
}

interface MockState {
  challenge: FixtureChallenge;
  releasedAt: number | null;
  startedAt: number | null;
  title: string;
  description: string;
  updatedAt: number | null;
}

export class MockContestAdapter implements ContestAdapter {
  readonly kind: string = "mock";
  private server: Server | null = null;
  private baseUrl = "";
  private startedAt = 0;
  private states = new Map<string, MockState>();
  private submitted = new Map<string, { lastAt: number; wrongCount: number; flags: Set<string> }>();
  private scenario: MockScenario;
  private clock: () => number;
  private authOk = false;

  constructor(scenario: Partial<MockScenario> = {}, clock: () => number = () => Date.now()) {
    this.scenario = {
      hintDelayMs: 600_000,
      submissionCooldownMs: 0,
      maxWrongAttempts: 10,
      maxConcurrentDownloads: 2,
      ...scenario,
      releaseSchedule: scenario.releaseSchedule ?? [{ afterSeconds: 0, challengeIds: [] }],
    };
    this.clock = clock;
  }

  /** Test helper: advance the scenario clock (hint eligibility, releases, ...). */
  fastForward(ms: number): void {
    this.startedAt -= ms;
  }

  elapsedMs(): number {
    return this.clock() - this.startedAt;
  }

  async authenticate(): Promise<void> {
    this.authOk = true;
    this.startedAt = this.clock();
    if (!this.server) {
      this.server = createServer((req, res) => {
        const match = /^\/files\/([^/]+)\/(.+)$/.exec(req.url ?? "");
        if (!match) {
          res.writeHead(404).end();
          return;
        }
        const challengeId = match[1]!;
        const name = decodeURIComponent(match[2]!);
        const state = this.states.get(challengeId);
        const att = state?.challenge.attachments.find((a) => a.name === name);
        if (!att) {
          res.writeHead(404).end();
          return;
        }
        if (this.#shouldFail("download")) {
          const kind = this.#failKind("download");
          if (kind === "429") {
            res.writeHead(429, { "Retry-After": "2" }).end("rate limited");
            return;
          }
          if (kind === "500") {
            res.writeHead(500).end("internal error");
            return;
          }
          // timeout: hold the response until the client gives up
          setTimeout(() => res.writeHead(200).end(att.bytes), 30_000);
          return;
        }
        res.writeHead(200, { "Content-Length": String(att.bytes.length), "Content-Type": "application/octet-stream" });
        res.end(att.bytes);
      });
      this.server.listen(0, "127.0.0.1");
    }
    await once(this.server, "listening");
    const addr = this.server.address();
    if (addr && typeof addr === "object") this.baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  getCapabilities(): Promise<ContestCapabilities> {
    return Promise.resolve({
      polling: true,
      supportsStartChallenge: true,
      supportsHints: true,
      supportsLeaderboard: false,
      dynamicScoring: false,
      exposesSolveCount: false,
      hint: {
        unlockMode: "AFTER_START",
        unlockDelayMs: this.scenario.hintDelayMs ?? 600_000,
        hasPenalty: false,
      },
      submission: {
        cooldownMs: this.scenario.submissionCooldownMs ?? 0,
        maxWrongAttempts: this.scenario.maxWrongAttempts ?? 10,
        hasPenalty: false,
      },
      attachment: {
        maxConcurrentDownloads: this.scenario.maxConcurrentDownloads ?? 2,
      },
    });
  }

  async listChallenges(): Promise<RemoteChallenge[]> {
    this.#requireAuth();
    await this.#maybeDelay("list");
    const out: RemoteChallenge[] = [];
    for (const state of this.states.values()) {
      if (state.releasedAt !== null && this.elapsedMs() >= state.releasedAt) {
        out.push(this.#toRemote(state));
      }
    }
    return out;
  }

  async getChallenge(remoteId: string): Promise<RemoteChallengeDetail> {
    this.#requireAuth();
    await this.#maybeDelay("detail");
    const state = this.states.get(remoteId);
    if (!state) throw new Error(`Mock: unknown challenge ${remoteId}`);
    const detail: RemoteChallengeDetail = {
      ...this.#toRemote(state),
      attachments: this.#attachmentsOf(state),
    };
    return detail;
  }

  async startChallenge(remoteId: string): Promise<StartChallengeResult> {
    this.#requireAuth();
    await this.#maybeDelay("start");
    const state = this.states.get(remoteId);
    if (!state) return { ok: false, message: "unknown challenge" };
    if (state.startedAt === null) state.startedAt = this.clock();
    return { ok: true, message: "started" };
  }

  async getHint(remoteId: string): Promise<HintResult> {
    this.#requireAuth();
    await this.#maybeDelay("hint");
    const state = this.states.get(remoteId);
    if (!state) return { ok: false, message: "unknown challenge" };
    if (state.startedAt === null) return { ok: false, notAvailable: true, message: "challenge not started" };
    const delay = this.scenario.hintDelayMs ?? 600_000;
    if (this.clock() - state.startedAt < delay) {
      return { ok: false, notAvailable: true, message: "hint locked" };
    }
    return { ok: true, hint: `Hint for ${state.challenge.id}: ${state.challenge.description}` };
  }

  async submitFlag(remoteId: string, flag: string): Promise<SubmissionResult> {
    this.#requireAuth();
    await this.#maybeDelay("submit");
    const state = this.states.get(remoteId);
    if (!state) return { ok: false, correct: false, status: "ERROR", message: "unknown challenge", raw: {} };
    const rec = this.submitted.get(remoteId) ?? { lastAt: 0, wrongCount: 0, flags: new Set<string>() };
    const cooldown = this.scenario.submissionCooldownMs ?? 0;
    if (cooldown > 0 && this.clock() - rec.lastAt < cooldown) {
      return { ok: false, correct: false, status: "RATE_LIMITED", cooldownMs: cooldown, message: "cooldown", raw: {} };
    }
    rec.lastAt = this.clock();
    if (rec.flags.has(flag)) {
      return { ok: false, correct: false, status: "RATE_LIMITED", message: "duplicate submission", raw: {} };
    }
    rec.flags.add(flag);
    if (state.challenge.flag === "") {
      // 外部注入的题目（URL 抓取等）没有已知答案 — 候选 flag 供人工验证
      return {
        ok: false,
        correct: false,
        status: "UNKNOWN",
        message: `no known answer for external challenge — candidate "${flag}" requires manual verification`,
        raw: { needsManualReview: true },
      };
    }
    if (flag === state.challenge.flag) {
      return { ok: true, correct: true, status: "CORRECT", raw: { remoteId } };
    }
    rec.wrongCount += 1;
    const maxWrong = this.scenario.maxWrongAttempts ?? 10;
    const remaining = Math.max(0, maxWrong - rec.wrongCount);
    this.submitted.set(remoteId, rec);
    return {
      ok: true,
      correct: false,
      status: "WRONG",
      message: `wrong flag (${remaining} attempts left)`,
      raw: { remoteId },
    };
  }

  async downloadAttachment(
    _challenge: RemoteChallengeDetail,
    attachment: { remoteId: string | null; name: string; url: string | null },
    sink?: import("node:stream").Writable,
  ): Promise<DownloadResult> {
    this.#requireAuth();
    if (!attachment.url) return { ok: false, bytes: 0, sha256: "", retryable: false, message: "no url" };
    const res = await fetch(attachment.url);
    if (res.status === 429) {
      return { ok: false, bytes: 0, sha256: "", retryable: true, message: "429 rate limited" };
    }
    if (!res.ok) {
      return { ok: false, bytes: 0, sha256: "", retryable: res.status >= 500, message: `HTTP ${res.status}` };
    }
    const streamed = await streamResponseToSink(res, sink);
    if (!streamed.ok) {
      return { ok: false, bytes: streamed.bytes, sha256: streamed.sha256, retryable: streamed.retryable, message: streamed.message };
    }
    return { ok: true, retryable: false, bytes: streamed.bytes, sha256: streamed.sha256 };
  }

  replaceAttachments(remoteId: string, attachments: { name: string; bytes: Buffer }[]): void {
    const state = this.states.get(remoteId);
    if (!state) throw new Error(`Mock: unknown challenge ${remoteId}`);
    state.challenge.attachments = attachments;
    state.updatedAt = this.clock();
  }

  // -------------------------------------------------------------------------
  // Scenario control
  // -------------------------------------------------------------------------

  /** Apply release + update schedules. Call before/inside polling. */
  async applySchedule(): Promise<void> {
    const elapsed = this.elapsedMs();
    for (const group of this.scenario.releaseSchedule) {
      if (elapsed >= group.afterSeconds * 1000) {
        for (const id of group.challengeIds) {
          const state = this.states.get(id);
          if (state && state.releasedAt === null) state.releasedAt = group.afterSeconds * 1000;
        }
      }
    }
    for (const upd of this.scenario.updateSchedule ?? []) {
      if (elapsed >= upd.afterSeconds * 1000) {
        const state = this.states.get(upd.challengeId);
        if (state) {
          if (upd.patch.title) state.title = upd.patch.title;
          if (upd.patch.description) state.description = upd.patch.description;
          state.updatedAt = this.clock();
        }
      }
    }
  }

  loadFixtures(fixtures: FixtureChallenge[] = buildFixtures()): void {
    this.states.clear();
    for (const f of fixtures) {
      this.states.set(f.id, {
        challenge: f,
        releasedAt: null,
        startedAt: null,
        title: f.title,
        description: f.description,
        updatedAt: null,
      });
    }
    // If no release schedule with actual challenge ids was configured, release everything immediately.
    const hasIds = (this.scenario.releaseSchedule ?? []).some((g) => g.challengeIds.length > 0);
    if (!hasIds) {
      this.scenario.releaseSchedule = [{ afterSeconds: 0, challengeIds: fixtures.map((f) => f.id) }];
    }
  }

  /**
   * 动态注入一道外部题目（来自 URL 抓取等），立即发布。
   * 附件字节由 mock 的 HTTP server 提供，走完整下载/分析/解题流程。
   */
  addExternalChallenge(input: {
    id: string;
    title: string;
    category: string;
    description: string;
    attachments: { name: string; data: Buffer }[];
  }): void {
    if (this.states.has(input.id)) {
      throw new Error(`challenge ${input.id} already exists`);
    }
    const fixture: FixtureChallenge = {
      id: input.id,
      title: input.title,
      description: input.description,
      category: input.category,
      flag: "", // 未知答案 — 提交返回 UNKNOWN，候选 flag 供人工验证
      attachments: input.attachments.map((a) => ({ name: a.name, bytes: a.data })),
    };
    this.states.set(input.id, {
      challenge: fixture,
      releasedAt: 0,
      startedAt: null,
      title: input.title,
      description: input.description,
      updatedAt: null,
    });
    // 确保 releaseSchedule 覆盖它（poller 的 applySchedule 会发布）
    const schedule = this.scenario.releaseSchedule ?? [];
    const group = schedule.find((g) => g.afterSeconds === 0);
    if (group) {
      if (!group.challengeIds.includes(input.id)) group.challengeIds.push(input.id);
    } else {
      schedule.push({ afterSeconds: 0, challengeIds: [input.id] });
      this.scenario.releaseSchedule = schedule;
    }
  }

  getFixtureFlag(remoteId: string): string | null {
    return this.states.get(remoteId)?.challenge.flag ?? null;
  }

  forgetChallenge(remoteId: string): void {
    this.states.delete(remoteId);
    this.submitted.delete(remoteId);
    for (const group of this.scenario.releaseSchedule ?? []) {
      group.challengeIds = group.challengeIds.filter((id) => id !== remoteId);
    }
  }

  async close(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #requireAuth() {
    if (!this.authOk) throw new Error("Mock: authenticate() not called");
  }

  #attachmentsOf(state: MockState) {
    return state.challenge.attachments.map((a, i) => ({
      remoteId: `att-${i}`,
      name: a.name,
      url: this.baseUrl ? `${this.baseUrl}/files/${state.challenge.id}/${encodeURIComponent(a.name)}` : null,
      sizeBytes: a.bytes.length,
    }));
  }

  #toRemote(state: MockState): RemoteChallenge {
    return {
      remoteId: state.challenge.id,
      title: state.title,
      description: state.description,
      category: state.challenge.category,
      score: 100,
      solveCount: null,
      createdAt: state.releasedAt ?? 0,
      updatedAt: state.updatedAt ?? state.releasedAt ?? 0,
      attachments: this.#attachmentsOf(state),
    };
  }

  #shouldFail(op: MockOp): boolean {
    const rule = (this.scenario.failRules ?? []).find(
      (r) => r.op === op && this.elapsedMs() >= r.afterSeconds * 1000,
    );
    if (!rule) return false;
    return Math.random() < rule.rate;
  }

  #failKind(op: MockOp): "429" | "500" | "timeout" {
    const rules = (this.scenario.failRules ?? []).filter(
      (r) => r.op === op && this.elapsedMs() >= r.afterSeconds * 1000,
    );
    return rules[Math.floor(Math.random() * rules.length)]?.kind ?? "500";
  }

  async #maybeDelay(op: MockOp): Promise<void> {
    if (this.#shouldFail(op)) {
      const kind = this.#failKind(op);
      if (kind === "429") throw Object.assign(new Error("Mock: 429 Too Many Requests"), { statusCode: 429 });
      if (kind === "500") throw Object.assign(new Error("Mock: 500 Internal Server Error"), { statusCode: 500 });
      // timeout — hang briefly; the caller's own timeout will fire
      await new Promise((r) => setTimeout(r, 30_000));
    }
  }
}
