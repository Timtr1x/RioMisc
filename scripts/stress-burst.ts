// Burst 30 mock challenges and assert worker count never exceeds solverConcurrency.
// Also: /api/health stays up, one worker per challenge, one lease per challenge.
import { startRuntime, type Runtime } from "../apps/server/src/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MockContestAdapter } from "@rio/contest";

const N = Number(process.env.RIO_BURST ?? 30);
const SLOTS = Number(process.env.RIO_SLOTS ?? 4);
const PORT = Number(process.env.RIO_BURST_PORT ?? 18765);

function mockAdapter(runtime: Runtime): MockContestAdapter {
  const adapter = (runtime.control as unknown as { deps: { adapter: MockContestAdapter } }).deps.adapter;
  if (adapter.kind !== "mock") throw new Error(`expected mock adapter, got ${adapter.kind}`);
  return adapter;
}

function workerChallengeIds(runtime: Runtime): string[] {
  const pool = (runtime.control as unknown as { workerPool: { workers: Map<string, { challengeId: string }> } }).workerPool;
  return [...pool.workers.values()].map((w) => w.challengeId);
}

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "rio-burst-"));
  const runtime = await startRuntime({
    configOverrides: {
      contest: { adapter: "mock", poll: { initialMs: 1000, maxMs: 2000 } },
      workers: { solverConcurrency: SLOTS, triageConcurrency: SLOTS },
      resources: { llm: SLOTS, cpuLight: SLOTS, cpuHeavy: 1, memHeavy: 1, diskHeavy: 1, network: SLOTS, sage: 1 },
      server: { host: "127.0.0.1", port: PORT, apiToken: null },
      paths: { dataDir: dir, configDir: join(process.cwd(), "config") },
    } as never,
  });

  try {
    const adapter = mockAdapter(runtime);
    const listed = await adapter.listChallenges();
    for (let i = listed.length; i < N; i++) {
      const id = `burst-${String(i + 1).padStart(3, "0")}`;
      adapter.addExternalChallenge({
        id,
        title: `Burst ${id}`,
        category: "MISC",
        description: `Synthetic burst challenge ${id}. Flag is in note.txt.`,
        attachments: [{ name: "note.txt", data: Buffer.from(`nothing here yet ${id}\n`) }],
      });
    }
    await runtime.control.pollOnce();

    const deadline = Date.now() + 45_000;
    let peak = 0;
    let maxTotal = 0;
    let healthOk = 0;
    while (Date.now() < deadline) {
      const s = runtime.control.status() as { workers: number; workerSlots: number; total: number };
      peak = Math.max(peak, Number(s.workers));
      maxTotal = Math.max(maxTotal, Number(s.total));
      if (Number(s.workers) > SLOTS) {
        throw new Error(`worker peak ${s.workers} exceeded slots ${SLOTS}`);
      }

      const ids = workerChallengeIds(runtime);
      const dupWorkers = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dupWorkers.length) throw new Error(`duplicate workers: ${dupWorkers.join(",")}`);

      const leases = runtime.repos.leases.list();
      const byChallenge = new Map<string, number>();
      for (const l of leases) byChallenge.set(l.challengeId, (byChallenge.get(l.challengeId) ?? 0) + 1);
      const dupLeases = [...byChallenge.entries()].filter(([, n]) => n > 1).map(([id]) => id);
      if (dupLeases.length) throw new Error(`duplicate leases: ${dupLeases.join(",")}`);

      const health = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (!health.ok) throw new Error(`/api/health HTTP ${health.status}`);
      const body = (await health.json()) as { workers?: number; workerSlots?: number };
      if (typeof body.workers === "number" && body.workers > SLOTS) {
        throw new Error(`/api/health reported workers ${body.workers} > slots ${SLOTS}`);
      }
      healthOk += 1;

      if (maxTotal >= N && peak >= 1 && Date.now() > deadline - 20_000) {
        // keep sampling a bit after we have 30 so the cap is exercised
      }
      await new Promise((r) => setTimeout(r, 400));
    }

    if (maxTotal < N) throw new Error(`only discovered ${maxTotal} challenges, wanted ${N}`);
    if (peak < 1) throw new Error("no solver workers were scheduled");
    if (healthOk < 5) throw new Error(`/api/health only succeeded ${healthOk} times`);

    const s = runtime.control.status() as { workers: number; total: number };
    console.log(`burst ok: total=${s.total} maxTotal=${maxTotal} peakWorkers=${peak} slots=${SLOTS} healthPolls=${healthOk}`);
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
