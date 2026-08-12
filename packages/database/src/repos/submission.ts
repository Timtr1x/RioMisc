import type { FlagCandidate, Submission, SubmissionStatus } from "@rio/domain";
import { RioDb, buildSet } from "../db.js";

// ---------------------------------------------------------------------------
// Flag candidates
// ---------------------------------------------------------------------------

const CAND_COLUMNS =
  "id, challenge_id AS challengeId, session_id AS sessionId, value, confidence, reason, evidence_json AS evidenceJson, status, created_at AS createdAt, submitted_at AS submittedAt";

const CAND_UPDATE: Record<string, string> = {
  sessionId: "session_id",
  status: "status",
  submittedAt: "submitted_at",
};

export class FlagCandidateRepository {
  constructor(private db: RioDb) {}

  create(c: Omit<FlagCandidate, "id" | "createdAt" | "submittedAt">): FlagCandidate {
    const cand: FlagCandidate = {
      ...c,
      id: `cand_${Math.random().toString(36).slice(2, 14)}`,
      createdAt: Date.now(),
      submittedAt: null,
    };
    this.db.run(
      `INSERT INTO flag_candidates (id, challenge_id, session_id, value, confidence, reason, evidence_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      cand.id,
      cand.challengeId,
      cand.sessionId,
      cand.value,
      cand.confidence,
      cand.reason,
      cand.evidenceJson,
      cand.status,
      cand.createdAt,
    );
    return cand;
  }

  get(id: string): FlagCandidate | null {
    return this.db.get<FlagCandidate>(`SELECT ${CAND_COLUMNS} FROM flag_candidates WHERE id = ?`, id) ?? null;
  }

  listByChallenge(challengeId: string): FlagCandidate[] {
    return this.db.all<FlagCandidate>(
      `SELECT ${CAND_COLUMNS} FROM flag_candidates WHERE challenge_id = ? ORDER BY created_at ASC`,
      challengeId,
    );
  }

  existsByValue(challengeId: string, value: string): boolean {
    return (
      this.db.get<{ id: string }>(
        "SELECT id FROM flag_candidates WHERE challenge_id = ? AND value = ?",
        challengeId,
        value,
      ) !== undefined
    );
  }

  update(id: string, patch: Partial<FlagCandidate>): void {
    const { clause, values } = buildSet(patch as Record<string, unknown>, CAND_UPDATE);
    if (!clause) return;
    this.db.run(`UPDATE flag_candidates SET ${clause} WHERE id = ?`, ...values, id);
  }
}

// ---------------------------------------------------------------------------
// Submissions
// ---------------------------------------------------------------------------

const SUB_COLUMNS =
  "id, challenge_id AS challengeId, candidate_id AS candidateId, flag_hash AS flagHash, flag_value AS flagValue, status, remote_response_json AS remoteResponseJson, error, submitted_at AS submittedAt, created_at AS createdAt";

const SUB_UPDATE: Record<string, string> = {
  candidateId: "candidate_id",
  status: "status",
  remoteResponseJson: "remote_response_json",
  error: "error",
  submittedAt: "submitted_at",
};

function mapSubmission(r: Record<string, unknown>): Submission {
  return {
    id: r.id as string,
    challengeId: r.challengeId as string,
    candidateId: (r.candidateId as string | null) ?? null,
    flagHash: r.flagHash as string,
    flagValue: r.flagValue as string,
    status: r.status as SubmissionStatus,
    remoteResponseJson: (r.remoteResponseJson as string | null) ?? null,
    error: (r.error as string | null) ?? null,
    submittedAt: (r.submittedAt as number | null) ?? null,
    createdAt: r.createdAt as number,
  };
}

export class SubmissionRepository {
  constructor(private db: RioDb) {}

  /** Insert a submission; unique(challengeId, flagHash) makes duplicates a no-op. */
  createOrGet(s: {
    challengeId: string;
    candidateId: string | null;
    flagHash: string;
    flagValue: string;
    status: SubmissionStatus;
  }): Submission {
    const existing = this.db.get<Record<string, unknown>>(
      `SELECT ${SUB_COLUMNS} FROM submissions WHERE challenge_id = ? AND flag_hash = ?`,
      s.challengeId,
      s.flagHash,
    );
    if (existing) return mapSubmission(existing);
    const rec = {
      id: `sub_${Math.random().toString(36).slice(2, 14)}`,
      ...s,
      remoteResponseJson: null,
      error: null,
      submittedAt: null,
      createdAt: Date.now(),
    };
    this.db.run(
      `INSERT INTO submissions (id, challenge_id, candidate_id, flag_hash, flag_value, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      rec.id,
      rec.challengeId,
      rec.candidateId,
      rec.flagHash,
      rec.flagValue,
      rec.status,
      rec.createdAt,
    );
    return mapSubmission(rec as unknown as Record<string, unknown>);
  }

  get(id: string): Submission | null {
    const r = this.db.get<Record<string, unknown>>(`SELECT ${SUB_COLUMNS} FROM submissions WHERE id = ?`, id);
    return r ? mapSubmission(r) : null;
  }

  listByChallenge(challengeId: string): Submission[] {
    return this.db
      .all<Record<string, unknown>>(`SELECT ${SUB_COLUMNS} FROM submissions WHERE challenge_id = ? ORDER BY created_at ASC`, challengeId)
      .map(mapSubmission);
  }

  lastByChallenge(challengeId: string): Submission | null {
    const r = this.db.get<Record<string, unknown>>(
      `SELECT ${SUB_COLUMNS} FROM submissions WHERE challenge_id = ? ORDER BY created_at DESC LIMIT 1`,
      challengeId,
    );
    return r ? mapSubmission(r) : null;
  }

  countWrong(challengeId: string): number {
    return (
      this.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM submissions WHERE challenge_id = ? AND status = 'WRONG'",
        challengeId,
      )?.n ?? 0
    );
  }

  hasSubmittedFlag(challengeId: string, flagHash: string): boolean {
    return (
      this.db.get<{ id: string }>(
        "SELECT id FROM submissions WHERE challenge_id = ? AND flag_hash = ?",
        challengeId,
        flagHash,
      ) !== undefined
    );
  }

  /** Submission that was sent but whose outcome is unknown (crash recovery). */
  findUnknownOutcome(challengeId: string): Submission | null {
    const r = this.db.get<Record<string, unknown>>(
      `SELECT ${SUB_COLUMNS} FROM submissions
       WHERE challenge_id = ? AND status IN ('SENT', 'UNKNOWN') AND submitted_at IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      challengeId,
    );
    return r ? mapSubmission(r) : null;
  }

  update(id: string, patch: Partial<Submission>): void {
    const { clause, values } = buildSet(patch as Record<string, unknown>, SUB_UPDATE);
    if (!clause) return;
    this.db.run(`UPDATE submissions SET ${clause} WHERE id = ?`, ...values, id);
  }
}
