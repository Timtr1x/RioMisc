// Smoke test: boot the full runtime with mock contest, wait for solves.
import { startRuntime } from "../apps/server/src/index.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const dataDir = mkdtempSync(join(tmpdir(), "rio-smoke-"));
const runtime = await startRuntime({
  skipApi: true,
  configOverrides: {
    contest: { adapter: "mock", poll: { initialMs: 1000, maxMs: 2000 } },
    workers: { solverConcurrency: 4, triageConcurrency: 4 },
    watchdog: { checkMs: 5000, heartbeatMs: 3000, leaseTtlMs: 9000 },
    paths: { dataDir, configDir: join(process.cwd(), "config") },
    submission: { autoSubmit: true, confidenceThreshold: 0.85, localMaxWrong: 3, defaultCooldownMs: 1000 },
  },
});

console.log("runtime started, waiting for challenges...");
const deadline = Date.now() + 120000;
let lastStatus = "";
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 3000));
  const s = runtime.control.status();
  const line = `total=${s.total} solved=${s.solved} active=${s.active} queued=${s.queued} preparing=${s.preparing} unsupported=${s.unsupported}`;
  if (line !== lastStatus) {
    lastStatus = line;
    console.log(new Date().toISOString(), line);
  }
  if (Number(s.solved) >= 10) break;
}
const s = runtime.control.status();
console.log("FINAL:", JSON.stringify(s));
for (const c of runtime.repos.challenges.list().filter((c) => c.lifecycleStatus === "SOLVED")) {
  console.log("SOLVED:", c.id, c.title);
}
await runtime.close();
rmSync(dataDir, { recursive: true, force: true });
process.exit(0);
