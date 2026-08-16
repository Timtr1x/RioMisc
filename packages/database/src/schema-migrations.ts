// Versioned ALTER TABLE migrations. CREATE TABLE IF NOT EXISTS does not add
// columns to existing user databases.
import type { RioDb } from "./db.js";

export function applySchemaMigrations(db: RioDb): void {
  db.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const applied = new Set(db.all<{ version: number }>("SELECT version FROM schema_migrations").map((r) => r.version));

  if (!applied.has(2)) {
    const cols = db.all<{ name: string }>("PRAGMA table_info(model_providers)");
    if (cols.length > 0 && !cols.some((c) => c.name === "compat_profile")) {
      db.sqlite.exec("ALTER TABLE model_providers ADD COLUMN compat_profile TEXT NOT NULL DEFAULT 'AUTO'");
    }
    db.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (2, ?)", Date.now());
  }

  if (!applied.has(3)) {
    const modelCols = db.all<{ name: string }>("PRAGMA table_info(models)");
    if (modelCols.length > 0 && !modelCols.some((c) => c.name === "capabilities_json")) {
      db.sqlite.exec(
        `ALTER TABLE models ADD COLUMN capabilities_json TEXT NOT NULL DEFAULT '{"text":true,"toolCalling":true,"vision":false,"reasoning":false,"structuredOutput":false}'`,
      );
    }
    db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS visual_evidence (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL,
        source_artifact_id TEXT,
        source_path TEXT NOT NULL,
        source_type TEXT NOT NULL,
        question TEXT,
        analyzer TEXT NOT NULL,
        summary TEXT NOT NULL,
        observations_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS visual_evidence_challenge_idx ON visual_evidence(challenge_id);
      CREATE TABLE IF NOT EXISTS visual_review_requests (
        id TEXT PRIMARY KEY,
        challenge_id TEXT NOT NULL,
        evidence_id TEXT,
        source_path TEXT NOT NULL,
        question TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING',
        answer_json TEXT,
        created_at INTEGER NOT NULL,
        answered_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS visual_review_challenge_idx ON visual_review_requests(challenge_id);
    `);
    db.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (3, ?)", Date.now());
  }

  if (!applied.has(4)) {
    const cols = db.all<{ name: string }>("PRAGMA table_info(visual_review_requests)");
    if (cols.length > 0 && !cols.some((c) => c.name === "reason")) {
      db.sqlite.exec("ALTER TABLE visual_review_requests ADD COLUMN reason TEXT");
    }
    db.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (4, ?)", Date.now());
  }

  if (!applied.has(5)) {
    db.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS hypotheses (
        id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL, description TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'CANDIDATE',
        evidence_for_json TEXT NOT NULL DEFAULT '[]', evidence_against_json TEXT NOT NULL DEFAULT '[]',
        proposed_tests_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hypotheses_challenge_idx ON hypotheses(challenge_id);
      CREATE TABLE IF NOT EXISTS tool_experiments (
        id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL, key TEXT NOT NULL,
        artifact_sha256 TEXT NOT NULL, tool TEXT NOT NULL, canonical_args TEXT NOT NULL,
        result_summary TEXT NOT NULL, outcome TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS tool_experiments_key_idx ON tool_experiments(challenge_id, key);
      CREATE INDEX IF NOT EXISTS tool_experiments_challenge_idx ON tool_experiments(challenge_id);
      CREATE TABLE IF NOT EXISTS specialist_results (
        id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL, kind TEXT NOT NULL,
        conclusion TEXT NOT NULL, confidence REAL NOT NULL,
        facts_json TEXT NOT NULL DEFAULT '[]', rejected_ideas_json TEXT NOT NULL DEFAULT '[]',
        recommended_actions_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS specialist_challenge_idx ON specialist_results(challenge_id);
      CREATE TABLE IF NOT EXISTS recorded_tool_executions (
        id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL, tool TEXT NOT NULL,
        canonical_args TEXT NOT NULL, result_json TEXT NOT NULL,
        artifact_hashes_json TEXT NOT NULL DEFAULT '[]', duration_ms INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS solver_checkpoints (
        id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS benchmark_runs (
        id TEXT PRIMARY KEY, manifest_id TEXT NOT NULL, solved INTEGER NOT NULL, flag TEXT,
        techniques_json TEXT NOT NULL DEFAULT '[]', tool_calls INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL, error TEXT, created_at INTEGER NOT NULL
      );
    `);
    db.run("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (5, ?)", Date.now());
  }
}
