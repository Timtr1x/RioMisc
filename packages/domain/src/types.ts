// Domain types for RioMisc MVP-1.
// This package must stay free of any framework dependency (Fastify/Pi/React/Docker).

export type ChallengeCategory =
  | "MISC"
  | "CRYPTO"
  | "WEB"
  | "PWN"
  | "REVERSE"
  | "OTHER"
  | "UNKNOWN";

export type ChallengeLifecycleStatus =
  | "DISCOVERED"
  | "PREPARING"
  | "READY"
  | "QUEUED"
  | "ACTIVE"
  | "VERIFYING"
  | "SUBMITTING"
  | "SOLVED"
  | "PAUSED"
  | "PARKED"
  | "UNSUPPORTED"
  | "ERROR";

export type HintStatus =
  | "NOT_SUPPORTED"
  | "LOCKED"
  | "ELIGIBLE"
  | "FETCHING"
  | "FETCHED"
  | "DECLINED";

export type ProgressStatus = "UNKNOWN" | "ACTIVE" | "STALLED";

export type ChallengeStartStatus =
  | "NOT_REQUIRED"
  | "NOT_STARTED"
  | "STARTING"
  | "STARTED"
  | "FAILED";

export type ModelStatus = "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";

export type SolverType = "MISC" | "CRYPTO" | "TRIAGE" | "REFLECTION";

export type DownloadStatus = "PENDING" | "DOWNLOADING" | "DOWNLOADED" | "FAILED";

export type CandidateStatus =
  | "PENDING"
  | "REJECTED_LOCAL"
  | "VERIFIED"
  | "SUBMITTED"
  | "SUBMISSION_UNKNOWN"
  | "WRONG"
  | "CORRECT";

export type SubmissionStatus =
  | "QUEUED"
  | "SENDING"
  | "SENT"
  | "CORRECT"
  | "WRONG"
  | "RATE_LIMITED"
  | "ERROR"
  | "UNKNOWN";

export type SessionStatus =
  | "CREATED"
  | "ACTIVE"
  | "PAUSED"
  | "INTERRUPTED"
  | "STALLED"
  | "ENDED"
  | "ERROR";

/** Host-native execution. Not an OS sandbox. */
export type ExecutionMode = "NATIVE_TRUSTED";

export type NetworkIsolation = "NONE";

export interface ModelRef {
  providerId: string | null;
  modelId: string | null;
}

// ---------------------------------------------------------------------------
// Provider Protocol
// ---------------------------------------------------------------------------

export type ProviderProtocol =
  | "OPENAI_CHAT_COMPLETIONS"
  | "OPENAI_RESPONSES"
  | "ANTHROPIC_MESSAGES";

export type ModelRole = "PRIMARY" | "FALLBACK" | "GENERAL";

export type ProviderHealth = "HEALTHY" | "DEGRADED" | "DOWN" | "UNKNOWN";

export type CompatProfile = "AUTO" | "OPENAI" | "DEEPSEEK" | "ZAI" | "ANTHROPIC";

export type StartPolicy = "ON_DISCOVERY" | "ON_PREPARATION" | "ON_SOLVER_ASSIGNMENT";

export interface ModelCapabilities {
  text: boolean;
  toolCalling: boolean;
  vision: boolean;
  reasoning: boolean;
  structuredOutput: boolean;
}

export interface ModelAssignments {
  primarySolverModelId: string | null;
  reflectionModelId: string | null;
  visionModelId: string | null;
  triageModelId: string | null;
  managerModelId: string | null;
}

export type AssignmentSlot = "primarySolver" | "reflection" | "triage" | "vision" | "manager";

export type ReflectionMode = "OFF" | "HEURISTIC" | "LLM" | "HYBRID";

export type ReflectionTrigger =
  | "STALLED"
  | "NO_SIGNAL_STREAK"
  | "WRONG_FLAG"
  | "REPEATED_EXPERIMENT"
  | "SOLVER_REQUEST"
  | "MANUAL";

export type ReflectionRunStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FALLBACK" | "FAILED" | "SKIPPED";

export type ManagerMode = "OFF" | "SHADOW" | "ACTIVE";

export type ManagerTrigger =
  | "CHALLENGE_BATCH"
  | "SLOT_AVAILABLE"
  | "CHALLENGE_SOLVED"
  | "SOLVER_STALLED"
  | "SCORE_CHANGED"
  | "MANUAL"
  | "PERIODIC"
  | "STARTUP";

export type ManagerPlanStatus = "PENDING" | "RUNNING" | "APPLIED" | "PARTIAL" | "FAILED" | "FALLBACK";

export type DispatchAction = "START" | "HOLD" | "CONTINUE";

export type ManualDispatch = "AUTO" | "FORCE_START" | "FORCE_HOLD";

