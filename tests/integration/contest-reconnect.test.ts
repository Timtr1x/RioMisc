// Kill ControlPlane, start again: last CTFd profile authenticates and polls.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "@rio/shared";
import { startRuntime, type Runtime } from "../../apps/server/src/index.ts";

function listenFakeCtfd(): Promise<{
  server: Server;
  origin: string;
  hits: Array<{ url: string; auth: string | undefined }>;
}> {
  const hits: Array<{ url: string; auth: string | undefined }> = [];
  const server = createServer((req, res) => {
    const url = req.url ?? "";
    hits.push({ url, auth: req.headers.authorization });
    if (url.split("?")[0] === "/api/v1/challenges") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          success: true,
          data: [
            {
              id: 1,
              name: "stego",
              category: "Misc",
              value: 100,
              solves: 1,
              solved_by_me: false,
              description: "hidden",
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end();
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

describe("contest reconnect after ControlPlane restart", () => {
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

  it("restores CTFd profile, authenticates with stored token, and polls", async () => {
    const fake = await listenFakeCtfd();
    servers.push(fake.server);
    const dataDir = mkdtempSync(join(tmpdir(), "rio-reconnect-"));
    dirs.push(dataDir);

    const r1 = await startRuntime({ skipApi: true, configOverrides: noneOverrides(dataDir) as never });
    runtimes.push(r1);
    expect(r1.control.contestStatus().kind).toBe("idle");

    const connected = await r1.control.connectContest({
      kind: "ctfd",
      baseUrl: fake.origin,
      token: "tok-r1",
      miscCryptoOnly: true,
      trustedCredentialOrigins: ["https://files.ctf.example.com"],
    });
    expect(connected.kind).toBe("ctfd");
    expect(connected.lastListed).toBe(1);
    expect(connected.trustedCredentialOrigins).toEqual(["https://files.ctf.example.com"]);
    expect(fake.hits.some((h) => h.auth === "Token tok-r1")).toBe(true);
    await r1.close();
    runtimes.pop();

    const hitsAfterFirst = fake.hits.length;
    const t0 = Date.now();
    const r2 = await startRuntime({ skipApi: true, configOverrides: noneOverrides(dataDir) as never });
    runtimes.push(r2);

    const status = r2.control.contestStatus();
    expect(status.kind).toBe("ctfd");
    expect(status.connected).toBe(true);
    expect(status.baseUrl).toBe(fake.origin);
    expect(status.lastListed).toBe(1);
    expect(status.lastPollAt).toBeGreaterThanOrEqual(t0);
    expect(status.trustedCredentialOrigins).toEqual(["https://files.ctf.example.com"]);
    expect(fake.hits.length).toBeGreaterThan(hitsAfterFirst);
    expect(fake.hits.slice(hitsAfterFirst).some((h) => h.auth === "Token tok-r1")).toBe(true);
    expect(r2.repos.challenges.list().some((c) => c.title === "stego")).toBe(true);
  });

  it("stays idle after an explicit disconnect — no sneak reconnect", async () => {
    const fake = await listenFakeCtfd();
    servers.push(fake.server);
    const dataDir = mkdtempSync(join(tmpdir(), "rio-reconnect-idle-"));
    dirs.push(dataDir);

    const r1 = await startRuntime({ skipApi: true, configOverrides: noneOverrides(dataDir) as never });
    runtimes.push(r1);
    await r1.control.connectContest({ kind: "ctfd", baseUrl: fake.origin, token: "tok-x" });
    await r1.control.disconnectContest();
    await r1.close();
    runtimes.pop();

    const hits = fake.hits.length;
    const r2 = await startRuntime({ skipApi: true, configOverrides: noneOverrides(dataDir) as never });
    runtimes.push(r2);
    expect(r2.control.contestStatus().kind).toBe("idle");
    expect(r2.control.contestStatus().connected).toBe(false);
    expect(fake.hits.length).toBe(hits);
  });
});
