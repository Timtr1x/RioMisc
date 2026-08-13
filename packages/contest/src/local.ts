// LocalContestAdapter — single-challenge mode (`rio solve ./challenge`).
// Works with raw downloaded CTF challenge folders (no answer.json needed):
//   challenge/
//   ├── challenge.json   { title, category, description, score? }   (optional — auto-generated from folder name)
//   ├── attachments/     optional files
//   └── answer.json      { flag: "..." }                             (optional — auto verification)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
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

const META_NAMES = new Set(["challenge.json", "answer.json"]);

export class LocalContestAdapter implements ContestAdapter {
  readonly kind = "local";
  private readonly root: string;
  private readonly meta: z.infer<typeof challengeJsonSchema>;
  private readonly flag: string | null;
  private readonly attachments: { name: string; path: string }[];

  constructor(challengeDir: string) {
    this.root = resolve(challengeDir);
    // challenge.json is optional: raw downloaded folders work out of the box.
    let metaRaw: unknown = {};
    try {
      metaRaw = JSON.parse(readFileSync(join(this.root, "challenge.json"), "utf8"));
    } catch {
      metaRaw = { title: basename(this.root), category: "MISC", description: "" };
    }
    this.meta = challengeJsonSchema.parse(metaRaw);

    // attachments: everything under attachments/, plus stray files in the root
    // (excluding challenge.json / answer.json).
    this.attachments = [];
    const collect = (dir: string, metaFilesOnly = false) => {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (metaFilesOnly && META_NAMES.has(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isFile()) this.attachments.push({ name, path: p });
      }
    };
    collect(join(this.root, "attachments"));
    collect(this.root, true);

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
      // No local answer to compare against: report the candidate for manual review.
      return {
        ok: false,
        correct: false,
        status: "UNKNOWN",
        message: `no answer.json — candidate "${flag}" cannot be auto-verified (manual review)`,
        raw: { needsManualReview: true },
      };
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
