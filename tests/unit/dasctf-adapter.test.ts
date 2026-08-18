import { describe, it, expect } from "vitest";
import {
  normalizeDasctfBaseUrl,
  normalizeDasctfFlagPayload,
  resolveDasctfAssetUrl,
  parseDasctfDownloadBusinessError,
  parseDasctfRemoteId,
  parseDasctfRemainingAttempts,
  assertDasctfOk,
  mapDasctfSubmit,
  isDasctfRateLimitMessage,
  isDasctfWrongFlagMessage,
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

  it("strips DASCTF{}/flag{} wrappers for API payload", () => {
    expect(normalizeDasctfFlagPayload("DASCTF{ni_cai?}")).toBe("ni_cai?");
    expect(normalizeDasctfFlagPayload("flag{abc}")).toBe("abc");
    expect(normalizeDasctfFlagPayload("plain")).toBe("plain");
    expect(normalizeDasctfFlagPayload("DASCTF{C7-TD-HB}")).toBe("C7-TD-HB");
  });

  it("resolves relative /adl-oss attachment URLs against contest origin", () => {
    const agentBase = "https://pro.dasctf.com/slab-match/api/v1/agent";
    expect(
      resolveDasctfAssetUrl(
        "/adl-oss/resources/abc?e=1&token=x",
        agentBase,
      ),
    ).toBe("https://pro.dasctf.com/adl-oss/resources/abc?e=1&token=x");
    expect(
      resolveDasctfAssetUrl("https://pro-resource.dasctf.com/resource/oss/x.zip", agentBase),
    ).toBe("https://pro-resource.dasctf.com/resource/oss/x.zip");
  });

  it("parses adl-oss HTTP 200 JSON business errors", () => {
    expect(
      parseDasctfDownloadBusinessError('{"code":"40401","data":{},"message":"未能读取到有效Token"}'),
    ).toBe("未能读取到有效Token");
    expect(parseDasctfDownloadBusinessError("PK\x03\x04...")).toBeNull();
    expect(parseDasctfDownloadBusinessError('{"code":"00000","data":{}}')).toBeNull();
  });

  it("maps Agent API submit responses per docs + live 40001 messages", () => {
    expect(parseDasctfRemoteId("dasctf:pro.dasctf.com:1001")).toBe(1001);

    // Correct: code 00000 + isCorrect true
    const ok = mapDasctfSubmit({ code: "00000", message: "", data: { isCorrect: true } });
    expect(ok.status).toBe("CORRECT");
    expect(ok.correct).toBe(true);

    // Wrong: live message (same code 40001 as rate-limit)
    const wrongMsg = "提交flag错误，请重新提交（当前还有48次提交机会）";
    expect(isDasctfWrongFlagMessage(wrongMsg)).toBe(true);
    expect(isDasctfRateLimitMessage(wrongMsg)).toBe(false);
    expect(parseDasctfRemainingAttempts(wrongMsg)).toBe(48);
    const wrong = mapDasctfSubmit({ code: "40001", data: {}, message: wrongMsg });
    expect(wrong.status).toBe("WRONG");
    expect(wrong.correct).toBe(false);
    expect((wrong.raw as { remainingAttempts?: number }).remainingAttempts).toBe(48);

    // Rate limit: live message
    const rateMsg = "请求过于频繁，请稍后重试";
    expect(isDasctfRateLimitMessage(rateMsg)).toBe(true);
    expect(isDasctfWrongFlagMessage(rateMsg)).toBe(false);
    const rate = mapDasctfSubmit({ code: "40001", data: {}, message: rateMsg });
    expect(rate.status).toBe("RATE_LIMITED");
    expect(rate.cooldownMs).toBe(60_000);

    // 00000 but not correct
    expect(mapDasctfSubmit({ code: "00000", data: { isCorrect: false }, message: "" }).status).toBe("WRONG");
    expect(mapDasctfSubmit({ code: "A0001", message: "答案错误" }).status).toBe("WRONG");
    expect(() => assertDasctfOk({ code: "A0001", message: "nope" }, "/x")).toThrow(/nope/);
  });

  it("submitFlag maps live wrong-flag 40001 to WRONG instead of throwing", async () => {
    let postedFlag: string | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/match/notice/match-info")) return json({ code: "00000", data: {} });
      if (url.endsWith("/answer-panel/answer") && (init?.method ?? "GET").toUpperCase() === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { flag?: string };
        postedFlag = body.flag;
        return json({ code: "40001", data: {}, message: "提交flag错误，请重新提交（当前还有49次提交机会）" });
      }
      return new Response("nope", { status: 404 });
    };
    const adapter = new DasctfAgentContestAdapter({
      baseUrl: "https://pro.dasctf.com",
      accessKey: "ak",
      fetchImpl,
    });
    const r = await adapter.submitFlag("dasctf:pro.dasctf.com:10663", "DASCTF{ni_cai?}");
    expect(r.status).toBe("WRONG");
    expect(r.correct).toBe(false);
    expect(postedFlag).toBe("ni_cai?");
  });

  it("downloadAttachment resolves relative /adl-oss against contest origin", async () => {
    const hits: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      hits.push(url);
      if (url.endsWith("/match/notice/match-info")) return json({ code: "00000", data: {} });
      if (url.startsWith("https://pro.dasctf.com/adl-oss/")) {
        return new Response(Buffer.from("zip-bytes"), {
          status: 200,
          headers: { "content-type": "application/zip" },
        });
      }
      return new Response("nope", { status: 404 });
    };
    const adapter = new DasctfAgentContestAdapter({
      baseUrl: "https://pro.dasctf.com",
      accessKey: "ak",
      fetchImpl,
    });
    await adapter.authenticate();
    const dl = await adapter.downloadAttachment(
      {
        remoteId: "dasctf:pro.dasctf.com:10679",
        title: "0_1_Game",
        description: "",
        category: "CRYPTO",
        score: 200,
        solveCount: null,
        createdAt: null,
        updatedAt: Date.now(),
        attachments: [],
      },
      {
        remoteId: null,
        name: "game.zip",
        url: "/adl-oss/resources/abc?e=1&token=x",
      },
    );
    expect(dl.ok).toBe(true);
    expect(dl.bytes).toBe(9);
    expect(hits.some((u) => u.startsWith("https://pro.dasctf.com/adl-oss/resources/abc"))).toBe(true);
    expect(hits.some((u) => u.includes("/slab-match/api/v1/agent/adl-oss"))).toBe(false);
  });

  it("downloadAttachment fails on adl-oss Token JSON instead of saving it as a file", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/match/notice/match-info")) return json({ code: "00000", data: {} });
      if (url.startsWith("https://pro.dasctf.com/adl-oss/")) {
        return new Response(JSON.stringify({ code: "40401", data: {}, message: "未能读取到有效Token" }), {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      return new Response("nope", { status: 404 });
    };
    const adapter = new DasctfAgentContestAdapter({
      baseUrl: "https://pro.dasctf.com",
      accessKey: "ak",
      fetchImpl,
    });
    await adapter.authenticate();
    const dl = await adapter.downloadAttachment(
      {
        remoteId: "dasctf:pro.dasctf.com:10679",
        title: "0_1_Game",
        description: "",
        category: "CRYPTO",
        score: 200,
        solveCount: null,
        createdAt: null,
        updatedAt: Date.now(),
        attachments: [],
      },
      {
        remoteId: null,
        name: "game.zip",
        url: "/adl-oss/resources/abc?e=1&token=x",
      },
    );
    expect(dl.ok).toBe(false);
    expect(dl.message).toMatch(/未能读取到有效Token/);
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
        // Adapter strips DASCTF{}/flag{} before POST — platform sees inner payload only.
        const body = JSON.parse(String(init?.body ?? "{}")) as { flag?: string };
        return json({ code: "00000", data: { isCorrect: body.flag === "ok" } });
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
