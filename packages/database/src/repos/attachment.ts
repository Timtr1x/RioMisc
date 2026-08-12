import type { Attachment, Artifact, DownloadStatus } from "@rio/domain";
import { RioDb, buildSet } from "../db.js";

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

const ATT_COLUMNS =
  "id, challenge_id AS challengeId, remote_id AS remoteId, name, remote_url AS remoteUrl, local_path AS localPath, size_bytes AS sizeBytes, sha256, mime, download_status AS downloadStatus, created_at AS createdAt, downloaded_at AS downloadedAt";

const ATT_UPDATE: Record<string, string> = {
  remoteId: "remote_id",
  name: "name",
  remoteUrl: "remote_url",
  localPath: "local_path",
  sizeBytes: "size_bytes",
  sha256: "sha256",
  mime: "mime",
  downloadStatus: "download_status",
  downloadedAt: "downloaded_at",
};

function mapAttachment(r: Record<string, unknown>): Attachment {
  return {
    id: r.id as string,
    challengeId: r.challengeId as string,
    remoteId: (r.remoteId as string | null) ?? null,
    name: r.name as string,
    remoteUrl: (r.remoteUrl as string | null) ?? null,
    localPath: (r.localPath as string | null) ?? null,
    sizeBytes: (r.sizeBytes as number | null) ?? null,
    sha256: (r.sha256 as string | null) ?? null,
    mime: (r.mime as string | null) ?? null,
    downloadStatus: r.downloadStatus as DownloadStatus,
    createdAt: r.createdAt as number,
    downloadedAt: (r.downloadedAt as number | null) ?? null,
  };
}

export class AttachmentRepository {
  constructor(private db: RioDb) {}

  create(a: Omit<Attachment, "id" | "createdAt">): Attachment {
    const rec: Attachment = {
      ...a,
      id: `att_${Math.random().toString(36).slice(2, 14)}`,
      createdAt: Date.now(),
    };
    this.db.run(
      `INSERT INTO attachments (id, challenge_id, remote_id, name, remote_url, local_path, size_bytes, sha256, mime, download_status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id,
      rec.challengeId,
      rec.remoteId,
      rec.name,
      rec.remoteUrl,
      rec.localPath,
      rec.sizeBytes,
      rec.sha256,
      rec.mime,
      rec.downloadStatus,
      rec.createdAt,
    );
    return rec;
  }

  get(id: string): Attachment | null {
    const r = this.db.get<Record<string, unknown>>(`SELECT ${ATT_COLUMNS} FROM attachments WHERE id = ?`, id);
    return r ? mapAttachment(r) : null;
  }

  listByChallenge(challengeId: string): Attachment[] {
    return this.db
      .all<Record<string, unknown>>(`SELECT ${ATT_COLUMNS} FROM attachments WHERE challenge_id = ? ORDER BY created_at ASC`, challengeId)
      .map(mapAttachment);
  }

  update(id: string, patch: Partial<Attachment>): void {
    const { clause, values } = buildSet(patch as Record<string, unknown>, ATT_UPDATE);
    if (!clause) return;
    this.db.run(`UPDATE attachments SET ${clause} WHERE id = ?`, ...values, id);
  }

  setDownloadStatus(id: string, status: DownloadStatus): void {
    this.db.run(
      "UPDATE attachments SET download_status = ?, downloaded_at = CASE WHEN ? = 'DOWNLOADED' THEN ? ELSE downloaded_at END WHERE id = ?",
      status,
      status,
      Date.now(),
      id,
    );
  }
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export class ArtifactRepository {
  constructor(private db: RioDb) {}

  create(a: Omit<Artifact, "id" | "createdAt">): Artifact {
    const rec: Artifact = { ...a, id: `art_${Math.random().toString(36).slice(2, 14)}`, createdAt: Date.now() };
    this.db.run(
      `INSERT INTO artifacts (id, challenge_id, parent_artifact_id, path, mime, size, sha256, generated_by, operation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id,
      rec.challengeId,
      rec.parentArtifactId,
      rec.path,
      rec.mime,
      rec.size,
      rec.sha256,
      rec.generatedBy,
      rec.operation,
      rec.createdAt,
    );
    return rec;
  }

  listByChallenge(challengeId: string): Artifact[] {
    return this.db.all<Artifact>(
      "SELECT id, challenge_id AS challengeId, parent_artifact_id AS parentArtifactId, path, mime, size, sha256, generated_by AS generatedBy, operation, created_at AS createdAt FROM artifacts WHERE challenge_id = ? ORDER BY created_at ASC",
      challengeId,
    );
  }

  delete(id: string): void {
    this.db.run("DELETE FROM artifacts WHERE id = ?", id);
  }
}
