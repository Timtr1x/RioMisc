// Idempotent DDL for all SQLite tables (mirrors the schema definitions used by repositories).
export const MIGRATION_DDL = `
CREATE TABLE IF NOT EXISTS contests (
  id TEXT PRIMARY KEY, name TEXT, adapter TEXT,
  started_at INTEGER, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  remote_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'UNKNOWN',
  subcategory TEXT,
  score INTEGER,
  solve_count INTEGER,
  lifecycle_status TEXT NOT NULL DEFAULT 'DISCOVERED',
  start_status TEXT NOT NULL DEFAULT 'NOT_STARTED',
  hint_status TEXT NOT NULL DEFAULT 'LOCKED',
  progress_status TEXT NOT NULL DEFAULT 'UNKNOWN',
  priority INTEGER NOT NULL DEFAULT 0,
  last_priority_score INTEGER,
  difficulty_estimate INTEGER,
  current_solver_type TEXT,
  current_session_id TEXT,
  wrong_submission_count INTEGER NOT NULL DEFAULT 0,
  solver_restart_count INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  parked_reason TEXT,
  blocked_reason TEXT,
  content_hash TEXT,
  discovered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  solver_started_at INTEGER,
  wall_clock_solve_ms INTEGER NOT NULL DEFAULT 0,
  active_solve_ms INTEGER NOT NULL DEFAULT 0,
  remote_created_at INTEGER,
  remote_updated_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS challenges_remote_id_idx ON challenges(remote_id);
CREATE INDEX IF NOT EXISTS challenges_lifecycle_idx ON challenges(lifecycle_status);
CREATE INDEX IF NOT EXISTS challenges_category_idx ON challenges(category);
CREATE INDEX IF NOT EXISTS challenges_priority_idx ON challenges(priority);

CREATE TABLE IF NOT EXISTS challenge_revisions (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  title TEXT, description TEXT, category TEXT, score INTEGER,
  attachment_metas_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  remote_id TEXT,
  name TEXT NOT NULL,
  remote_url TEXT,
  local_path TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  mime TEXT,
  download_status TEXT NOT NULL DEFAULT 'PENDING',
  created_at INTEGER NOT NULL,
  downloaded_at INTEGER
);
CREATE INDEX IF NOT EXISTS attachments_challenge_idx ON attachments(challenge_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  parent_artifact_id TEXT,
  path TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  generated_by TEXT NOT NULL,
  operation TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_challenge_idx ON artifacts(challenge_id);

CREATE TABLE IF NOT EXISTS hints (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  content TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS solver_sessions (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  solver_type TEXT NOT NULL,
  pi_session_id TEXT,
  pi_session_file TEXT,
  provider_id TEXT,
  model_id TEXT,
  status TEXT NOT NULL DEFAULT 'CREATED',
  started_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  ended_at INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_challenge_idx ON solver_sessions(challenge_id);

CREATE TABLE IF NOT EXISTS solver_progress (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  session_id TEXT,
  summary TEXT NOT NULL,
  hypotheses_json TEXT NOT NULL DEFAULT '[]',
  confirmed_facts_json TEXT NOT NULL DEFAULT '[]',
  rejected_hypotheses_json TEXT NOT NULL DEFAULT '[]',
  next_actions_json TEXT NOT NULL DEFAULT '[]',
  confidence REAL NOT NULL DEFAULT 0,
  progress_level TEXT NOT NULL DEFAULT 'NONE',
  stalled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS progress_challenge_idx ON solver_progress(challenge_id);

CREATE TABLE IF NOT EXISTS flag_candidates (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  session_id TEXT,
  value TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'PENDING',
  created_at INTEGER NOT NULL,
  submitted_at INTEGER
);
CREATE INDEX IF NOT EXISTS candidates_challenge_idx ON flag_candidates(challenge_id);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  candidate_id TEXT,
  flag_hash TEXT NOT NULL,
  flag_value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  remote_response_json TEXT,
  error TEXT,
  submitted_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS submissions_challenge_flag_idx ON submissions(challenge_id, flag_hash);
CREATE INDEX IF NOT EXISTS submissions_status_idx ON submissions(status);

CREATE TABLE IF NOT EXISTS worker_leases (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS worker_leases_challenge_idx ON worker_leases(challenge_id);

CREATE TABLE IF NOT EXISTS domain_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  challenge_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  processed_at INTEGER
);
CREATE INDEX IF NOT EXISTS events_unprocessed_idx ON domain_events(processed_at);
CREATE INDEX IF NOT EXISTS events_challenge_idx ON domain_events(challenge_id);

CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key_ref TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  health TEXT NOT NULL DEFAULT 'UNKNOWN',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_tested_at INTEGER,
  created_at INTEGER NOT NULL,
  compat_profile TEXT NOT NULL DEFAULT 'AUTO'
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_name TEXT NOT NULL,
  context_window INTEGER NOT NULL,
  max_output_tokens INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  role TEXT NOT NULL DEFAULT 'GENERAL',
  created_at INTEGER NOT NULL,
  capabilities_json TEXT NOT NULL DEFAULT '{"text":true,"toolCalling":true,"vision":false,"reasoning":false,"structuredOutput":false}'
);

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
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  answer_json TEXT,
  created_at INTEGER NOT NULL,
  answered_at INTEGER
);
CREATE INDEX IF NOT EXISTS visual_review_challenge_idx ON visual_review_requests(challenge_id);

CREATE TABLE IF NOT EXISTS runtime_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS hypotheses (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  description TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'CANDIDATE',
  evidence_for_json TEXT NOT NULL DEFAULT '[]',
  evidence_against_json TEXT NOT NULL DEFAULT '[]',
  proposed_tests_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS hypotheses_challenge_idx ON hypotheses(challenge_id);

CREATE TABLE IF NOT EXISTS tool_experiments (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  key TEXT NOT NULL,
  artifact_sha256 TEXT NOT NULL,
  tool TEXT NOT NULL,
  canonical_args TEXT NOT NULL,
  result_summary TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS tool_experiments_key_idx ON tool_experiments(challenge_id, key);
CREATE INDEX IF NOT EXISTS tool_experiments_challenge_idx ON tool_experiments(challenge_id);

CREATE TABLE IF NOT EXISTS specialist_results (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  confidence REAL NOT NULL,
  facts_json TEXT NOT NULL DEFAULT '[]',
  rejected_ideas_json TEXT NOT NULL DEFAULT '[]',
  recommended_actions_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS specialist_challenge_idx ON specialist_results(challenge_id);

CREATE TABLE IF NOT EXISTS recorded_tool_executions (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  canonical_args TEXT NOT NULL,
  result_json TEXT NOT NULL,
  artifact_hashes_json TEXT NOT NULL DEFAULT '[]',
  duration_ms INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS recorded_tools_key_idx ON recorded_tool_executions(challenge_id, tool);

CREATE TABLE IF NOT EXISTS solver_checkpoints (
  id TEXT PRIMARY KEY,
  challenge_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY,
  manifest_id TEXT NOT NULL,
  solved INTEGER NOT NULL,
  flag TEXT,
  techniques_json TEXT NOT NULL DEFAULT '[]',
  tool_calls INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  error TEXT,
  created_at INTEGER NOT NULL
);
`;
