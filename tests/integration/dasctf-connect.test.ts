// End-to-end: connect DASCTF Agent adapter through ControlPlane against a fake platform.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "@rio/shared";
import { startRuntime, type Runtime } from "../../apps/server/src/index.ts";

function listenFakeDasctf(): Promise<{
  server: Server;
  origin: string;
  hits: Array<{ url: string; accessKey: string | undefined; method: string }>;
}> {
  const hits: Array<{ url: string; accessKey: string | undefined; method: string }> = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    const method = (req.method ?? "GET").toUpperCase();
    hits.push({ url, accessKey: req.headers["x-agent-accesskey"] as string | undefined, method });
    const path = url.split("?")[0] ?? "";

    const ok = (data: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ code: "00000", message: "", data }));
    };

    if (path === "/slab-match/api/v1/agent/match/notice/match-info") {
      ok({ note: "note", rule: "rule" });
      return;
    }
    if (path === "/slab-match/api/v1/agent/ctf/exercise-list") {
      ok([
        {
          id: 1,
          name: "Misc",
          corpus: [{ id: 42, name: "png-lsb", order: 1, isOpen: true, hasSolved: false }],
        },
        {
          id: 2,
          name: "Web",
          corpus: [{ id: 99, name: "sqli", order: 1, isOpen: true, hasSolved: false }],
        },
      ]);
      return;
    }
    if (path === "/slab-match/api/v1/agent/ctf/exercise") {
      ok({
        id: 42,
        name: "png-lsb",
        description: "look closer",
        score: "200",
        isNeedInit: false,
        isNeedCheck: false,
        endpoints: [],
        attachment: { files: [{ name: "task.png", url: "http://127.0.0.1/task.png", ext: "png" }] },
      });
      return;
    }
    if (path === "/slab-match/api/v1/agent/answer-panel/answer" && method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}") as { flag?: string };
        ok({ isCorrect: parsed.flag === "flag{ok}" });
      });
      return;
    }
    res.writeHead(404).end("nope");
  });
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return { server, origin: `http://127.0.0.1:${port}`, hits };
  });
}

function noneOverrides(dataDir: string) {
  const loaded = loadConfig();
  return {
    contest: { ...loaded.contest, adapter: "none" as const },
    paths: { ...loaded.paths, dataDir },
    workers: { solverConcurrency: 1, triageConcurrency: 1 },
    agent: { ...loaded.agent, allowMockFallback: true },
    watchdog: { checkMs: 30_000, heartbeatMs: 15_000, leaseTtlMs: 45_000 },
  };
}

describe("DASCTF Agent connect through ControlPlane", () => {
  const dirs: string[] = [];
  const servers: Server[] = [];
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    for (const r of runtimes.splice(0)) {
      try {
        await r.close();
      } catch {
        /* already closed */
      }
    }
    for (const s of servers.splice(0)) s.close();
    for (const d of dirs.splice(0)) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        /* windows lock */
      }
    }
  });

  it("connects with AccessKey, lists only misc, polls into DB, restores after restart", async () => {
    const fake = await listenFakeDasctf();
    servers.push(fake.server);
    const dataDir = mkdtempSync(join(tmpdir(), "rio-dasctf-"));
    dirs.push(dataDir);

    const r1 = await startRuntime({ skipApi: true, configOverrides: noneOverrides(dataDir) as never });
    runtimes.push(r1);

    const connected = await r1.control.connectContest({
      kind: "dasctf",
      baseUrl: fake.origin,
      token: "ak_live_test_key",
      miscCryptoOnly: true,
    });
    expect(connected.kind).toBe("dasctf");
    expect(connected.connected).toBe(true);
    expect(connected.lastListed).toBe(1);
    expect(fake.hits.some((h) => h.accessKey === "ak_live_test_key")).toBe(true);
    expect(fake.hits.some((h) => h.url.includes("/match/notice/match-info"))).toBe(true);
    expect(fake.hits.some((h) => h.url.includes("/ctf/exercise-list"))).toBe(true);

    const challenges = r1.repos.challenges.list();
    expect(challenges).toHaveLength(1);
    expect(challenges[0]!.title).toBe("png-lsb");
    expect(challenges[0]!.category.toLowerCase()).toContain("misc");

    await r1.close();
    runtimes.pop();

    const r2 = await startRuntime({ skipApi: true, configOverrides: noneOverrides(dataDir) as never });
    runtimes.push(r2);
    // Restored profile should re-authenticate with stored AccessKey.
    expect(r2.control.contestStatus().kind).toBe("dasctf");
    expect(r2.control.contestStatus().connected).toBe(true);
    expect(fake.hits.filter((h) => h.url.includes("/match/notice/match-info")).length).toBeGreaterThanOrEqual(2);
  });

  it("rejects connect without AccessKey", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "rio-dasctf-bad-"));
    dirs.push(dataDir);
    const r1 = await startRuntime({ skipApi: true, configOverrides: noneOverrides(dataDir) as never });
    runtimes.push(r1);
    await expect(
      r1.control.connectContest({ kind: "dasctf", baseUrl: "http://127.0.0.1:9", token: "" }),
    ).rejects.toThrow(/AccessKey/);
  });
});
