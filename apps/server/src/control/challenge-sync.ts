// Poll-side remote → local challenge sync. Content hash includes attachment
// identity so a swapped file is a revision even when the text is unchanged.
import { createHash } from "node:crypto";
import type { RemoteAttachment, RemoteChallenge } from "@rio/domain";
import type { Repositories } from "@rio/database";
import type { EventBus } from "./bus.js";
import { isDeletedRemoteId } from "./deleted.js";

export interface AttachmentMeta {
  remoteId: string | null;
  name: string;
  url: string | null;
  sizeBytes: number | null;
}

export interface RemoteFingerprint {
  hash: string;
  attachmentMetas: AttachmentMeta[];
  attachmentMetasJson: string;
}

export interface RemoteSyncResult {
  challengeId: string;
  created: boolean;
  metadataChanged: boolean;
  attachmentChanged: boolean;
  previousDescription: string | null;
  description: string;
  attachmentSummary: string;
}

export function attachmentMetasOf(remote: RemoteChallenge): AttachmentMeta[] {
  return (remote.attachments ?? []).map((a) => ({
    remoteId: a.remoteId,
    name: a.name,
    url: a.url,
    sizeBytes: a.sizeBytes,
  }));
}

export function fingerprintRemote(remote: RemoteChallenge): RemoteFingerprint {
  const attachmentMetas = attachmentMetasOf(remote);
  // List payloads often omit files. Hash metadata only unless attachments
  // are actually present so a later detail fetch is not a false revision.
  const canonical = JSON.stringify({
    title: remote.title,
    description: remote.description,
    category: remote.category,
    score: remote.score,
    solveCount: remote.solveCount,
    ...(attachmentMetas.length > 0 ? { attachments: attachmentMetas } : {}),
  });
  return {
    hash: createHash("sha256").update(canonical).digest("hex"),
    attachmentMetas,
    attachmentMetasJson: JSON.stringify(attachmentMetas),
  };
}

export function attachmentIdentity(meta: { name: string; url?: string | null; remoteUrl?: string | null; sizeBytes: number | null; remoteId?: string | null }): string {
  return `${meta.remoteId ?? ""}|${meta.name}|${meta.url ?? meta.remoteUrl ?? ""}|${meta.sizeBytes ?? ""}`;
}

export function attachmentsDiffer(existing: Array<{ name: string; remoteUrl: string | null; sizeBytes: number | null; remoteId: string | null }>, next: AttachmentMeta[]): boolean {
  if (existing.length === 0 && next.length === 0) return false;
  const a = existing.map(attachmentIdentity).sort();
  const b = next.map(attachmentIdentity).sort();
  if (a.length !== b.length) return true;
  return a.some((v, i) => v !== b[i]);
}

export function upsertRemoteAttachments(
  repos: Repositories,
  challengeId: string,
  remotes: RemoteAttachment[] | AttachmentMeta[],
): { added: string[]; updated: string[] } {
  const existing = repos.attachments.listByChallenge(challengeId);
  const added: string[] = [];
  const updated: string[] = [];
  for (const ra of remotes) {
    const found = existing.find((a) => (ra.remoteId && a.remoteId === ra.remoteId) || a.name === ra.name);
    if (!found) {
      repos.attachments.create({
        challengeId,
        remoteId: ra.remoteId,
        name: ra.name,
        remoteUrl: ra.url,
        localPath: null,
        sizeBytes: ra.sizeBytes,
        sha256: null,
        mime: null,
        downloadStatus: "PENDING",
        downloadedAt: null,
      });
      added.push(ra.name);
      continue;
    }
    const changed =
      found.remoteUrl !== ra.url ||
      found.name !== ra.name ||
      (ra.sizeBytes !== null && found.sizeBytes !== ra.sizeBytes);
    if (changed) {
      repos.attachments.update(found.id, {
        name: ra.name,
        remoteId: ra.remoteId,
        remoteUrl: ra.url,
        sizeBytes: ra.sizeBytes ?? found.sizeBytes,
        sha256: null,
        downloadStatus: "PENDING",
      });
      updated.push(ra.name);
    }
  }
  return { added, updated };
}

