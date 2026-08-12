// Solver Worker (Phase 6) — a forked child process that owns one agent session.
// The control plane is insulated from agent SDK crashes: a worker crash only
// loses the session process, never the persisted session file.
//
// Worker protocol (IPC messages):
//   parent → worker: {type:"start"|"inject"|"switch_model"|"ping"|"abort", ...}
//   worker → parent: ready/pong/progress/candidate/handoff/reflection_request/
//                    artifact/usage/idle/error
import { fork, type ChildProcess } from "node:child_process";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RioLogger } from "@rio/shared";
import type { Repositories } from "@rio/database";
import type { SolverType, ModelRef } from "@rio/domain";

export interface StartWorkerConfig {
  challengeId: string;
  sessionId: string;
  solverType: SolverType;
  workspaceRoot: string;
  sessionDir: string;
  systemPrompt: string;
  initialMessage: string;
  modelRef: ModelRef | null;
  /** Which agent harness the worker should use ("mock" | "pi"). */
  runtime: "mock" | "pi";
  /** Pi runtime: providers + how to resolve API keys (worker reads the encrypted file itself). */
  pi?: {
    piDir: string;
    secretsFile: string;
    providers: {
      id: string;
      displayName: string;
      protocol: "OPENAI_CHAT_COMPLETIONS" | "OPENAI_RESPONSES" | "ANTHROPIC_MESSAGES";
      baseUrl: string;
      apiKeyRef: string;
      modelId: string;
      contextWindow: number;
      maxOutputTokens: number;
    }[];
  };
}

export interface WorkerHandle {
  workerId: string;
  challengeId: string;
  sessionId: string;
  child: ChildProcess;
  lastPongAt: number;
  lastActivityAt: number;
  alive: boolean;
}

export interface WorkerMessage {
  type: string;
  challengeId?: string;
  sessionId?: string;
  [k: string]: unknown;
}

const WORKER_ENTRY = resolve(
  join(fileURLToPath(new URL(".", import.meta.url)), "..", "workers", "solver-worker.ts"),
);

export class WorkerPool {
  private workers = new Map<string, WorkerHandle>();
  private readonly pingIntervalMs: number;
  private readonly leaseTtlMs: number;

  constructor(
    private repos: Repositories,
    private logger: RioLogger,
    private handlers: {
      onMessage: (challengeId: string, msg: WorkerMessage) => void;
      onWorkerLost: (challengeId: string) => void;
      onWorkerExit: (challengeId: string, code: number | null) => void;
    },
    timing: { pingIntervalMs: number; leaseTtlMs: number },
  ) {
    this.pingIntervalMs = timing.pingIntervalMs;
    this.leaseTtlMs = timing.leaseTtlMs;
  }

  async startWorker(config: StartWorkerConfig): Promise<WorkerHandle> {
    if (this.workers.has(config.challengeId)) {
      throw new Error(`worker already running for ${config.challengeId}`);
    }
    const workerId = `w_${Math.random().toString(36).slice(2, 10)}`;
    const child = fork(WORKER_ENTRY, [], {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const handle: WorkerHandle = {
      workerId,
      challengeId: config.challengeId,
      sessionId: config.sessionId,
      child,
      lastPongAt: Date.now(),
      lastActivityAt: Date.now(),
      alive: true,
    };
    this.workers.set(config.challengeId, handle);

    child.on("message", (msg: WorkerMessage) => {
      handle.lastActivityAt = Date.now();
      if (msg.type === "pong") {
        handle.lastPongAt = Date.now();
        this.repos.leases.heartbeat(config.challengeId, Date.now() + this.leaseTtlMs);
        this.repos.sessions.heartbeat(config.sessionId);
        return;
      }
      this.handlers.onMessage(config.challengeId, msg);
    });

    child.on("exit", (code) => {
      handle.alive = false;
      this.workers.delete(config.challengeId);
      this.repos.leases.release(config.challengeId);
      this.logger.warn({ event: "worker_exit", challengeId: config.challengeId, workerId, code }, "solver worker exited");
      this.handlers.onWorkerExit(config.challengeId, code);
    });

    child.on("error", (e) => {
      this.logger.error({ event: "worker_error", challengeId: config.challengeId, err: e.message }, "solver worker error");
    });

    // start heartbeat pinger
    const timer = setInterval(() => {
      const h = this.workers.get(config.challengeId);
      if (!h || !h.alive) {
        clearInterval(timer);
        return;
      }
      if (Date.now() - h.lastPongAt > this.leaseTtlMs) {
        clearInterval(timer);
        this.#markLost(config.challengeId, "heartbeat timeout");
        return;
      }
      try {
        h.child.send({ type: "ping", t: Date.now() });
      } catch {
        this.#markLost(config.challengeId, "send failed");
      }
    }, this.pingIntervalMs);
    timer.unref();

    // send start config
    await new Promise<void>((resolveReady, rejectReady) => {
      const onMsg = (m: WorkerMessage) => {
        if (m.type === "ready") {
          child.off("message", onMsg);
          resolveReady();
        } else if (m.type === "error" && !m.challengeId) {
          child.off("message", onMsg);
          rejectReady(new Error(String(m.message ?? "worker failed to start")));
        }
      };
      child.on("message", onMsg);
      child.send({ type: "start", config });
      setTimeout(() => {
        child.off("message", onMsg);
        if (!handle.alive) rejectReady(new Error("worker died during startup"));
      }, 20_000).unref();
    });

    this.repos.leases.acquire({
      challengeId: config.challengeId,
      workerId,
      acquiredAt: Date.now(),
      heartbeatAt: Date.now(),
      expiresAt: Date.now() + this.leaseTtlMs,
    });
    return handle;
  }

  inject(challengeId: string, message: string): boolean {
    const h = this.workers.get(challengeId);
    if (!h || !h.alive) return false;
    h.child.send({ type: "inject", message });
    return true;
  }

  switchModel(challengeId: string, modelRef: ModelRef): boolean {
    const h = this.workers.get(challengeId);
    if (!h || !h.alive) return false;
    h.child.send({ type: "switch_model", modelRef });
    return true;
  }

  abort(challengeId: string): void {
    const h = this.workers.get(challengeId);
    if (!h) return;
    try {
      h.child.send({ type: "abort" });
    } catch {
      /* ignore */
    }
  }

  kill(challengeId: string): void {
    const h = this.workers.get(challengeId);
    if (!h) return;
    h.child.kill("SIGKILL");
  }

  has(challengeId: string): boolean {
    return this.workers.has(challengeId);
  }

  get(challengeId: string): WorkerHandle | null {
    return this.workers.get(challengeId) ?? null;
  }

  activeCount(): number {
    return this.workers.size;
  }

  /** Idle workers (no activity for a while) — candidate for stop. */
  idleWorkers(sinceMs: number): WorkerHandle[] {
    return [...this.workers.values()].filter((h) => Date.now() - h.lastActivityAt > sinceMs);
  }

  stopAll(): void {
    for (const h of [...this.workers.values()]) {
      try {
        h.child.send({ type: "abort" });
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        if (h.alive) h.child.kill("SIGKILL");
      }, 2000).unref();
    }
  }

  #markLost(challengeId: string, reason: string): void {
    const h = this.workers.get(challengeId);
    if (!h) return;
    this.logger.warn({ event: "worker_lost", challengeId, workerId: h.workerId, reason }, "worker lease lost");
    h.alive = false;
    this.workers.delete(challengeId);
    try {
      h.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
    this.repos.leases.release(challengeId);
    this.handlers.onWorkerLost(challengeId);
  }
}
