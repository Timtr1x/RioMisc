// Priority score, rate limiter, path guard, zip, fixtures, submission dedup (§110).
import { describe, it, expect } from "vitest";
import { computePriorityScore, scoreAndRankQueued } from "@rio/scheduler";
import { ApiRateLimiter, buildFixtures, lsbEmbed, makePcapHttp, makeZip } from "@rio/contest";
import { WorkspaceManager, extractZip, listZipEntries, pcapSummary, formatToolResultForModel, normalizeWorkPath, runTool, type ToolContext } from "@rio/tool-runtime";
import { inflateSync } from "node:zlib";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRepositories } from "@rio/database";
import { hashHex } from "@rio/shared";
import { looksLikeCtfFlag } from "../../apps/server/src/control/submission.ts";

describe("priority score", () => {
  const base = {
    challengeId: "c",
    category: "MISC" as const,
    manualPriority: 0,
    score: 100,
    solveCount: null,
    difficulty: 2,
    attempts: 0,
    progress: "UNKNOWN" as const,
    elapsedActiveMs: 0,
    hintStatus: "LOCKED" as const,
    requiredResources: { resourceClass: "NORMAL" as const, resourceTypes: ["LLM"] as const },
    discoveredAt: Date.now() - 5 * 60_000,
  };

  it("unattempted bonus applies once", () => {
    const s0 = computePriorityScore({ ...base, attempts: 0 });
    const s1 = computePriorityScore({ ...base, attempts: 1 });
    // +50 unattempted on s0, and s1 additionally pays the restart penalty (-5)
    expect(s0 - s1).toBe(55);
  });

  it("easy difficulty boosts score", () => {
    const easy = computePriorityScore({ ...base, difficulty: 1 });
    const hard = computePriorityScore({ ...base, difficulty: 5 });
    expect(easy - hard).toBe(40);
  });

  it("manual priority is additive", () => {
    const normal = computePriorityScore(base);
    const critical = computePriorityScore({ ...base, manualPriority: 100 });
    expect(critical - normal).toBe(100);
  });

  it("manual priority is applied once and ranking uses the fresh score", () => {
    const items = [
      { id: "low", priority: 0, lastPriorityScore: 999 },
      { id: "high", priority: 100, lastPriorityScore: 0 },
    ];
    const ranked = scoreAndRankQueued(items, (c) => computePriorityScore({ ...base, challengeId: c.id, manualPriority: c.priority }));
    expect(ranked[0]!.item.id).toBe("high");
    const high = ranked.find((r) => r.item.id === "high")!.score;
    const low = ranked.find((r) => r.item.id === "low")!.score;
    expect(high - low).toBe(100);
  });

  it("restarts are penalized", () => {
    const s0 = computePriorityScore(base);
    const s3 = computePriorityScore({ ...base, attempts: 3 });
    expect(s0 - s3).toBe(50 + 3 * 5); // unattempted bonus + restart penalties
  });
});

describe("rate limiter", () => {
  it("allows bursts then throttles", async () => {
    const rl = new ApiRateLimiter({ SUBMIT: { capacity: 2, perSecond: 2 } });
    const t0 = Date.now();
    await rl.acquire("SUBMIT");
    await rl.acquire("SUBMIT");
    const wait = await rl.acquire("SUBMIT");
    expect(wait).toBeGreaterThan(400);
  });

  it("refills over time so waiters never starve", async () => {
    const rl = new ApiRateLimiter({ SUBMIT: { capacity: 1, perSecond: 2 } });
    const t0 = Date.now();
    await rl.acquire("SUBMIT"); // exhaust
    await rl.acquire("SUBMIT"); // waits ~0.5s
    await rl.acquire("SUBMIT"); // waits ~0.5s again
    expect(Date.now()).toBeGreaterThan(t0 + 800);
  });

  it("submissions never wait behind downloads", async () => {
    const rl = new ApiRateLimiter({ DOWNLOAD: { capacity: 1, perSecond: 0.001 } });
    await rl.acquire("DOWNLOAD"); // exhaust download bucket
    const t = Date.now();
    const submitDelay = await rl.acquire("SUBMIT");
    expect(submitDelay).toBeLessThan(500);
  });
});

describe("path guard", () => {
  it("rejects escapes outside the workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "rio-guard-"));
    const wm = new WorkspaceManager(root);
    const wsRoot = join(root, "ws");
    mkdirSync(wsRoot);
    for (const bad of ["../secret", "..\\..\\windows", "C:\\Windows\\system32", "\\\\server\\share", "/etc/passwd"]) {
      expect(() => wm.safeResolve(wsRoot, bad)).toThrow();
    }
    expect(wm.safeResolve(wsRoot, "input/flag.txt")).toBe(join(wsRoot, "input", "flag.txt"));
    rmSync(root, { recursive: true, force: true });
  });
});

