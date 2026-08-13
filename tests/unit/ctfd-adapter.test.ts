import { describe, it, expect } from "vitest";
import {
  normalizeContestBaseUrl,
  isMiscOrCryptoCategory,
  mapCtfdSubmitStatus,
  parseCtfdRemoteId,
  stripHtml,
  CtfdContestAdapter,
} from "@rio/contest";

describe("ctfd helpers", () => {
  it("normalizes contest base url", () => {
    expect(normalizeContestBaseUrl("https://ctf.example.com/challenges")).toBe("https://ctf.example.com");
    expect(normalizeContestBaseUrl("https://host.example/ctf/")).toBe("https://host.example/ctf");
  });

  it("keeps misc/crypto including Chinese names", () => {
    expect(isMiscOrCryptoCategory("Misc")).toBe(true);
    expect(isMiscOrCryptoCategory("密码学")).toBe(true);
    expect(isMiscOrCryptoCategory("杂项")).toBe(true);
    expect(isMiscOrCryptoCategory("Web")).toBe(false);
  });

  it("maps CTFd submit statuses", () => {
    expect(mapCtfdSubmitStatus("correct", {}).status).toBe("CORRECT");
    expect(mapCtfdSubmitStatus("already_solved", {}).correct).toBe(true);
    expect(mapCtfdSubmitStatus("incorrect", {}).status).toBe("WRONG");
    expect(mapCtfdSubmitStatus("ratelimited", {}).status).toBe("RATE_LIMITED");
  });

  it("parses remote ids and strips html", () => {
    expect(parseCtfdRemoteId("ctfd:ctf.example.com:9")).toBe(9);
    expect(stripHtml("<p>hello<br>world</p>")).toContain("hello");
  });
});

describe("CtfdContestAdapter", () => {
  it("lists only misc/crypto, downloads, and maps submit", async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.endsWith("/api/v1/challenges") || url.includes("/api/v1/challenges?page=")) {
        return json({
          success: true,
          data: [
            { id: 1, name: "stego", category: "Misc", value: 100, solves: 3, solved_by_me: false },
            { id: 2, name: "sqli", category: "Web", value: 200, solves: 8, solved_by_me: false },
          ],
        });
      }
      if (url.endsWith("/api/v1/challenges/1")) {
        return json({
          success: true,
          data: {
            id: 1,
            name: "stego",
            category: "Misc",
            value: 100,
            solves: 3,
            description: "<p>find the flag</p>",
            files: ["/files/a/pic.jpg?token=x"],
          },
        });
      }
      if (url.includes("/api/v1/challenges/attempt") && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { submission?: string };
        return json({ success: true, data: { status: body.submission === "flag{ok}" ? "correct" : "incorrect" } });
      }
      if (url.includes("/files/")) {
        return new Response(Buffer.from("jpeg-bytes"), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    };

    const adapter = new CtfdContestAdapter({
      baseUrl: "https://ctf.example.com",
      token: "tok",
      fetchImpl,
    });
    await adapter.authenticate();
    const list = await adapter.listChallenges();
    expect(list.map((c) => c.title)).toEqual(["stego"]);
    expect(list[0]!.remoteId).toBe("ctfd:ctf.example.com:1");

    const detail = await adapter.getChallenge(list[0]!.remoteId);
    expect(detail.description).toContain("find the flag");
    expect(detail.attachments[0]!.name).toBe("pic.jpg");

    const dl = await adapter.downloadAttachment(detail, detail.attachments[0]!, undefined);
    expect(dl.ok).toBe(true);
    expect(dl.bytes).toBe(10);

    const ok = await adapter.submitFlag(list[0]!.remoteId, "flag{ok}");
    expect(ok.status).toBe("CORRECT");
    const bad = await adapter.submitFlag(list[0]!.remoteId, "flag{no}");
    expect(bad.status).toBe("WRONG");
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
