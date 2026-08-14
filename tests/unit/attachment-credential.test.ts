import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { shouldAttachContestCredential, CtfdContestAdapter } from "@rio/contest";

function listen(): Promise<{ server: Server; origin: string; seen: Array<{ url: string; auth: string | undefined; cookie: string | undefined }> }> {
  const seen: Array<{ url: string; auth: string | undefined; cookie: string | undefined }> = [];
  const server = createServer((req, res) => {
    seen.push({
      url: req.url ?? "",
      auth: req.headers.authorization,
      cookie: req.headers.cookie,
    });
    const loc = new URL(req.url ?? "/", "http://local").searchParams.get("next");
    if (loc) {
      res.writeHead(302, { Location: loc });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end("file-bytes");
  });
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    return { server, origin: `http://127.0.0.1:${port}`, seen };
  });
}

describe("contest credential boundary", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
  });

  it("same origin attaches, other origin does not, trusted origin does", () => {
    const base = "https://ctf.example.com/api";
    expect(shouldAttachContestCredential("https://ctf.example.com/files/a.bin", base)).toBe(true);
    expect(shouldAttachContestCredential("/files/a.bin", base)).toBe(true);
    expect(shouldAttachContestCredential("https://cdn.other.net/a.bin", base)).toBe(false);
    expect(shouldAttachContestCredential("https://cdn.other.net/a.bin", base, ["https://cdn.other.net"])).toBe(true);
  });

  it("A (contest) keeps Token/Cookie; B (CDN) does not, including after redirect", async () => {
    const a = await listen();
    const b = await listen();
    servers.push(a.server, b.server);

    const adapter = new CtfdContestAdapter({
      baseUrl: a.origin,
      token: "secret-token",
      cookie: "session=abc",
    });

    const same = await adapter.downloadAttachment(
      { remoteId: "ctfd:x:1", title: "t", description: "", category: "Misc", score: 1, solveCount: 0, createdAt: 0, updatedAt: 0, attachments: [] },
      { remoteId: "1", name: "a.bin", url: `${a.origin}/files/a.bin`, sizeBytes: 10 },
    );
    expect(same.ok).toBe(true);
    expect(a.seen.some((h) => h.auth === "Token secret-token" && h.cookie === "session=abc")).toBe(true);

    const cross = await adapter.downloadAttachment(
      { remoteId: "ctfd:x:1", title: "t", description: "", category: "Misc", score: 1, solveCount: 0, createdAt: 0, updatedAt: 0, attachments: [] },
      { remoteId: "2", name: "b.bin", url: `${b.origin}/files/b.bin`, sizeBytes: 10 },
    );
    expect(cross.ok).toBe(true);
    expect(b.seen.every((h) => h.auth === undefined && h.cookie === undefined)).toBe(true);

    a.seen.length = 0;
    b.seen.length = 0;
    const bounced = await adapter.downloadAttachment(
      { remoteId: "ctfd:x:1", title: "t", description: "", category: "Misc", score: 1, solveCount: 0, createdAt: 0, updatedAt: 0, attachments: [] },
      { remoteId: "3", name: "c.bin", url: `${a.origin}/redir?next=${encodeURIComponent(`${b.origin}/files/c.bin`)}`, sizeBytes: 10 },
    );
    expect(bounced.ok).toBe(true);
    expect(a.seen[0]?.auth).toBe("Token secret-token");
    expect(b.seen[0]?.auth).toBeUndefined();
    expect(b.seen[0]?.cookie).toBeUndefined();
  });

  it("stops after 5 redirects", async () => {
    const hops: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      hops.push(String(input));
      return new Response(null, { status: 302, headers: { location: `https://ctf.example.com/h${hops.length}` } });
    };
    const adapter = new CtfdContestAdapter({ baseUrl: "https://ctf.example.com", token: "t", fetchImpl });
    await expect(
      adapter.downloadAttachment(
        { remoteId: "ctfd:x:1", title: "t", description: "", category: "Misc", score: 1, solveCount: 0, createdAt: 0, updatedAt: 0, attachments: [] },
        { remoteId: "1", name: "a.bin", url: "https://ctf.example.com/start", sizeBytes: null },
      ),
    ).rejects.toThrow(/too many redirects/);
    expect(hops.length).toBe(6);
  });
});