describe("tool result for the model", () => {
  it("includes data so the LLM sees file contents, not just 'file read'", () => {
    const text = formatToolResultForModel({
      ok: true,
      summary: "file read",
      data: { path: "challenge.txt", text: "flag is in the zip" },
      durationMs: 1,
    });
    expect(text).toContain("flag is in the zip");
    expect(text).toContain("challenge.txt");
  });

  it("normalizes bare write paths into work/", () => {
    expect(normalizeWorkPath("solve.py")).toBe("work/solve.py");
    expect(normalizeWorkPath("work/solve.py")).toBe("work/solve.py");
    expect(normalizeWorkPath("artifacts/out.bin")).toBe("artifacts/out.bin");
  });

  it("list_workspace names files and run_python sees input/ from workspace root", async () => {
    const root = mkdtempSync(join(tmpdir(), "rio-tools-"));
    const wm = new WorkspaceManager(root);
    const layout = wm.ensure("chal");
    writeFileSync(join(layout.input, "real.zip"), "PK");
    writeFileSync(join(layout.root, "challenge.txt"), "extract the zip");
    let resultIndex = 0;
    const ctx: ToolContext = {
      challengeId: "chal",
      workspace: layout,
      sessionId: "s",
      safeResolve: (p) => wm.safeResolve(layout.root, p),
      emit: () => {},
      recordArtifact: () => null,
      nextResultFile: () => join(layout.results, `tool-${++resultIndex}.txt`),
      pythonExecutable: process.env.RIO_PYTHON ?? "python",
      allowNetwork: false,
    };
    const listing = await runTool(ctx, "list_workspace", { path: "." });
    expect(listing.ok).toBe(true);
    expect(listing.summary).toMatch(/input\//);
    expect(listing.summary).toMatch(/challenge\.txt/);
    const modelText = formatToolResultForModel(listing);
    expect(modelText).toContain("real.zip");

    const py = await runTool(ctx, "run_python", { code: "import os; print(sorted(os.listdir('input')))" });
    expect(py.ok).toBe(true);
    const stdout = String((py.data as { stdout?: string })?.stdout ?? "");
    expect(stdout).toContain("real.zip");

    const wrote = await runTool(ctx, "write_work_file", { path: "note.txt", content: "hi" });
    expect(wrote.ok).toBe(true);
    expect(readFileSync(join(layout.work, "note.txt"), "utf8")).toBe("hi");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("zip roundtrip", () => {
  it("makeZip → listZipEntries → extractZip roundtrip", () => {
    const zip = makeZip([{ name: "a.txt", data: Buffer.from("hello flag{x}") }]);
    const entries = listZipEntries(zip);
    expect(entries.length).toBe(1);
    const dest = mkdtempSync(join(tmpdir(), "rio-zip2-"));
    const out = extractZip(zip, dest);
    expect(out[0]!.path).toBe("a.txt");
    expect(readFileSync(join(dest, "a.txt"), "utf8")).toBe("hello flag{x}");
    rmSync(dest, { recursive: true, force: true });
  });

  it("rejects path traversal entries", () => {
    const zip = makeZip([{ name: "../../evil.txt", data: Buffer.from("x") }]);
    const dest = mkdtempSync(join(tmpdir(), "rio-zip3-"));
    expect(() => extractZip(zip, dest)).toThrow();
    rmSync(dest, { recursive: true, force: true });
  });
});

describe("fixtures validity", () => {
  it("all fixtures have flag-format flags", () => {
    for (const f of buildFixtures()) {
      expect(f.flag).toMatch(/^flag\{[^}]+\}$/);
    }
  });

  it("png fixture inflates and embeds the flag in LSBs", () => {
    const flag = "flag{lsb_test}";
    const png = lsbEmbed(flag, 32, 32);
    const idatStart = png.indexOf(Buffer.from("IDAT")) - 4;
    const ln = png.readUInt32BE(idatStart);
    const raw = inflateSync(png.slice(idatStart + 8, idatStart + 8 + ln));
    const width = 32;
    const stride = width * 3 + 1;
    expect(raw.length).toBe(32 * stride);
    let bits = "";
    for (let y = 0; y < 32; y++) {
      for (const b of raw.slice(y * stride + 1, (y + 1) * stride)) bits += b & 1;
    }
    const chars: number[] = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
      const v = parseInt(bits.slice(i, i + 8), 2);
      if (v === 0) break;
      chars.push(v);
    }
    expect(Buffer.from(chars).toString("utf8")).toBe(flag);
  });

  it("pcap fixture parses with our summary", () => {
    const pcap = makePcapHttp("flag{pcap_ok}");
    const s = pcapSummary(pcap);
    expect(s.packetCount).toBe(2);
    expect(s.hasHttp).toBe(true);
    expect(s.sampleText).toContain("flag{pcap_ok}");
  });
});

describe("flag format", () => {
  it("accepts common CTF prefixes, not only flag{}", () => {
    expect(looksLikeCtfFlag("flag{hello}")).toBe(true);
    expect(looksLikeCtfFlag("FLAG{HELLO}")).toBe(true);
    expect(looksLikeCtfFlag("cumtctf{1sb_i4_s0_Ea4y}")).toBe(true);
    expect(looksLikeCtfFlag("DASCTF{abc}")).toBe(true);
    expect(looksLikeCtfFlag("not a flag")).toBe(false);
    expect(looksLikeCtfFlag("flag{}")).toBe(false);
    expect(looksLikeCtfFlag("flag{has\nnewline}")).toBe(false);
  });
});

describe("submission dedup", () => {
  it("createOrGet never duplicates (challengeId, flagHash)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-sub-"));
    const repos = createRepositories(join(dir, "t.sqlite"));
    const repo = repos.submissions;
    const a = repo.createOrGet({ challengeId: "c1", candidateId: null, flagHash: hashHex("flag{a}"), flagValue: "flag{a}", status: "QUEUED" });
    const b = repo.createOrGet({ challengeId: "c1", candidateId: null, flagHash: hashHex("flag{a}"), flagValue: "flag{a}", status: "QUEUED" });
    expect(a.id).toBe(b.id);
    expect(repo.listByChallenge("c1").length).toBe(1);
    repos.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("workspace layout", () => {
  it("ensures standard dirs", () => {
    const root = mkdtempSync(join(tmpdir(), "rio-ws-"));
    const wm = new WorkspaceManager(root);
    const l = wm.ensure("ch_abc");
    for (const dir of [l.input, l.work, l.artifacts, l.results, l.state, l.agent, l.tmp]) {
      writeFileSync(join(dir, ".keep"), "");
    }
    expect(wm.exists("ch_abc")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});
