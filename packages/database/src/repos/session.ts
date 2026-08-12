import type { SolverSession, ProgressReport, SessionStatus } from "@rio/domain";
import { RioDb, buildSet } from "../db.js";

// ---------------------------------------------------------------------------
// Solver sessions
// ---------------------------------------------------------------------------

const SESS_COLUMNS =
  "id, challenge_id AS challengeId, solver_type AS solverType, pi_session_id AS piSessionId, pi_session_file AS piSessionFile, provider_id AS providerId, model_id AS modelId, status, started_at AS startedAt, last_active_at AS lastActiveAt, ended_at AS endedAt, input_tokens AS inputTokens, output_tokens AS outputTokens, tool_calls AS toolCalls";

const SESS_UPDATE: Record<string, string> = {
  solverType: "solver_type",
  piSessionId: "pi_session_id",
  piSessionFile: "pi_session_file",
  providerId: "provider_id",
  modelId: "model_id",
  status: "status",
  startedAt: "started_at",
  lastActiveAt: "last_active_at",
  endedAt: "ended_at",
  inputTokens: "input_tokens",
  outputTokens: "output_tokens",
  toolCalls: "tool_calls",
};

export class SolverSessionRepository {
  constructor(private db: RioDb) {}

  create(s: Omit<SolverSession, "id">): SolverSession {
    const sess: SolverSession = { ...s, id: `sess_${Math.random().toString(36).slice(2, 14)}` };
    this.db.run(
      `INSERT INTO solver_sessions (id, challenge_id, solver_type, pi_session_id, pi_session_file, provider_id, model_id, status, started_at, last_active_at, input_tokens, output_tokens, tool_calls)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)`,
      sess.id,
      sess.challengeId,
      sess.solverType,
      sess.piSessionId,
      sess.piSessionFile,
      sess.providerId,
      sess.modelId,
      sess.status,
      sess.startedAt,
      sess.lastActiveAt,
    );
    return sess;
  }

  get(id: string): SolverSession | null {
    return this.db.get<SolverSession>(`SELECT ${SESS_COLUMNS} FROM solver_sessions WHERE id = ?`, id) ?? null;
  }

  latestForChallenge(challengeId: string): SolverSession | null {
    return (
      this.db.get<SolverSession>(
        `SELECT ${SESS_COLUMNS} FROM solver_sessions WHERE challenge_id = ? ORDER BY started_at DESC LIMIT 1`,
        challengeId,
      ) ?? null
    );
  }

  activeForChallenge(challengeId: string): SolverSession | null {
    return (
      this.db.get<SolverSession>(
        `SELECT ${SESS_COLUMNS} FROM solver_sessions WHERE challenge_id = ? AND status = 'ACTIVE' LIMIT 1`,
        challengeId,
      ) ?? null
    );
  }

  listActive(): SolverSession[] {
    return this.db.all<SolverSession>(`SELECT ${SESS_COLUMNS} FROM solver_sessions WHERE status = 'ACTIVE'`);
  }

  update(id: string, patch: Partial<SolverSession>): void {
    const { clause, values } = buildSet(patch as Record<string, unknown>, SESS_UPDATE);
    if (!clause) return;
    this.db.run(`UPDATE solver_sessions SET ${clause} WHERE id = ?`, ...values, id);
  }

  heartbeat(id: string): void {
    this.db.run("UPDATE solver_sessions SET last_active_at = ? WHERE id = ?", Date.now(), id);
  }

  recordUsage(id: string, inputTokens: number, outputTokens: number, toolCalls: number): void {
    this.db.run(
      "UPDATE solver_sessions SET input_tokens = ?, output_tokens = ?, tool_calls = ?, last_active_at = ? WHERE id = ?",
      inputTokens,
      outputTokens,
      toolCalls,
      Date.now(),
      id,
    );
  }

  setStatus(id: string, status: SessionStatus): void {
    this.db.run(
      "UPDATE solver_sessions SET status = ?, ended_at = CASE WHEN ? IN ('ENDED','ERROR') THEN ? ELSE ended_at END WHERE id = ?",
      status,
      status,
      Date.now(),
      id,
    );
  }
}

// ---------------------------------------------------------------------------
// Solver progress (append-only; every report adds a row)
// ---------------------------------------------------------------------------

export class ProgressRepository {
  constructor(private db: RioDb) {}

  append(p: {
    challengeId: string;
    sessionId: string | null;
    summary: string;
    hypotheses: string[];
    confirmedFacts: string[];
    rejectedHypotheses: string[];
    nextActions: string[];
    confidence: number;
    progressLevel: "SIGNIFICANT" | "MINOR" | "NONE";
    stalled: boolean;
  }): ProgressReport {
    const rec: ProgressReport = {
      id: `prg_${Math.random().toString(36).slice(2, 14)}`,
      challengeId: p.challengeId,
      sessionId: p.sessionId,
      summary: p.summary,
      hypothesesJson: JSON.stringify(p.hypotheses),
      confirmedFactsJson: JSON.stringify(p.confirmedFacts),
      rejectedHypothesesJson: JSON.stringify(p.rejectedHypotheses),
      nextActionsJson: JSON.stringify(p.nextActions),
      confidence: p.confidence,
      progressLevel: p.progressLevel,
      stalled: p.stalled,
      createdAt: Date.now(),
    };
    this.db.run(
      `INSERT INTO solver_progress (id, challenge_id, session_id, summary, hypotheses_json, confirmed_facts_json, rejected_hypotheses_json, next_actions_json, confidence, progress_level, stalled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id,
      rec.challengeId,
      rec.sessionId,
      rec.summary,
      rec.hypothesesJson,
      rec.confirmedFactsJson,
      rec.rejectedHypothesesJson,
      rec.nextActionsJson,
      rec.confidence,
      rec.progressLevel,
      rec.stalled ? 1 : 0,
      rec.createdAt,
    );
    return rec;
  }

  latestForChallenge(challengeId: string): ProgressReport | null {
    return (
      this.db.get<ProgressReport>(
        `SELECT * FROM solver_progress WHERE challenge_id = ? ORDER BY created_at DESC LIMIT 1`,
        challengeId,
      ) ?? null
    );
  }

  listForChallenge(challengeId: string, limit = 100): ProgressReport[] {
    return this.db.all<ProgressReport>(
      `SELECT * FROM solver_progress WHERE challenge_id = ? ORDER BY created_at ASC LIMIT ?`,
      challengeId,
      limit,
    );
  }
}

// ---------------------------------------------------------------------------
// Hints
// ---------------------------------------------------------------------------

export class HintRepository {
  constructor(private db: RioDb) {}

  save(challengeId: string, content: string): void {
    this.db.run(
      "INSERT INTO hints (id, challenge_id, content, fetched_at) VALUES (?, ?, ?, ?)",
      `hint_${Math.random().toString(36).slice(2, 14)}`,
      challengeId,
      content,
      Date.now(),
    );
  }

  listForChallenge(challengeId: string): { content: string; fetchedAt: number }[] {
    return this.db.all<{ content: string; fetchedAt: number }>(
      "SELECT content, fetched_at AS fetchedAt FROM hints WHERE challenge_id = ?",
      challengeId,
    );
  }
}
