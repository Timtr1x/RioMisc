export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let detail = `API ${res.status} ${path}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      /* keep status text */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export interface Status {
  total: number;
  solved: number;
  active: number;
  queued: number;
  preparing: number;
  parked: number;
  paused: number;
  unsupported: number;
  error: number;
  blocked?: number;
  unknownSubmissions?: number;
  miscSolved: number;
  cryptoSolved: number;
  workers: number;
  workerSlots: number;
  diskFreeGb: number;
  adapter: string;
  contest?: ContestStatus;
  agentRuntime: string;
  executionMode?: string;
  filesystemIsolation?: boolean;
  networkIsolation?: boolean;
  providers: { id: string; name: string; health: string; consecutiveFailures?: number }[];
  pendingVisualReviews?: number;
  orchestration?: OrchestrationStatus;
}

export interface OrchestrationStatus {
  mode: string;
  enabled: boolean;
  health: string;
  modelId: string | null;
  lastReplanAt: number | null;
  lastTrigger: string | null;
  livePlanId: string | null;
  livePlanFresh: boolean;
  fallback: boolean;
  inFlight: number;
  solverSlots: { used: number; total: number };
  reflectionSlots: { used: number; total: number };
  nextPeriodicMs?: number;
}

export interface ManagerPlanRow {
  id: string;
  status: string;
  trigger: string;
  summary: string | null;
  modelId: string | null;
  durationMs: number;
  createdAt: number;
  decisions?: {
    challengeId: string;
    action: string;
    priority: number;
    reason: string;
    status: string;
    rejectionReason: string | null;
  }[];
}

export interface ChallengeOrchestrationView {
  challengeId: string;
  strategyLocked: boolean;
  manualDispatch: string;
  reflectionOverride: string;
  reflectionModeOverride: string | null;
  managerAction: string | null;
  managerPriority: number | null;
  managerReflectionEnabled: boolean | null;
  managerReason: string | null;
  reflectionEnabled?: boolean;
  reflectionMode?: string;
}

export interface ReflectionRunRow {
  id: string;
  trigger: string;
  mode: string;
  status: string;
  resultJson: string | null;
  error: string | null;
  createdAt: number;
  deliveredAt: number | null;
}

export interface VisualReviewRow {
  id: string;
  challengeId: string;
  sourcePath: string;
  question: string | null;
  reason: string | null;
  status: string;
  answerJson: string | null;
  createdAt: number;
  answeredAt: number | null;
}

export interface ContestStatus {
  kind: string;
  connected: boolean;
  baseUrl: string | null;
  lastPollAt: number | null;
  lastError: string | null;
  lastListed: number;
  miscCryptoOnly: boolean;
  connectedAt: number | null;
  trustedCredentialOrigins?: string[];
}

export interface ChallengeRow {
  id: string;
  title: string;
  category: string;
  score: number | null;
  status: string;
  priority: number;
  priorityScore: number | null;
  elapsedMs: number;
  progress: string;
  hint: string;
  wrong: number;
  solver: string | null;
  difficulty: number | null;
  blockedReason: string | null;
  flag?: string | null;
  flagStatus?: string | null;
  flagAt?: number | null;
}

export interface ChallengeDetail {
  id: string;
  title: string;
  description: string;
  category: string;
  lifecycleStatus: string;
  hintStatus: string;
  progressStatus: string;
  priority: number;
  wrongSubmissionCount: number;
  solverRestartCount: number;
  startedAt: number | null;
  discoveredAt: number;
  wallClockSolveMs: number;
  blockedReason: string | null;
  attachments: { id: string; name: string; sizeBytes: number | null; downloadStatus: string }[];
  artifacts: { id: string; path: string; operation: string; size: number; parentArtifactId?: string | null }[];
  visualEvidence?: { id: string; summary: string; analyzer: string; confidence: number; observations: { type: string; value?: string; description: string }[]; createdAt: number }[];
  hypotheses?: { id: string; description: string; status: string; confidence: number; evidenceForJson?: string; evidenceAgainstJson?: string }[];
  experiments?: { id: string; tool: string; outcome: string; resultSummary: string; canonicalArgs?: string }[];
  specialists?: { id: string; kind: string; conclusion: string; confidence: number; recommendedActionsJson?: string }[];
  cryptoState?: {
    primitive: string;
    knownVariables?: Record<string, { value: string; source?: string; confidence?: number }>;
    unknownVariables?: string[];
    attackCandidates?: { id: string; attack: string; confidence: number; estimatedCost: string; status: string }[];
    attempts?: { id: string; attack: string; tool?: string; outcome: string; summary: string; at: number }[];
    assumptions?: string[];
    updatedAt?: number;
  } | null;
  progress: { id: string; summary: string; confidence: number; stalled: number; createdAt: number }[];
  candidates: { id: string; value: string; confidence: number; status: string; reason: string; createdAt: number }[];
  submissions: { id: string; flagValue: string; status: string; submittedAt: number | null; createdAt: number }[];
  hints: { content: string; fetchedAt: number }[];
  timeline: { type: string; createdAt: number; payloadJson: string }[];
  sessions?: { id: string; providerId: string | null; modelId: string | null; status: string; piSessionFile: string | null; mode?: string }[];
}

/** SSE goes straight to the API so Vite's proxy cannot buffer live events. */
const EVENTS_URL = "http://127.0.0.1:3000/api/events/stream";

export function useEvents(onEvent: (e: { type: string; challengeId?: string | null; payload: Record<string, unknown>; createdAt: number }) => void): () => void {
  const es = new EventSource(EVENTS_URL);
  es.onmessage = (msg) => {
    try {
      onEvent(JSON.parse(msg.data));
    } catch {
      /* ignore */
    }
  };
  return () => es.close();
}

export function fmtMs(ms: number): string {
  if (!ms) return "-";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h${m % 60}m` : m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}
