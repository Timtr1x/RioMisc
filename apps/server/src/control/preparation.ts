// PreparationService (Phase 4): attachment streaming download + workspace +
// challenge.txt + triage. Idempotent: re-runs safely after crash.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, statSync, renameSync, unlinkSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { RioLogger } from "@rio/shared";
import type { Repositories } from "@rio/database";
import type { Challenge, RemoteChallengeDetail, RemoteAttachment } from "@rio/domain";
import type { ContestAdapter } from "@rio/contest";
import { DiskManager } from "@rio/contest";
import { WorkspaceManager, type WorkspaceLayout, resolveAttachmentTarget } from "@rio/tool-runtime";
import { buildChallengeFile, triage } from "@rio/solver";
import type { EventBus } from "./bus.js";
import type { StateMachine } from "../state-machine.js";
import { upsertRemoteAttachments } from "./challenge-sync.js";

export class PreparationService {
  private active = new Set<string>();
  private downloads = 0;

  constructor(
    private deps: {
      repos: Repositories;
      adapter: ContestAdapter;
      workspace: WorkspaceManager;
      disk: DiskManager;
      stateMachine: StateMachine;
      bus: EventBus;
      logger: RioLogger;
      dataDir: string;
      maxConcurrentDownloads: number;
      pythonExecutable: string;
    },
  ) {}

  replaceAdapter(adapter: ContestAdapter): void {
    this.deps.adapter = adapter;
  }

  async prepare(challenge: Challenge): Promise<void> {
    if (this.active.has(challenge.id)) return;
    this.active.add(challenge.id);
    try {
      await this.#prepareInner(challenge);
    } finally {
      this.active.delete(challenge.id);
    }
  }

  async #prepareInner(challenge: Challenge): Promise<void> {
    const { repos, adapter, logger } = this.deps;
    this.deps.stateMachine.transition(challenge.id, "PREPARE_START", { payload: {} });

    // 1. remote detail + attachment rows
    let detail: RemoteChallengeDetail;
    try {
      detail = await this.deps.adapter.getChallenge(challenge.remoteId ?? "local");
    } catch {
      // local adapter: getChallenge takes no remoteId
      const localAdapter = this.deps.adapter as unknown as { getChallenge: () => Promise<RemoteChallengeDetail> };
      detail = await localAdapter.getChallenge();
    }

    upsertRemoteAttachments(repos, challenge.id, detail.attachments);
    await this.downloadPending(challenge, detail);
    const layout = this.deps.workspace.ensure(challenge.id);

    // 3. triage + challenge.txt
    const atts = repos.attachments.listByChallenge(challenge.id);
    const result = triage({
      title: challenge.title,
      description: challenge.description,
      category: challenge.category,
      attachments: atts.map((a) => ({ name: a.name, sizeBytes: a.sizeBytes, localPath: a.localPath })),
    });
    const hints = repos.hints.listForChallenge(challenge.id).map((h) => h.content);
    const wrongFlags = repos.submissions
      .listByChallenge(challenge.id)
      .filter((s) => s.status === "WRONG")
      .map((s) => s.flagValue);

    const challengeTxt = buildChallengeFile({
      title: challenge.title,
      description: challenge.description,
      category: challenge.category,
      attachments: atts.map((a) => ({ name: a.name, localPath: a.localPath, sizeBytes: a.sizeBytes })),
      hints,
      wrongFlags,
    });
    writeFileSync(join(layout.root, "challenge.txt"), challengeTxt, "utf8");

