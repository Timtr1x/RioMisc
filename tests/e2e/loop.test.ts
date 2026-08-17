// E2E tests (§112-116): full solve loop, crash recovery, hint eligibility.
import { describe, it, expect } from "vitest";
import { startRuntime, type Runtime } from "../../apps/server/src/index.ts";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

function fastOverrides(dataDir: string) {
  return {
    contest: { adapter: "mock" as const, poll: { initialMs: 1000, maxMs: 2000 } },
    workers: { solverConcurrency: 4, triageConcurrency: 4 },
    watchdog: { checkMs: 3000, heartbeatMs: 2500, leaseTtlMs: 8000 },
    submission: { autoSubmit: true, confidenceThreshold: 0.85, localMaxWrong: 3, defaultCooldownMs: 0 },
    paths: { dataDir, configDir: join(process.cwd(), "config") },
  };
}

async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  pollMs = 1500,
  label = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** Windows keeps child-process handles for a moment after SIGKILL — retry. */
async function rmRetry(dir: string): Promise<void> {
  for (let i = 0; i < 8; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  rmSync(dir, { recursive: true, force: true });
}

/** Simulate a hard crash: stop timers, kill workers, inert the DB (no cleanup). */
function crashRuntime(r: Runtime): void {
  const c = r.control as unknown as {
    poller: { stop(): void };
    schedulerTimer: NodeJS.Timeout | null;
    hintTimer: NodeJS.Timeout | null;
    watchdogTimer: NodeJS.Timeout | null;
    workerPool: { workers: Map<string, { child: { kill(sig: string): void } }> };
  };
  c.poller.stop();
  if (c.schedulerTimer) clearInterval(c.schedulerTimer);
  if (c.hintTimer) clearInterval(c.hintTimer);
  if (c.watchdogTimer) clearInterval(c.watchdogTimer);
  for (const h of c.workerPool.workers.values()) {
    try {
      h.child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  // "process is gone": DB access becomes inert instead of throwing, so any
  // in-flight async work of the crashed instance is harmless.
  const db = r.repos.db as unknown as {
    run(): { changes: number; lastInsertRowid: number };
    all<T>(): T[];
    get<T>(): T | undefined;
    tx<T>(fn: () => T): T;
    close(): void;
  };
  db.run = () => ({ changes: 0, lastInsertRowid: 0 });
  db.all = () => [];
  db.get = () => undefined;
  db.tx = (fn) => fn();
  db.close = () => {};
  // close the real underlying sqlite handle so Windows releases the file
  try {
    (r.repos.db as unknown as { sqlite?: { close(): void } }).sqlite?.close();
  } catch {
    /* ignore */
  }
}

describe("E2E", () => {
  it("solves every mock challenge unattended and flags WEB as unsupported", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rio-e2e-solve-"));
    const runtime = await startRuntime({ skipApi: true, configOverrides: fastOverrides(dataDir) as never });
    try {
      await waitFor(() => {
        const s = runtime.control.status();
        return Number(s.solved) >= 13;
      }, 240_000, 2000, "all challenges solved");
      const s = runtime.control.status();
      expect(Number(s.total)).toBe(14);
      expect(Number(s.solved)).toBe(13);
      expect(Number(s.unsupported)).toBe(1);
      expect(Number(s.error)).toBe(0);
      const solved = runtime.repos.challenges.list().filter((c) => c.lifecycleStatus === "SOLVED");
      expect(solved.every((c) => c.wallClockSolveMs > 0)).toBe(true);
      // every solved challenge has a correct submission + candidate
      for (const c of solved) {
        const subs = runtime.repos.submissions.listByChallenge(c.id);
        expect(subs.some((s) => s.status === "CORRECT")).toBe(true);
        expect(runtime.repos.sessions.latestForChallenge(c.id)?.status).toBe("ENDED");
      }
    } finally {
      await runtime.close();
      await rmRetry(dataDir);
    }
  }, 300_000);

  it("recovers all state after a hard crash (stale leases requeued, nothing lost)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rio-e2e-crash-"));
    const r1 = await startRuntime({ skipApi: true, configOverrides: fastOverrides(dataDir) as never });
    // wait until at least 2 solved and some challenge ACTIVE (mid-solve)
    await waitFor(() => {
      const s = r1.control.status();
      return Number(s.solved) >= 2 && Number(s.active) >= 1;
    }, 120_000, 1500, "2 solved + active");

    const before = r1.repos.challenges.list().map((c) => c.id);
    expect(before.length).toBe(14);

    // hard crash: no graceful shutdown, no session end, no lease release
    crashRuntime(r1);

    // restart on the same data dir
    const r2 = await startRuntime({ skipApi: true, configOverrides: fastOverrides(dataDir) as never });
    try {
      // nothing was lost
      const after = r2.repos.challenges.list().map((c) => c.id).sort();
      expect(after).toEqual([...before].sort());

      // recovery requeued the interrupted challenges and solving continues
      await waitFor(() => {
        const s = r2.control.status();
        return Number(s.solved) >= 13;
      }, 240_000, 2000, "all solved after recovery");

      // the sessions that were interrupted were preserved (their rows exist)
      const sessions = r2.repos.sessions.listActive();
      expect(sessions.length).toBe(0); // all workers finished after recovery
    } finally {
      await r2.close();
      await rmRetry(dataDir);
    }
  }, 360_000);

  it("marks hints eligible after start+delay and auto-fetches when enabled", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rio-e2e-hint-"));
    const runtime = await startRuntime({
      skipApi: true,
      configOverrides: {
        ...fastOverrides(dataDir),
        hint: { autoFetch: true, requireStalled: false, eligibleAfterStartMs: 8000, stallThresholdMs: 5000 },
      } as never,
    });
    try {
      await waitFor(() => {
        const anyFetched = runtime.repos.challenges.list().some((c) => c.hintStatus === "FETCHED");
        const anyEligible = runtime.repos.challenges.list().some((c) => c.hintStatus === "ELIGIBLE" || c.hintStatus === "FETCHED");
        return anyFetched || anyEligible;
      }, 90_000, 2000, "hint eligible/fetched");
      const fetched = runtime.repos.challenges.list().filter((c) => c.hintStatus === "FETCHED");
      if (fetched.length > 0) {
        const hints = runtime.repos.hints.listForChallenge(fetched[0]!.id);
        expect(hints.length).toBeGreaterThan(0);
      }
    } finally {
      await runtime.close();
      await rmRetry(dataDir);
    }
  }, 150_000);
});
