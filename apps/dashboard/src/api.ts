export async function api<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? "GET",
    headers: opts.body ? { "content-type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) throw new Error(`API ${res.status} ${path}`);
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
  miscSolved: number;
  cryptoSolved: number;
  workers: number;
  workerSlots: number;
  diskFreeGb: number;
  adapter: string;
  agentRuntime: string;
  providers: { id: string; name: string; health: string }[];
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
  attachments: { id: string; name: string; sizeBytes: number | null; downloadStatus: string }[];
  artifacts: { id: string; path: string; operation: string; size: number }[];
  progress: { id: string; summary: string; confidence: number; stalled: number; createdAt: number }[];
  candidates: { id: string; value: string; confidence: number; status: string; reason: string; createdAt: number }[];
  submissions: { id: string; flagValue: string; status: string; submittedAt: number | null; createdAt: number }[];
  hints: { content: string; fetchedAt: number }[];
  timeline: { type: string; createdAt: number; payloadJson: string }[];
}

export function useEvents(onEvent: (e: { type: string; challengeId?: string | null; payload: Record<string, unknown>; createdAt: number }) => void): () => void {
  const es = new EventSource("/api/events/stream");
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