export function syncRemoteChallenge(opts: {
  repos: Repositories;
  remote: RemoteChallenge;
  bus: EventBus;
  now?: number;
}): RemoteSyncResult | null {
  const { repos, remote, bus } = opts;
  if (isDeletedRemoteId(repos, remote.remoteId)) return null;
  const now = opts.now ?? Date.now();
  const fp = fingerprintRemote(remote);
  const existing = repos.challenges.getByRemoteId(remote.remoteId);
  if (!existing) {
    const id = `ch_${remote.remoteId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    repos.challenges.create({
      id,
      remoteId: remote.remoteId,
      title: remote.title,
      description: remote.description,
      category: normalizeCategory(remote.category),
      subcategory: null,
      score: remote.score,
      solveCount: remote.solveCount,
      lifecycleStatus: "DISCOVERED",
      startStatus: "NOT_STARTED",
      hintStatus: "LOCKED",
      progressStatus: "UNKNOWN",
      priority: 0,
      lastPriorityScore: null,
      difficultyEstimate: null,
      currentSolverType: null,
      currentSessionId: null,
      wrongSubmissionCount: 0,
      solverRestartCount: 0,
      pausedReason: null,
      parkedReason: null,
      blockedReason: null,
      contentHash: fp.hash,
      discoveredAt: now,
      updatedAt: now,
      startedAt: null,
      solverStartedAt: null,
      wallClockSolveMs: 0,
      activeSolveMs: 0,
      remoteCreatedAt: remote.createdAt,
      remoteUpdatedAt: remote.updatedAt,
    });
    upsertRemoteAttachments(repos, id, fp.attachmentMetas);
    repos.events.append("CHALLENGE_DISCOVERED", id, { remoteId: remote.remoteId, title: remote.title, category: remote.category });
    bus.publish({ type: "CHALLENGE_DISCOVERED", challengeId: id, payload: { remoteId: remote.remoteId, title: remote.title } });
    return {
      challengeId: id,
      created: true,
      metadataChanged: false,
      attachmentChanged: false,
      previousDescription: null,
      description: remote.description,
      attachmentSummary: fp.attachmentMetas.map((a) => a.name).join(", "),
    };
  }

  const incomingAtts = fp.attachmentMetas;
  const title = remote.title || existing.title;
  const description = remote.description || existing.description;
  const category = remote.category ? normalizeCategory(remote.category) : existing.category;
  const score = remote.score ?? existing.score;
  const solveCount = remote.solveCount ?? existing.solveCount;
  const stored = repos.attachments.listByChallenge(existing.id);
  const attachmentChanged = incomingAtts.length > 0 && attachmentsDiffer(stored, incomingAtts);
  const metadataChanged =
    Boolean(remote.title && remote.title !== existing.title) ||
    Boolean(remote.description && remote.description !== existing.description) ||
    (Boolean(remote.category) && category !== existing.category) ||
    (remote.score !== null && remote.score !== existing.score) ||
    (remote.solveCount !== null && remote.solveCount !== existing.solveCount);

  if (!metadataChanged && !attachmentChanged) {
    return {
      challengeId: existing.id,
      created: false,
      metadataChanged: false,
      attachmentChanged: false,
      previousDescription: existing.description,
      description: existing.description,
      attachmentSummary: incomingAtts.map((a) => a.name).join(", "),
    };
  }

  repos.challenges.update(existing.id, {
    title,
    description,
    category,
    score,
    solveCount,
    contentHash: fp.hash,
  });
  repos.challenges.recordRevision({
    id: `rev_${Math.random().toString(36).slice(2, 12)}`,
    challengeId: existing.id,
    contentHash: fp.hash,
    title,
    description,
    category,
    score,
    attachmentMetasJson: incomingAtts.length > 0 ? fp.attachmentMetasJson : JSON.stringify(stored.map((a) => ({ remoteId: a.remoteId, name: a.name, url: a.remoteUrl, sizeBytes: a.sizeBytes }))),
  });

  let added: string[] = [];
  let updated: string[] = [];
  if (attachmentChanged) {
    const r = upsertRemoteAttachments(repos, existing.id, fp.attachmentMetas);
    added = r.added;
    updated = r.updated;
    bus.publish({
      type: "CHALLENGE_ATTACHMENT_UPDATED",
      challengeId: existing.id,
      payload: { added, updated, names: fp.attachmentMetas.map((a) => a.name) },
    });
  }
  if (metadataChanged) {
    bus.publish({ type: "CHALLENGE_UPDATED", challengeId: existing.id, payload: { title } });
  }

  return {
    challengeId: existing.id,
    created: false,
    metadataChanged,
    attachmentChanged,
    previousDescription: existing.description,
    description,
    attachmentSummary: [...added, ...updated].join(", ") || fp.attachmentMetas.map((a) => a.name).join(", "),
  };
}

export function normalizeCategory(raw: string): "MISC" | "CRYPTO" | "WEB" | "PWN" | "REVERSE" | "OTHER" | "UNKNOWN" {
  const up = raw.toUpperCase().trim();
  if (up.includes("MISC") || raw.includes("杂项") || /forensic/i.test(raw) || /osint/i.test(raw)) return "MISC";
  if (up.includes("CRYPTO") || raw.includes("密码")) return "CRYPTO";
  if (up.includes("WEB")) return "WEB";
  if (up.includes("PWN")) return "PWN";
  if (up.includes("REV")) return "REVERSE";
  if (up === "OTHER") return "OTHER";
  return "UNKNOWN";
}