export type ReflectionOverride = "INHERIT" | "ON" | "OFF";

export type DecisionApplyStatus = "APPLIED" | "REJECTED" | "CLAMPED";

export interface ReflectionStep {
  action: string;
  reason: string;
  expectedSignal: string;
}

export interface StructuredReflectionResult {
  diagnosis: string;
  likelyMistakes: string[];
  missedEvidence: string[];
  recommendedNextSteps: ReflectionStep[];
  shouldContinueCurrentDirection: boolean;
  recommendHandoff: "MISC" | "CRYPTO" | null;
  confidence: number;
}

export interface DispatchDecision {
  challengeId: string;
  action: DispatchAction;
  priority: number;
  reflectionEnabled: boolean | null;
  reason: string;
}

export interface DispatchPlan {
  summary: string;
  decisions: DispatchDecision[];
}

export interface ChallengeOrchestration {
  challengeId: string;
  strategyLocked: boolean;
  manualDispatch: ManualDispatch;
  reflectionOverride: ReflectionOverride;
  reflectionModeOverride: ReflectionMode | null;
  managerAction: DispatchAction | null;
  managerPriority: number | null;
  managerReflectionEnabled: boolean | null;
  managerReason: string | null;
  managerPlanId: string | null;
  managerUpdatedAt: number | null;
  updatedAt: number;
}

export interface ManagerPlanRecord {
  id: string;
  status: ManagerPlanStatus;
  providerId: string | null;
  modelId: string | null;
  trigger: string;
  snapshotHash: string | null;
  summary: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface ManagerDecisionRecord {
  id: string;
  planId: string;
  challengeId: string;
  action: DispatchAction;
  priority: number;
  reflectionEnabled: boolean | null;
  reason: string;
  status: DecisionApplyStatus;
  rejectionReason: string | null;
  createdAt: number;
}

export interface ReflectionRunRecord {
  id: string;
  challengeId: string;
  trigger: ReflectionTrigger;
  mode: ReflectionMode;
  providerId: string | null;
  modelId: string | null;
  fingerprint: string;
  status: ReflectionRunStatus;
  snapshotJson: string;
  resultJson: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  deliveredAt: number | null;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export type VisualSourceType =
  | "IMAGE"
  | "BITPLANE"
  | "CHANNEL"
  | "SPECTROGRAM"
  | "VIDEO_FRAME"
  | "PDF_PAGE"
  | "CONTACT_SHEET"
  | "OTHER";

export type VisualAnalyzer = "LOCAL" | "VISION_MODEL" | "HUMAN";

export type VisualObservationType =
  | "TEXT"
  | "QR"
  | "BARCODE"
  | "SHAPE"
  | "COLOR"
  | "PATTERN"
  | "ANOMALY"
  | "STRUCTURE"
  | "OTHER";

export type VisualReviewStatus = "NONE" | "PENDING" | "ANSWERED" | "CANCELLED";

export interface VisualObservation {
  type: VisualObservationType;
  value?: string;
  description: string;
  region?: { x: number; y: number; width: number; height: number };
  confidence: number;
}

export interface VisualEvidence {
  id: string;
  challengeId: string;
  sourceArtifactId: string | null;
  sourcePath: string;
  sourceType: VisualSourceType;
  question: string | null;
  analyzer: VisualAnalyzer;
  observations: VisualObservation[];
  summary: string;
  confidence: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Challenge
// ---------------------------------------------------------------------------

export interface Challenge {
  id: string;
  remoteId: string | null;

  title: string;
  description: string;

  category: ChallengeCategory;
  subcategory: string | null;

  score: number | null;
  solveCount: number | null;

  lifecycleStatus: ChallengeLifecycleStatus;
  startStatus: ChallengeStartStatus;
  hintStatus: HintStatus;
  progressStatus: ProgressStatus;

  /** Manual priority: -100 .. +100 (mapped from LOW/NORMAL/HIGH/CRITICAL). */
  priority: number;
  /** Cached scheduler score from the last scheduling round. */
  lastPriorityScore: number | null;

  difficultyEstimate: number | null;

  discoveredAt: number;
  updatedAt: number;

  remoteCreatedAt: number | null;
  remoteUpdatedAt: number | null;

  startedAt: number | null;
  solverStartedAt: number | null;

  wallClockSolveMs: number;
  activeSolveMs: number;

  currentSolverType: SolverType | null;
  currentSessionId: string | null;

  wrongSubmissionCount: number;
  solverRestartCount: number;

  pausedReason: string | null;
  parkedReason: string | null;
  blockedReason: string | null;

  contentHash: string | null;
}

export const SOLVER_CATEGORIES: readonly ChallengeCategory[] = ["MISC", "CRYPTO"];

// ---------------------------------------------------------------------------
// Attachments / Artifacts
// ---------------------------------------------------------------------------

export interface Attachment {
  id: string;
  challengeId: string;

