// AgentRuntimeAdapter — the ONLY place business code may touch an agent harness
// (Pi SDK, mock, or future harness). Everything else talks to this interface.
import type { SolverType, ModelRef, ProviderProtocol } from "@rio/domain";
import type { ToolContext } from "@rio/tool-runtime";

export type { ModelRef };

/** One resolvable provider+model pair for the Pi runtime (worker-side). */
export interface PiProviderSpec {
  id: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  /** Ref into the encrypted SecretStore; the worker resolves it to apiKey. */
  apiKeyRef: string;
  /** Decrypted key (worker fills this in before creating sessions). */
  apiKey: string;
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
}

export interface ToolSpec {
  name: string;
  description: string;
}

export interface SolverSessionConfig {
  /** Our own solver session id (DB row). */
  sessionId: string;
  challengeId: string;
  solverType: SolverType;
  /** Working directory for the agent (workspace work/). */
  cwd: string;
  /** Challenge workspace root (for safeResolve). */
  workspaceRoot: string;
  /** Directory where persisted agent sessions live (data/sessions/...). */
  sessionDir: string;
  systemPrompt: string;
  initialMessage: string;
  modelRef: ModelRef | null;
  tools: ToolSpec[];
  /** Shared tool runtime context (fs guard, process runner, emit). */
  toolContext: ToolContext;
  /** Pi runtime: resolvable providers (apiKey already decrypted, worker-side). */
  piProviders?: PiProviderSpec[];
  /** SDK-reported session file/id from a previous run (resume only). */
  persistedSession?: {
    piSessionId: string | null;
    piSessionFile: string | null;
  };
}

export interface SolverSessionHandle {
  sessionId: string;
  /** Resolves when the agent is idle (no pending work). */
  waitForIdle(): Promise<void>;
  usage(): { inputTokens: number; outputTokens: number; toolCalls: number };
  persistence(): { externalSessionId: string | null; sessionFile: string | null };
}

/** Shipped create-vs-resume branch. Tests drive this, not a reimplementation. */
export async function openSolverSession(
  adapter: AgentRuntimeAdapter,
  config: SolverSessionConfig,
  resume: boolean,
): Promise<SolverSessionHandle> {
  if (resume) return adapter.resumeSolverSession(config);
  return adapter.createSolverSession(config);
}

export interface AgentRuntimeAdapter {
  readonly kind: string;
  createSolverSession(config: SolverSessionConfig): Promise<SolverSessionHandle>;
  /** Resume a persisted session (same sessionId → same pi session file). */
  resumeSolverSession(config: SolverSessionConfig): Promise<SolverSessionHandle>;
  /** Deliver a message mid-session (hint, wrong-flag feedback, challenge update). */
  inject(session: SolverSessionHandle, message: string): Promise<void>;
  switchModel(session: SolverSessionHandle, modelRef: ModelRef): Promise<void>;
  abort(session: SolverSessionHandle): Promise<void>;
  compact(session: SolverSessionHandle): Promise<void>;
}

export function runtimeAvailable(adapter: AgentRuntimeAdapter | null): adapter is AgentRuntimeAdapter {
  return adapter !== null;
}
