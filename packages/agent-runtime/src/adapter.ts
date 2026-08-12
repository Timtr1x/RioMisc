// AgentRuntimeAdapter — the ONLY place business code may touch an agent harness
// (Pi SDK, mock, or future harness). Everything else talks to this interface.
import type { SolverType, ModelRef } from "@rio/domain";
import type { ToolContext } from "@rio/tool-runtime";

export type { ModelRef };

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
}

export interface SolverSessionHandle {
  sessionId: string;
  /** Resolves when the agent is idle (no pending work). */
  waitForIdle(): Promise<void>;
  usage(): { inputTokens: number; outputTokens: number; toolCalls: number };
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
