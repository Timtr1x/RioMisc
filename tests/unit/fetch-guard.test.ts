import { describe, it, expect } from "vitest";
import { isPrivateIp, assertPublicUrl, fetchBounded } from "@rio/contest";

describe("fetch guard", () => {
  it("flags private IPs", () => {
    expect(isPrivateIp("127.0.0.1")).toBe(true);
    expect(isPrivateIp("10.0.0.1")).toBe(true);
    expect(isPrivateIp("192.168.1.1")).toBe(true);
    expect(isPrivateIp("172.16.0.1")).toBe(true);
    expect(isPrivateIp("8.8.8.8")).toBe(false);
  });

  it("rejects loopback and file URLs", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/secret")).rejects.toThrow(/内网/);
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
  });

  it("enforces max bytes", async () => {
    const fetchImpl = async () =>
      new Response("x".repeat(100), { status: 200, headers: { "content-type": "text/plain" } });
    await expect(fetchBounded("https://example.com/a", { maxBytes: 10, fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(/过大/);
  });
});