    repos.challenges.update(challenge.id, {
      subcategory: result.subcategory.join(",") || null,
      difficultyEstimate: result.difficulty,
      // blockedReason cleared on success
      blockedReason: null,
    });
    logger.info({ event: "challenge_ready", challengeId: challenge.id, triage: result.summary });
    this.deps.stateMachine.transition(challenge.id, "PREPARE_DONE", { payload: { triage: result.summary } });
  }

  /** Download PENDING/FAILED attachments without a lifecycle transition (revision path). */
  async downloadPending(challenge: Challenge, detail?: RemoteChallengeDetail): Promise<void> {
    const { repos, adapter } = this.deps;
    let resolved = detail;
    if (!resolved) {
      try {
        resolved = await adapter.getChallenge(challenge.remoteId ?? "local");
      } catch {
        const localAdapter = adapter as unknown as { getChallenge: () => Promise<RemoteChallengeDetail> };
        resolved = await localAdapter.getChallenge();
      }
    }
    const layout = this.deps.workspace.ensure(challenge.id);
    const attachments = repos.attachments.listByChallenge(challenge.id);
    for (const att of attachments) {
      if (att.downloadStatus === "DOWNLOADED" && att.localPath && existsSync(att.localPath)) continue;
      await this.#downloadOne(challenge, resolved, att, layout);
    }
    this.refreshChallengeFile(challenge.id);
  }

  /** Streaming download: HTTP stream → tee (sha256) → .part file → atomic rename. */
  async #downloadOne(challenge: Challenge, detail: RemoteChallengeDetail, att: { id: string; name: string; remoteId: string | null; remoteUrl: string | null; sizeBytes: number | null }, layout: WorkspaceLayout): Promise<void> {
    const { repos, logger } = this.deps;
    // concurrency gate
    while (this.downloads >= this.deps.maxConcurrentDownloads) {
      await new Promise((r) => setTimeout(r, 500));
    }
    this.downloads++;
    try {
      const ra: RemoteAttachment = { remoteId: att.remoteId, name: att.name, url: att.remoteUrl, sizeBytes: att.sizeBytes };
      const used = new Set(
        repos.attachments
          .listByChallenge(challenge.id)
          .filter((a) => a.id !== att.id && a.localPath)
          .map((a) => (a.localPath ?? "").split(/[\\/]/).pop()?.toLowerCase() ?? ""),
      );
      const { safeName, target } = resolveAttachmentTarget(this.deps.workspace, layout, att.name, att.id, used);
      if (safeName !== att.name) {
        logger.warn({ event: "attachment_name_sanitized", challengeId: challenge.id, attachmentId: att.id }, "remote attachment name sanitized");
      }
      const part = `${target}.part`;

      // disk budget check
      const budget = this.deps.disk.canDownload(att.sizeBytes ?? 0);
      if (!budget.ok) {
        repos.attachments.update(att.id, { downloadStatus: "FAILED" });
        repos.challenges.update(challenge.id, { blockedReason: budget.reason });
        logger.warn({ event: "download_blocked", challengeId: challenge.id, reason: budget.reason });
        throw new Error(budget.reason);
      }

      repos.attachments.setDownloadStatus(att.id, "DOWNLOADING");
      this.deps.bus.publish({ type: "ATTACHMENT_DOWNLOAD_STARTED", challengeId: challenge.id, payload: { name: att.name } });

      const hash = createHash("sha256");
      const fileStream = createWriteStream(part);
      const sink: PassThrough = new PassThrough();
      let bytes = 0;
      sink.on("data", (c: Buffer) => {
        hash.update(c);
        bytes += c.length;
      });
      sink.pipe(fileStream);
      const finished = new Promise<void>((resolveDone, rejectDone) => {
        fileStream.on("finish", () => resolveDone());
        fileStream.on("error", rejectDone);
        sink.on("error", rejectDone);
      });

      const result = await this.deps.adapter.downloadAttachment(detail, ra, sink);
      if (!result.ok) {
        fileStream.destroy();
        try {
          unlinkSync(part);
        } catch {
          /* ignore */
        }
        repos.attachments.update(att.id, { downloadStatus: "FAILED" });
        this.deps.bus.publish({ type: "ATTACHMENT_DOWNLOAD_FAILED", challengeId: challenge.id, payload: { name: att.name, message: result.message } });
        throw new Error(`download failed for ${att.name}: ${result.message ?? "unknown"}`);
      }

      if (!sink.writableEnded) sink.end();
      await finished;

      const sha = hash.digest("hex");
      if (att.sizeBytes !== null && bytes !== att.sizeBytes) {
        try {
          unlinkSync(part);
        } catch {
          /* ignore */
        }
        repos.attachments.update(att.id, { downloadStatus: "FAILED" });
        throw new Error(`size mismatch for ${att.name}: got ${bytes}, expected ${att.sizeBytes}`);
      }
      renameSync(part, target);

      const art = repos.artifacts.create({
        challengeId: challenge.id,
        parentArtifactId: null,
        path: target.replaceAll("\\", "/"),
        mime: "application/octet-stream",
        size: statSync(target).size,
        sha256: sha,
        generatedBy: "DOWNLOAD",
        operation: "download_attachment",
      });
      repos.attachments.update(att.id, { localPath: target, sizeBytes: bytes, sha256: sha, downloadStatus: "DOWNLOADED" });
      repos.attachments.setDownloadStatus(att.id, "DOWNLOADED");
      this.deps.bus.publish({ type: "ATTACHMENT_DOWNLOADED", challengeId: challenge.id, payload: { name: att.name, bytes, sha256: sha, artifactId: art.id } });
      logger.info({ event: "attachment_downloaded", challengeId: challenge.id, name: att.name, bytes });
    } finally {
      this.downloads--;
    }
  }

  /** Rebuild challenge.txt after hint/wrong-flag/update events. */
  refreshChallengeFile(challengeId: string): void {
    const challenge = this.deps.repos.challenges.get(challengeId);
    if (!challenge) return;
    const layout = this.deps.workspace.ensure(challengeId);
    const atts = this.deps.repos.attachments.listByChallenge(challengeId);
    const hints = this.deps.repos.hints.listForChallenge(challengeId).map((h) => h.content);
    const wrongFlags = this.deps.repos.submissions
      .listByChallenge(challengeId)
      .filter((s) => s.status === "WRONG")
      .map((s) => s.flagValue);
    const txt = buildChallengeFile({
      title: challenge.title,
      description: challenge.description,
      category: challenge.category,
      attachments: atts.map((a) => ({ name: a.name, localPath: a.localPath, sizeBytes: a.sizeBytes })),
      hints,
      wrongFlags,
    });
    writeFileSync(join(layout.root, "challenge.txt"), txt, "utf8");
  }
}
