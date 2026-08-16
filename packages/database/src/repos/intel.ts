import type { Hypothesis, ToolExperiment, SpecialistResult, RecordedToolExecution, BenchmarkRunResult, ExperimentOutcome, HypothesisStatus, SpecialistKind } from "@rio/domain";
import { RioDb } from "../db.js";

export class HypothesisRepository {
  constructor(private db: RioDb) {}

  create(h: Omit<Hypothesis, "id" | "createdAt" | "updatedAt"> & { id?: string }): Hypothesis {
    const now = Date.now();
    const rec: Hypothesis = {
      ...h,
      id: h.id ?? `hyp_${Math.random().toString(36).slice(2, 14)}`,
      createdAt: now,
      updatedAt: now,
    };
    this.db.run(
      `INSERT INTO hypotheses (id, challenge_id, description, confidence, status, evidence_for_json, evidence_against_json, proposed_tests_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id, rec.challengeId, rec.description, rec.confidence, rec.status,
      rec.evidenceForJson, rec.evidenceAgainstJson, rec.proposedTestsJson, rec.createdAt, rec.updatedAt,
    );
    return rec;
  }

  listByChallenge(challengeId: string): Hypothesis[] {
    return this.db.all<Hypothesis>(
      `SELECT id, challenge_id AS challengeId, description, confidence, status,
              evidence_for_json AS evidenceForJson, evidence_against_json AS evidenceAgainstJson,
              proposed_tests_json AS proposedTestsJson, created_at AS createdAt, updated_at AS updatedAt
         FROM hypotheses WHERE challenge_id = ? ORDER BY created_at ASC`,
      challengeId,
    );
  }

  setStatus(id: string, status: HypothesisStatus, confidence?: number): void {
    if (confidence === undefined) {
      this.db.run(`UPDATE hypotheses SET status = ?, updated_at = ? WHERE id = ?`, status, Date.now(), id);
    } else {
      this.db.run(`UPDATE hypotheses SET status = ?, confidence = ?, updated_at = ? WHERE id = ?`, status, confidence, Date.now(), id);
    }
  }
}

export class ExperimentRepository {
  constructor(private db: RioDb) {}

  create(e: Omit<ToolExperiment, "id" | "createdAt"> & { id?: string }): ToolExperiment {
    const rec: ToolExperiment = { ...e, id: e.id ?? `ex_${Math.random().toString(36).slice(2, 14)}`, createdAt: Date.now() };
    this.db.run(
      `INSERT OR IGNORE INTO tool_experiments (id, challenge_id, key, artifact_sha256, tool, canonical_args, result_summary, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id, rec.challengeId, rec.key, rec.artifactSha256, rec.tool, rec.canonicalArgs, rec.resultSummary, rec.outcome, rec.createdAt,
    );
    return rec;
  }

  getByKey(challengeId: string, key: string): ToolExperiment | null {
    return this.db.get<ToolExperiment>(
      `SELECT id, challenge_id AS challengeId, key, artifact_sha256 AS artifactSha256, tool,
              canonical_args AS canonicalArgs, result_summary AS resultSummary, outcome, created_at AS createdAt
         FROM tool_experiments WHERE challenge_id = ? AND key = ?`,
      challengeId, key,
    ) ?? null;
  }

  listByChallenge(challengeId: string): ToolExperiment[] {
    return this.db.all<ToolExperiment>(
      `SELECT id, challenge_id AS challengeId, key, artifact_sha256 AS artifactSha256, tool,
              canonical_args AS canonicalArgs, result_summary AS resultSummary, outcome, created_at AS createdAt
         FROM tool_experiments WHERE challenge_id = ? ORDER BY created_at ASC`,
      challengeId,
    );
  }

  noSignalStreak(challengeId: string): number {
    const rows = this.listByChallenge(challengeId);
    let n = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i]!.outcome === "NO_SIGNAL") n += 1;
      else break;
    }
    return n;
  }
}

