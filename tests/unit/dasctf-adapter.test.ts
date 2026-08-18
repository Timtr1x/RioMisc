import { describe, it, expect } from "vitest";
import {
  normalizeDasctfBaseUrl,
  parseDasctfRemoteId,
  assertDasctfOk,
  mapDasctfSubmit,
  formatDasctfEndpoints,
  parseDasctfAttachments,
  DasctfAgentContestAdapter,
} from "@rio/contest";

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("dasctf helpers", () => {
  it("normalizes host and full agent path", () => {
    expect(normalizeDasctfBaseUrl("https://pro.dasctf.com")).toBe(
      "https://pro.dasctf.com/slab-match/api/v1/agent",
    );
    expect(normalizeDasctfBaseUrl("https://pro.dasctf.com/slab-match/api/v1/agent/")).toBe(
      "https://pro.dasctf.com/slab-match/api/v1/agent",
    );
    expect(normalizeDasctfBaseUrl("https://pro.dasctf.com/slab-match/api/v1/agent/ctf/exercise-list")).toBe(
      "https://pro.dasctf.com/slab-match/api/v1/agent",
    );
  });

  it("parses remote ids and maps submit", () => {
    expect(parseDasctfRemoteId("dasctf:pro.dasctf.com:1001")).toBe(1001);
    expect(mapDasctfSubmit({ code: "00000", data: { isCorrect: true } }).status).toBe("CORRECT");
    expect(mapDasctfSubmit({ code: "00000", data: { isCorrect: false }, message: "wrong" }).status).toBe("WRONG");
    expect(mapDasctfSubmit({ code: "A0001", message: "答案错误" }).status).toBe("WRONG");
    expect(() => assertDasctfOk({ code: "A0001", message: "nope" }, "/x")).toThrow(/nope/);
  });

  it("formats endpoints for the challenge brief", () => {
    const text = formatDasctfEndpoints([
      {
        exposeIps: ["10.0.0.1"],
        ports: ["80"],
        users: [{ username: "root", password: "x" }],
        isProxy: false,
      },
    ]);
    expect(text).toContain("10.0.0.1");
    expect(text).toContain("root");
  });

  it("parses both docs-style files[] and live single attachment object", () => {
    const multi = parseDasctfAttachments({ files: [{ name: "a.png", url: "https://cdn/a.png", ext: "png" }] }, 1);
    expect(multi).toHaveLength(1);
    expect(multi[0]!.name).toBe("a.png");
    const single = parseDasctfAttachments({
      key: "k",
      signature: "s",
      url: "https://pro-resource.dasctf.com/resource/oss/x.zip",
      name: "解压缩的附件.zip",
      previewUrl: "https://pro-resource.dasctf.com/resource/oss/x.zip",
      extension: "zip",
    }, 10663);
    expect(single).toHaveLength(1);
    expect(single[0]!.name).toBe("解压缩的附件.zip");
    expect(single[0]!.url).toContain("pro-resource.dasctf.com");
  });
});

describe("DasctfAgentContestAdapter", () => {
  it("authenticates, lists misc/crypto only, details, starts env, submits, downloads", async () => {
    const hits: string[] = [];
    const headersSeen: string[] = [];
    let needCheck = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      hits.push(url);
      const h = new Headers(init?.headers);
      if (h.get("X-Agent-AccessKey")) headersSeen.push(h.get("X-Agent-AccessKey")!);
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.endsWith("/match/notice/match-info")) {
        return json({ code: "00000", data: { note: "n", rule: "r" } });
      }
      if (url.endsWith("/ctf/exercise-list")) {
        return json({
          code: "00000",
          data: [
            {
              id: 1,
              name: "Misc",
              corpus: [
                { id: 1001, name: "stego", isOpen: true, hasSolved: false },
                { id: 1002, name: "done", isOpen: true, hasSolved: true },
              ],
            },
            {
              id: 2,
              name: "Web",
              corpus: [{ id: 2001, name: "sqli", isOpen: true, hasSolved: false }],
            },
            {
              id: 3,
              name: "Crypto",
              corpus: [{ id: 3001, name: "rsa", isOpen: true, hasSolved: false }],
            },
          ],
        });
      }
      if (url.includes("/ctf/exercise?exerciseId=1001")) {
        return json({
          code: "00000",
          data: {
            id: 1001,
            name: "stego",
            description: "<p>find me</p>",
            score: "100",
            isNeedInit: true,
            isNeedCheck: needCheck,
            endpoints: needCheck
              ? []
              : [{ exposeIps: ["1.2.3.4"], ports: ["80"], users: [], isProxy: false }],
            attachment: {
              url: "https://cdn.example.com/a.png",
              name: "a.png",
              extension: "png",
            },
          },
        });
      }
      if (url.endsWith("/ctf/build-exercise-env") && method === "POST") {
        needCheck = false;
        return json({ code: "00000", data: {} });
      }
      if (url.endsWith("/answer-panel/answer") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { flag?: string };
        return json({ code: "00000", data: { isCorrect: body.flag === "flag{ok}" } });
      }
      if (url.includes("cdn.example.com")) {
        return new Response(Buffer.from("png-bytes"), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    };

    const adapter = new DasctfAgentContestAdapter({
      baseUrl: "https://pro.dasctf.com",
      accessKey: "ak_live_test",
      fetchImpl,
      trustedCredentialOrigins: ["https://cdn.example.com"],
      envPollMs: 1,
      envPollMax: 5,
    });

    await adapter.authenticate();
    const list = await adapter.listChallenges();
    expect(list.map((c) => c.title).sort()).toEqual(["rsa", "stego"]);
    expect(list.every((c) => c.remoteId.startsWith("dasctf:"))).toBe(true);

    const detail = await adapter.getChallenge(list.find((c) => c.title === "stego")!.remoteId);
    expect(detail.description).toContain("find me");
    expect(detail.attachments[0]?.name).toBe("a.png");
    expect(detail.score).toBe(100);

    const start = await adapter.startChallenge(detail.remoteId);
    expect(start.ok).toBe(true);
    expect(hits.some((u) => u.endsWith("/ctf/build-exercise-env"))).toBe(true);

    const ok = await adapter.submitFlag(detail.remoteId, "flag{ok}");
    expect(ok.status).toBe("CORRECT");
    const bad = await adapter.submitFlag(detail.remoteId, "nope");
    expect(bad.status).toBe("WRONG");

    const dl = await adapter.downloadAttachment(detail, detail.attachments[0]!, undefined);
    expect(dl.ok).toBe(true);
    expect(dl.bytes).toBe(9);
    expect(headersSeen.every((h) => h === "ak_live_test")).toBe(true);
  });

  it("refuses empty access key", () => {
    expect(() => new DasctfAgentContestAdapter({ baseUrl: "https://pro.dasctf.com", accessKey: "  " })).toThrow(/AccessKey/);
  });

  it("retries HTTP 429 then succeeds", async () => {
    let n = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/match/notice/match-info")) {
        n += 1;
        if (n < 3) {
          return new Response(JSON.stringify({ code: "40001", message: "请求过于频繁，请稍后重试" }), { status: 429 });
        }
        return json({ code: "00000", data: { note: "ok", rule: "ok" } });
      }
      return new Response("nope", { status: 404 });
    };
    const adapter = new DasctfAgentContestAdapter({
      baseUrl: "https://pro.dasctf.com",
      accessKey: "ak",
      fetchImpl,
      rateLimitBackoffMs: 1,
    });
    await adapter.authenticate();
    expect(n).toBe(3);
  });
});