  remoteId: string | null;
  name: string;
  remoteUrl: string | null;

  localPath: string | null;

  sizeBytes: number | null;
  sha256: string | null;
  mime: string | null;

  downloadStatus: DownloadStatus;

  createdAt: number;
  downloadedAt: number | null;
}

export interface Artifact {
  id: string;
  challengeId: string;
  parentArtifactId: string | null;
  path: string;
  mime: string | null;
  size: number;
  sha256: string;
  generatedBy: "DOWNLOAD" | "TOOL" | "AGENT";
  operation: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Sessions / Progress
// ---------------------------------------------------------------------------

export interface SolverSession {
  id: string;
  challengeId: string;
  solverType: SolverType;

  piSessionId: string | null;
  piSessionFile: string | null;

  providerId: string | null;
  modelId: string | null;

  status: SessionStatus;

  startedAt: number;
  lastActiveAt: number;
  endedAt: number | null;

  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
}

export interface ProgressReport {
  id: string;
  challengeId: string;
  sessionId: string | null;

  summary: string;
  hypothesesJson: string;
  confirmedFactsJson: string;
  rejectedHypothesesJson: string;
  nextActionsJson: string;

  confidence: number;
  progressLevel: "SIGNIFICANT" | "MINOR" | "NONE";
  stalled: boolean;

  createdAt: number;
}

// ---------------------------------------------------------------------------
// Flags / Submissions
// ---------------------------------------------------------------------------

export interface EvidenceRef {
  type: "artifact" | "script" | "tool_output" | "reason";
  path?: string;
  text?: string;
}

export interface FlagCandidate {
  id: string;
  challengeId: string;
  sessionId: string | null;

  value: string;
  confidence: number;
  reason: string;
  evidenceJson: string;

  status: CandidateStatus;

  createdAt: number;
  submittedAt: number | null;
}

export interface Submission {
  id: string;
  challengeId: string;
  candidateId: string | null;

  flagHash: string;
  flagValue: string;

  status: SubmissionStatus;

  remoteResponseJson: string | null;
  error: string | null;

