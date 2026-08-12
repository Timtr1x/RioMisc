// LocalContestAdapter — single-challenge mode (`rio solve ./challenge`).
// Directory layout:
//   challenge/challenge.json   { title, category, description, score? }
//   challenge/attachments/*    optional files
//   challenge/answer.json      { flag: "..." } — used by submitFlag for verification
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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
import { z } from "zod";

const challengeJsonSchema = z.object({
  title: z.string().min(1),
  category: z.string().default("MISC"),
  description: z.string().default(""),
  score: z.number().nullable().optional(),
});

const answerJsonSchema = z.object({
  flag: z.string().min(1),
});

export class LocalContestAdapter implements ContestAdapter {
  readonly kind = "local";
  private readonly root: string;
  private readonly meta: z.infer<typeof challengeJsonSchema>;
  private readonly flag: string | null;
  private readonly attachments: { name: string; path: string }[];

  constructor(challengeDir: string) {
    this.root = resolve(challengeDir);
    this.meta = challengeJsonSchema.parse(JSON.parse(readFileSync(join(this.root, "challenge.json"), "utf8")));
    const attDir = join(this.root, "attachments");
    this.attachments = [];
    try {
      for (const name of readdirSync(attDir)) {
        const p = join(attDir, name);
        if (statSync(p).isFile()) this.attachments.push({ name, path: p });
      }
    } catch {
      // no attachments dir
    }
    try {
      this.flag = answerJsonSchema.parse(JSON.parse(readFileSync(join(this.root, "answer.json"), "utf8"))).flag;
    } catch {
      this.flag = null;
    }
  }

  async authenticate(): Promise<void> {}

  getCapabilities(): Promise<ContestCapabilities> {
    return Promise.resolve({
      polling: false,
      supportsStartChallenge: false,
      supportsHints: false,
      supportsLeaderboard: false,
      dynamicScoring: false,
      exposesSolveCount: false,
      hint: { unlockMode: "UNKNOWN", unlockDelayMs: null, hasPenalty: null },
      submission: { cooldownMs: 0, maxWrongAttempts: 10, hasPenalty: false },
      attachment: { maxConcurrentDownloads: 2 },
    });
  }

  async listChallenges(): Promise<RemoteChallenge[]> {
    return [this.#toRemote()];
  }

  async getChallenge(): Promise<RemoteChallengeDetail> {
    return {
      ...this.#toRemote(),
      attachments: this.attachments.map((a, i) => ({
        remoteId: `att-${i}`,
        name: a.name,
        url: null,
        sizeBytes: statSync(a.path).size,
      })),
    };
  }

  async getHint(): Promise<HintResult> {
    return { ok: false, notAvailable: true, message: "no hints in local mode" };
  }

  async submitFlag(_remoteId: string, flag: string): Promise<SubmissionResult> {
    if (this.flag === null) {
      return { ok: false, correct: false, status: "ERROR", message: "no answer.json — verification impossible", raw: {} };
    }
    if (flag === this.flag) {
      return { ok: true, correct: true, status: "CORRECT", raw: {} };
    }
    return { ok: true, correct: false, status: "WRONG", message: "wrong flag", raw: {} };
  }

  async downloadAttachment(
    _challenge: RemoteChallengeDetail,
    attachment: { remoteId: string | null; name: string; url: string | null },
    sink?: import("node:stream").Writable,
  ): Promise<DownloadResult> {
    const found = this.attachments.find((a) => a.name === attachment.name);
    if (!found) return { ok: false, bytes: 0, sha256: "", retryable: false, message: "attachment not found" };
    const buf = readFileSync(found.path);
    const hash = createHash("sha256").update(buf);
    if (sink) {
      sink.write(buf);
      sink.end();
    }
    return { ok: true, retryable: false, bytes: buf.length, sha256: hash.digest("hex") };
  }

  #toRemote(): RemoteChallenge {
    return {
      remoteId: "local",
      title: this.meta.title,
      description: this.meta.description,
      category: this.meta.category,
      score: this.meta.score ?? null,
      solveCount: null,
      createdAt: 0,
      updatedAt: 0,
    };
  }
}