export class SpecialistResultRepository {
  constructor(private db: RioDb) {}
  create(s: Omit<SpecialistResult, "id" | "createdAt"> & { id?: string }): SpecialistResult {
    const rec: SpecialistResult = { ...s, id: s.id ?? `sp_${Math.random().toString(36).slice(2, 14)}`, createdAt: Date.now() };
    this.db.run(
      `INSERT INTO specialist_results (id, challenge_id, kind, conclusion, confidence, facts_json, rejected_ideas_json, recommended_actions_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id, rec.challengeId, rec.kind, rec.conclusion, rec.confidence, rec.factsJson, rec.rejectedIdeasJson, rec.recommendedActionsJson, rec.createdAt,
    );
    return rec;
  }
  listByChallenge(challengeId: string): SpecialistResult[] {
    return this.db.all<SpecialistResult>(
      `SELECT id, challenge_id AS challengeId, kind, conclusion, confidence, facts_json AS factsJson,
              rejected_ideas_json AS rejectedIdeasJson, recommended_actions_json AS recommendedActionsJson, created_at AS createdAt
         FROM specialist_results WHERE challenge_id = ? ORDER BY created_at ASC`,
      challengeId,
    );
  }
}

export class RecordedToolRepository {
  constructor(private db: RioDb) {}
  create(r: Omit<RecordedToolExecution, "id" | "createdAt">): RecordedToolExecution {
    const rec: RecordedToolExecution = { ...r, id: `rec_${Math.random().toString(36).slice(2, 14)}`, createdAt: Date.now() };
    this.db.run(
      `INSERT INTO recorded_tool_executions (id, challenge_id, tool, canonical_args, result_json, artifact_hashes_json, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id, rec.challengeId, rec.tool, rec.canonicalArgs, rec.resultJson, rec.artifactHashesJson, rec.durationMs, rec.createdAt,
    );
    return rec;
  }
  find(challengeId: string, tool: string, canonicalArgs: string): RecordedToolExecution | null {
    return this.db.get<RecordedToolExecution>(
      `SELECT id, challenge_id AS challengeId, tool, canonical_args AS canonicalArgs, result_json AS resultJson,
              artifact_hashes_json AS artifactHashesJson, duration_ms AS durationMs, created_at AS createdAt
         FROM recorded_tool_executions WHERE challenge_id = ? AND tool = ? AND canonical_args = ? ORDER BY created_at DESC LIMIT 1`,
      challengeId, tool, canonicalArgs,
    ) ?? null;
  }
}

export class BenchmarkRunRepository {
  constructor(private db: RioDb) {}
  create(r: Omit<BenchmarkRunResult, "id" | "createdAt">): BenchmarkRunResult {
    const rec: BenchmarkRunResult = { ...r, id: `br_${Math.random().toString(36).slice(2, 14)}`, createdAt: Date.now() };
    this.db.run(
      `INSERT INTO benchmark_runs (id, manifest_id, solved, flag, techniques_json, tool_calls, duration_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rec.id, rec.manifestId, rec.solved ? 1 : 0, rec.flag, JSON.stringify(rec.techniques), rec.toolCalls, rec.durationMs, rec.error, rec.createdAt,
    );
    return rec;
  }
  list(): BenchmarkRunResult[] {
    return this.db.all<{ id: string; manifestId: string; solved: number; flag: string | null; techniquesJson: string; toolCalls: number; durationMs: number; error: string | null; createdAt: number }>(
      `SELECT id, manifest_id AS manifestId, solved, flag, techniques_json AS techniquesJson, tool_calls AS toolCalls,
              duration_ms AS durationMs, error, created_at AS createdAt FROM benchmark_runs ORDER BY created_at DESC`,
    ).map((r) => ({
      id: r.id,
      manifestId: r.manifestId,
      solved: Boolean(r.solved),
      flag: r.flag,
      techniques: JSON.parse(r.techniquesJson || "[]") as string[],
      toolCalls: r.toolCalls,
      durationMs: r.durationMs,
      error: r.error,
      createdAt: r.createdAt,
    }));
  }
}

export type { ExperimentOutcome, HypothesisStatus, SpecialistKind };
