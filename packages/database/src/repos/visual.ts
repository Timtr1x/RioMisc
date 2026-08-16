import type { VisualEvidence, VisualReviewStatus } from "@rio/domain";
import { RioDb } from "../db.js";

const COLUMNS = `id, challenge_id AS challengeId, source_artifact_id AS sourceArtifactId, source_path AS sourcePath,
  source_type AS sourceType, question, analyzer, summary, observations_json AS observationsJson,
  confidence, created_at AS createdAt`;

function mapEvidence(r: Record<string, unknown>): VisualEvidence {
  let observations: VisualEvidence["observations"] = [];
  try {
    observations = JSON.parse(String(r.observationsJson ?? "[]")) as VisualEvidence["observations"];
  } catch {
    observations = [];
  }
  return {
    id: r.id as string,
    challengeId: r.challengeId as string,
    sourceArtifactId: (r.sourceArtifactId as string | null) ?? null,
    sourcePath: r.sourcePath as string,
    sourceType: r.sourceType as VisualEvidence["sourceType"],
    question: (r.question as string | null) ?? null,
    analyzer: r.analyzer as VisualEvidence["analyzer"],
    observations: Array.isArray(observations) ? observations : [],
    summary: r.summary as string,
    confidence: Number(r.confidence ?? 0),
    createdAt: r.createdAt as number,
  };
}

export class VisualEvidenceRepository {
  constructor(private db: RioDb) {}

  create(e: Omit<VisualEvidence, "id" | "createdAt"> & { id?: string; createdAt?: number }): VisualEvidence {
    const rec: VisualEvidence = {
      ...e,
      id: e.id ?? `ve_${Math.random().toString(36).slice(2, 14)}`,
      createdAt: e.createdAt ?? Date.now(),
    };
    this.db.run(
      `INSERT INTO visual_evidence
        (id, challenge_id, source_artifact_id, source_path, source_type, question, analyzer, summary, observations_json, confidence, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id,
      rec.challengeId,
      rec.sourceArtifactId,
      rec.sourcePath,
      rec.sourceType,
      rec.question,
      rec.analyzer,
      rec.summary,
      JSON.stringify(rec.observations),
      rec.confidence,
      rec.createdAt,
    );
    return rec;
  }

  get(id: string): VisualEvidence | null {
    const r = this.db.get<Record<string, unknown>>(`SELECT ${COLUMNS} FROM visual_evidence WHERE id = ?`, id);
    return r ? mapEvidence(r) : null;
  }

  listByChallenge(challengeId: string): VisualEvidence[] {
    return this.db
      .all<Record<string, unknown>>(
        `SELECT ${COLUMNS} FROM visual_evidence WHERE challenge_id = ? ORDER BY created_at ASC`,
        challengeId,
      )
      .map(mapEvidence);
  }
}

export interface VisualReviewRequest {
  id: string;
  challengeId: string;
  evidenceId: string | null;
  sourcePath: string;
  question: string | null;
  reason: string | null;
  status: VisualReviewStatus;
  answerJson: string | null;
  createdAt: number;
  answeredAt: number | null;
}

const REVIEW_COLUMNS = `id, challenge_id AS challengeId, evidence_id AS evidenceId, source_path AS sourcePath,
  question, reason, status, answer_json AS answerJson, created_at AS createdAt, answered_at AS answeredAt`;

function mapReview(r: Record<string, unknown>): VisualReviewRequest {
  return {
    id: r.id as string,
    challengeId: r.challengeId as string,
    evidenceId: (r.evidenceId as string | null) ?? null,
    sourcePath: r.sourcePath as string,
    question: (r.question as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    status: r.status as VisualReviewStatus,
    answerJson: (r.answerJson as string | null) ?? null,
    createdAt: r.createdAt as number,
    answeredAt: (r.answeredAt as number | null) ?? null,
  };
}

export class VisualReviewRepository {
  constructor(private db: RioDb) {}

  create(input: {
    id?: string;
    challengeId: string;
    evidenceId?: string | null;
    sourcePath: string;
    question?: string | null;
    reason?: string | null;
  }): VisualReviewRequest {
    const rec: VisualReviewRequest = {
      id: input.id ?? `vr_${Math.random().toString(36).slice(2, 14)}`,
      challengeId: input.challengeId,
      evidenceId: input.evidenceId ?? null,
      sourcePath: input.sourcePath,
      question: input.question ?? null,
      reason: input.reason ?? null,
      status: "PENDING",
      answerJson: null,
      createdAt: Date.now(),
      answeredAt: null,
    };
    this.db.run(
      `INSERT INTO visual_review_requests
        (id, challenge_id, evidence_id, source_path, question, reason, status, answer_json, created_at, answered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id,
      rec.challengeId,
      rec.evidenceId,
      rec.sourcePath,
      rec.question,
      rec.reason,
      rec.status,
      rec.answerJson,
      rec.createdAt,
      rec.answeredAt,
    );
    return rec;
  }

  get(id: string): VisualReviewRequest | null {
    const r = this.db.get<Record<string, unknown>>(`SELECT ${REVIEW_COLUMNS} FROM visual_review_requests WHERE id = ?`, id);
    return r ? mapReview(r) : null;
  }

  listPending(): VisualReviewRequest[] {
    return this.db
      .all<Record<string, unknown>>(`SELECT ${REVIEW_COLUMNS} FROM visual_review_requests WHERE status = 'PENDING' ORDER BY created_at ASC`)
      .map(mapReview);
  }

  list(): VisualReviewRequest[] {
    return this.db.all<Record<string, unknown>>(`SELECT ${REVIEW_COLUMNS} FROM visual_review_requests ORDER BY created_at DESC`).map(mapReview);
  }

  answer(id: string, answerJson: string): void {
    this.db.run(
      `UPDATE visual_review_requests SET status = 'ANSWERED', answer_json = ?, answered_at = ? WHERE id = ?`,
      answerJson,
      Date.now(),
      id,
    );
  }

  cancel(id: string): void {
    this.db.run(`UPDATE visual_review_requests SET status = 'CANCELLED' WHERE id = ?`, id);
  }
}
