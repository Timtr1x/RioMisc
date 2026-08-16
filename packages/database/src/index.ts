import { RioDb } from "./db.js";
import { MIGRATION_DDL } from "./ddl.js";
import { applySchemaMigrations } from "./schema-migrations.js";
import { ChallengeRepository } from "./repos/challenge.js";
import { EventLog } from "./repos/events.js";
import { SubmissionRepository, FlagCandidateRepository } from "./repos/submission.js";
import { SolverSessionRepository, ProgressRepository, HintRepository } from "./repos/session.js";
import { AttachmentRepository, ArtifactRepository } from "./repos/attachment.js";
import { LeaseRepository, ProviderRepository, ModelRepository, SettingsRepository } from "./repos/lease.js";
import { VisualEvidenceRepository, VisualReviewRepository } from "./repos/visual.js";
import { HypothesisRepository, ExperimentRepository, SpecialistResultRepository, RecordedToolRepository, BenchmarkRunRepository } from "./repos/intel.js";

export interface Repositories {
  db: RioDb;
  challenges: ChallengeRepository;
  events: EventLog;
  submissions: SubmissionRepository;
  candidates: FlagCandidateRepository;
  sessions: SolverSessionRepository;
  progress: ProgressRepository;
  hints: HintRepository;
  attachments: AttachmentRepository;
  artifacts: ArtifactRepository;
  leases: LeaseRepository;
  providers: ProviderRepository;
  models: ModelRepository;
  settings: SettingsRepository;
  visualEvidence: VisualEvidenceRepository;
  visualReviews: VisualReviewRepository;
  hypotheses: HypothesisRepository;
  experiments: ExperimentRepository;
  specialists: SpecialistResultRepository;
  recordedTools: RecordedToolRepository;
  benchmarkRuns: BenchmarkRunRepository;
}

export function createRepositories(dbPath: string): Repositories {
  const db = new RioDb(dbPath);
  // auto-migrate (idempotent CREATE TABLE IF NOT EXISTS)
  db.sqlite.exec(MIGRATION_DDL);
  applySchemaMigrations(db);
  return {
    db,
    challenges: new ChallengeRepository(db),
    events: new EventLog(db),
    submissions: new SubmissionRepository(db),
    candidates: new FlagCandidateRepository(db),
    sessions: new SolverSessionRepository(db),
    progress: new ProgressRepository(db),
    hints: new HintRepository(db),
    attachments: new AttachmentRepository(db),
    artifacts: new ArtifactRepository(db),
    leases: new LeaseRepository(db),
    providers: new ProviderRepository(db),
    models: new ModelRepository(db),
    settings: new SettingsRepository(db),
    visualEvidence: new VisualEvidenceRepository(db),
    visualReviews: new VisualReviewRepository(db),
    hypotheses: new HypothesisRepository(db),
    experiments: new ExperimentRepository(db),
    specialists: new SpecialistResultRepository(db),
    recordedTools: new RecordedToolRepository(db),
    benchmarkRuns: new BenchmarkRunRepository(db),
  };
}

export { parseModelCapabilities, serializeModelCapabilities } from "./repos/lease.js";
export { VisualEvidenceRepository, VisualReviewRepository } from "./repos/visual.js";

export { RioDb, buildSet } from "./db.js";
export type { RioDatabase } from "./db.js";