  submittedAt: number | null;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface DomainEvent {
  id: string;
  type: string;
  challengeId: string | null;
  payloadJson: string;
  createdAt: number;
  processedAt: number | null;
}

// ---------------------------------------------------------------------------
// Providers / Models
// ---------------------------------------------------------------------------

export interface ModelProviderConfig {
  id: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  apiKeyRef: string;
  enabled: boolean;
  health: ProviderHealth;
  consecutiveFailures: number;
  lastTestedAt: number | null;
  createdAt: number;
  /** How to talk to this provider. AUTO infers from URL / protocol / model. */
  compatProfile: CompatProfile;
}

export interface ModelConfig {
  id: string;
  providerId: string;
  modelName: string;
  contextWindow: number;
  maxOutputTokens: number;
  enabled: boolean;
  role: ModelRole;
  createdAt: number;
  capabilities: ModelCapabilities;
}

// ---------------------------------------------------------------------------
// Worker leases
// ---------------------------------------------------------------------------

export interface WorkerLease {
  id: string;
  challengeId: string;
  workerId: string;
  acquiredAt: number;
  heartbeatAt: number;
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Contest adapter (remote side)
// ---------------------------------------------------------------------------

export interface RemoteAttachment {
  remoteId: string | null;
  name: string;
  url: string | null;
  sizeBytes: number | null;
}

export interface RemoteChallenge {
  remoteId: string;
  title: string;
  description: string;
  category: string;
  score: number | null;
  solveCount: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  /** Present when the list/detail payload already includes file metadata. */
  attachments?: RemoteAttachment[];
}

export interface RemoteChallengeDetail extends RemoteChallenge {
  attachments: RemoteAttachment[];
}

export interface StartChallengeResult {
  ok: boolean;
  message?: string;
}

export interface HintResult {
  ok: boolean;
  hint?: string;
  notAvailable?: boolean;
  message?: string;
}

export interface SubmissionResult {
  ok: boolean;
  correct: boolean;
  status: "CORRECT" | "WRONG" | "RATE_LIMITED" | "ERROR" | "UNKNOWN";
  cooldownMs?: number;
  message?: string;
  raw: unknown;
}

export interface DownloadResult {
  ok: boolean;
  bytes: number;
  sha256: string;
  retryable: boolean;
  message?: string;
}

export type HypothesisStatus = "CANDIDATE" | "TESTING" | "SUPPORTED" | "REJECTED" | "CONFIRMED";
export type ExperimentOutcome = "NEW_EVIDENCE" | "NO_SIGNAL" | "FAILED" | "ALREADY_TESTED";
export type ActionCost = "CHEAP" | "NORMAL" | "EXPENSIVE";
export type SpecialistKind = "IMAGE" | "PCAP" | "AUDIO" | "ARCHIVE" | "RSA" | "PRNG" | "LATTICE";

export interface ProposedTest {
  tool: string;
  args: unknown;
  expectedInformation: string;
  ifPositive: string;
  ifNegative: string;
  estimatedCost: ActionCost;
}

export interface Hypothesis {
  id: string;
  challengeId: string;
  description: string;
  confidence: number;
  status: HypothesisStatus;
  evidenceForJson: string;
  evidenceAgainstJson: string;
  proposedTestsJson: string;
  createdAt: number;
  updatedAt: number;
}

export interface ToolExperiment {
  id: string;
  challengeId: string;
  key: string;
  artifactSha256: string;
  tool: string;
  canonicalArgs: string;
  resultSummary: string;
  outcome: ExperimentOutcome;
  createdAt: number;
}

export interface SolverCheckpoint {
  challengeId: string;
  solverType: SolverType;
  confirmedFacts: string[];
  activeHypotheses: string[];
  rejectedHypotheses: string[];
  importantArtifacts: string[];
  visualEvidenceIds: string[];
  wrongFlags: string[];
  currentPlan: string[];
  unresolvedQuestions: string[];
  createdAt: number;
}

export interface SpecialistResult {
  id: string;
  challengeId: string;
  kind: SpecialistKind;
  conclusion: string;
  confidence: number;
  factsJson: string;
  rejectedIdeasJson: string;
  recommendedActionsJson: string;
  createdAt: number;
}

export interface RecordedToolExecution {
  id: string;
  challengeId: string;
  tool: string;
  canonicalArgs: string;
  resultJson: string;
  artifactHashesJson: string;
  durationMs: number;
  createdAt: number;
}

export interface BenchmarkManifest {
  id: string;
  category: "MISC" | "CRYPTO";
  subcategory: string[];
  difficulty: number;
  flag: string;
  expectedTechniques: string[];
  maxSolveSeconds: number;
}

export interface BenchmarkRunResult {
  id: string;
  manifestId: string;
  solved: boolean;
  flag: string | null;
  techniques: string[];
  toolCalls: number;
  durationMs: number;
  error: string | null;
  createdAt: number;
}

export interface ContestCapabilities {
  polling: boolean;
  supportsStartChallenge: boolean;
  supportsHints: boolean;
  supportsLeaderboard: boolean;
  dynamicScoring: boolean;
  exposesSolveCount: boolean;
  hint: {
    unlockMode: "AFTER_START" | "AFTER_DISCOVERY" | "CUSTOM" | "UNKNOWN";
    unlockDelayMs: number | null;
    hasPenalty: boolean | null;
  };
  submission: {
    cooldownMs: number | null;
    maxWrongAttempts: number | null;
    hasPenalty: boolean | null;
  };
  attachment: {
    maxConcurrentDownloads: number;
  };
}

// ---------------------------------------------------------------------------
// Triage / Reflection results
// ---------------------------------------------------------------------------

export interface TriageResult {
  subcategory: string[];
  difficulty: 1 | 2 | 3 | 4 | 5;
  resourceProfile: "LIGHT" | "NORMAL" | "HEAVY";
  initialHypotheses: string[];
  suggestedTools: string[];
  likelyCrossCategory: "NONE" | "MISC_TO_CRYPTO" | "CRYPTO_TO_MISC";
  summary: string;
}

export interface ReflectionResult {
  diagnosis: string;
  likelyMistakes: string[];
  missedEvidence: string[];
  recommendedNextSteps: string[];
  shouldContinueCurrentDirection: boolean;
  recommendHandoff?: SolverType;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export type ResourceType =
  | "LLM"
  | "CPU_LIGHT"
  | "CPU_HEAVY"
  | "MEM_HEAVY"
  | "DISK_HEAVY"
  | "NETWORK"
  | "SAGE";

export interface ResourceProfile {
  resourceClass: "LIGHT" | "NORMAL" | "HEAVY";
  resourceTypes: ResourceType[];
}

export interface SchedulingCandidate {
  challengeId: string;
  category: ChallengeCategory;
  /** Manual priority -100..+100 (mapped from LOW/NORMAL/HIGH/CRITICAL). */
  manualPriority: number;
  score: number | null;
  solveCount: number | null;
  difficulty: number | null;
  attempts: number;
  progress: ProgressStatus;
  elapsedActiveMs: number;
  hintStatus: HintStatus;
  requiredResources: ResourceProfile;
  discoveredAt: number;
}

export interface WorkerCommand {
  type: "start" | "resume" | "inject_hint" | "inject_feedback" | "pause" | "abort" | "switch_model";
  challengeId: string;
  sessionId: string | null;
  message?: string;
  modelId?: string | null;
}
