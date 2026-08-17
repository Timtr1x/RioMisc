import type { Challenge } from "@rio/domain";
import { RioDb, buildSet } from "../db.js";

const COLUMNS = [
  "id",
  "remote_id AS remoteId",
  "title",
  "description",
  "category",
  "subcategory",
  "score",
  "solve_count AS solveCount",
  "lifecycle_status AS lifecycleStatus",
  "start_status AS startStatus",
  "hint_status AS hintStatus",
  "progress_status AS progressStatus",
  "priority",
  "last_priority_score AS lastPriorityScore",
  "difficulty_estimate AS difficultyEstimate",
  "current_solver_type AS currentSolverType",
  "current_session_id AS currentSessionId",
  "wrong_submission_count AS wrongSubmissionCount",
  "solver_restart_count AS solverRestartCount",
  "paused_reason AS pausedReason",
  "parked_reason AS parkedReason",
  "blocked_reason AS blockedReason",
  "content_hash AS contentHash",
  "discovered_at AS discoveredAt",
  "updated_at AS updatedAt",
  "started_at AS startedAt",
  "solver_started_at AS solverStartedAt",
  "wall_clock_solve_ms AS wallClockSolveMs",
  "active_solve_ms AS activeSolveMs",
  "remote_created_at AS remoteCreatedAt",
  "remote_updated_at AS remoteUpdatedAt",
].join(", ");

const UPDATE_COLUMNS: Record<string, string> = {
  id: "id",
  remoteId: "remote_id",
  title: "title",
  description: "description",
  category: "category",
  subcategory: "subcategory",
  score: "score",
  solveCount: "solve_count",
  lifecycleStatus: "lifecycle_status",
  startStatus: "start_status",
  hintStatus: "hint_status",
  progressStatus: "progress_status",
  priority: "priority",
  lastPriorityScore: "last_priority_score",
  difficultyEstimate: "difficulty_estimate",
  currentSolverType: "current_solver_type",
  currentSessionId: "current_session_id",
  wrongSubmissionCount: "wrong_submission_count",
  solverRestartCount: "solver_restart_count",
  pausedReason: "paused_reason",
  parkedReason: "parked_reason",
  blockedReason: "blocked_reason",
  contentHash: "content_hash",
  discoveredAt: "discovered_at",
  updatedAt: "updated_at",
  startedAt: "started_at",
  solverStartedAt: "solver_started_at",
  wallClockSolveMs: "wall_clock_solve_ms",
  activeSolveMs: "active_solve_ms",
  remoteCreatedAt: "remote_created_at",
  remoteUpdatedAt: "remote_updated_at",
};

export class ChallengeRepository {
  constructor(private db: RioDb) {}

  get(id: string): Challenge | null {
    return this.db.get<Challenge>(`SELECT ${COLUMNS} FROM challenges WHERE id = ?`, id) ?? null;
  }

  getByRemoteId(remoteId: string): Challenge | null {
    return this.db.get<Challenge>(`SELECT ${COLUMNS} FROM challenges WHERE remote_id = ?`, remoteId) ?? null;
  }

  list(): Challenge[] {
    return this.db.all<Challenge>(`SELECT ${COLUMNS} FROM challenges ORDER BY discovered_at ASC`);
  }

  listByStatus(status: string): Challenge[] {
    return this.db.all<Challenge>(`SELECT ${COLUMNS} FROM challenges WHERE lifecycle_status = ?`, status);
  }

  listSchedulable(statuses: string[]): Challenge[] {
    const placeholders = statuses.map(() => "?").join(",");
    return this.db.all<Challenge>(
      `SELECT ${COLUMNS} FROM challenges WHERE lifecycle_status IN (${placeholders})
       ORDER BY COALESCE(last_priority_score, -999999) DESC, discovered_at ASC`,
      ...statuses,
    );
  }

  create(c: Challenge): void {
    const entries = Object.entries(UPDATE_COLUMNS);
    const cols = entries.map(([, col]) => col).join(",");
    this.db.run(
      `INSERT INTO challenges (${cols}) VALUES (${entries.map(() => "?").join(",")})`,
      ...entries.map(([key]) => (c as unknown as Record<string, unknown>)[key] ?? null),
    );
  }

  update(id: string, patch: Partial<Challenge>): void {
    const { clause, values } = buildSet(patch as Record<string, unknown>, UPDATE_COLUMNS);
    if (!clause) return;
    this.db.run(`UPDATE challenges SET ${clause}, updated_at = ? WHERE id = ?`, ...values, Date.now(), id);
  }

  touch(id: string): void {
    this.db.run("UPDATE challenges SET updated_at = ? WHERE id = ?", Date.now(), id);
  }

  /** Remove the challenge and all per-challenge rows. Caller should stop workers first. */
  deleteCascade(id: string): void {
    this.db.tx(() => {
      this.db.run("DELETE FROM challenge_revisions WHERE challenge_id = ?", id);
      this.db.run("DELETE FROM attachments WHERE challenge_id = ?", id);
      this.db.run("DELETE FROM artifacts WHERE challenge_id = ?", id);
      this.db.run("DELETE FROM hints WHERE challenge_id = ?", id);
      this.db.run("DELETE FROM solver_progress WHERE challenge_id = ?", id);
      this.db.run("DELETE FROM solver_sessions WHERE challenge_id = ?", id);
      this.db.run("DELETE FROM flag_candidates WHERE challenge_id = ?", id);
      this.db.run("DELETE FROM submissions WHERE challenge_id = ?", id);
      this.db.run("DELETE FROM worker_leases WHERE challenge_id = ?", id);
      this.db.run("DELETE FROM domain_events WHERE challenge_id = ?", id);
      this.db.run("DELETE FROM challenge_orchestration WHERE challenge_id = ?", id);
      this.db.run("DELETE FROM reflection_runs WHERE challenge_id = ?", id);
      this.db.run("DELETE FROM manager_decisions WHERE challenge_id = ?", id);
      this.db.run("DELETE FROM challenges WHERE id = ?", id);
    });
  }

  recordRevision(rev: {
    id: string;
    challengeId: string;
    contentHash: string;
    title: string;
    description: string;
    category: string;
    score: number | null;
    attachmentMetasJson: string;
  }): void {
    this.db.run(
      `INSERT INTO challenge_revisions (id, challenge_id, content_hash, title, description, category, score, attachment_metas_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rev.id,
      rev.challengeId,
      rev.contentHash,
      rev.title,
      rev.description,
      rev.category,
      rev.score,
      rev.attachmentMetasJson,
      Date.now(),
    );
  }
}
