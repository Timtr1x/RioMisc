// Pi resume path: worker chooses resume vs create; resume message ≠ kickoff; persist SDK values.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSolverSession, type AgentRuntimeAdapter, type SolverSessionConfig, type SolverSessionHandle } from "@rio/agent-runtime";
import { isResumableSession, buildResumeMessage, resumeLooksLikeContinuation, kickoffLooksFresh } from "../../apps/server/src/control/session-resume.ts";
import { resolveAgentRuntime } from "../../apps/server/src/control/runtime-choice.ts";
import { createRepositories } from "@rio/database";
import { buildKickoffMessage } from "@rio/solver";

describe("Pi session resume", () => {
  it("isResumableSession requires INTERRUPTED + existing file", () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-resume-"));
    const file = join(dir, "pi-sess.jsonl");
    writeFileSync(file, "{}\n");
    expect(isResumableSession({ status: "INTERRUPTED", piSessionId: "p1", piSessionFile: file })).toBe(true);
    expect(isResumableSession({ status: "INTERRUPTED", piSessionId: "p1", piSessionFile: join(dir, "missing.jsonl") })).toBe(false);
    expect(isResumableSession({ status: "ENDED", piSessionId: "p1", piSessionFile: file })).toBe(false);
    const mockFile = join(dir, "mock-sess_x.json");
    writeFileSync(mockFile, "{}");
    expect(isResumableSession({ status: "INTERRUPTED", piSessionId: "mock_sess_x", piSessionFile: mockFile })).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("resume message is RECOVERY CONTINUATION, not a fresh kickoff", () => {
    const resume = buildResumeMessage({ newHints: ["look at LSB"], wrongFlags: ["flag{nope}"] });
    const kickoff = buildKickoffMessage({ challengeText: "# CHALLENGE: x", inputFiles: [{ name: "a.zip", sizeBytes: 1 }] });
    expect(resumeLooksLikeContinuation(resume)).toBe(true);
    expect(kickoffLooksFresh(kickoff)).toBe(true);
    expect(kickoffLooksFresh(resume)).toBe(false);
    expect(resume).toContain("RECOVERY CONTINUATION");
    expect(resume).toContain("look at LSB");
    expect(resume).not.toContain("You are already inside this challenge's workspace");
  });

  it("openSolverSession calls resume when a persisted session file exists", async () => {
    const calls: string[] = [];
    const handle: SolverSessionHandle = {
      sessionId: "ours",
      waitForIdle: async () => {},
      usage: () => ({ inputTokens: 0, outputTokens: 0, toolCalls: 0 }),
      persistence: () => ({ externalSessionId: "sdk-id-99", sessionFile: "/data/sessions/sdk-real.jsonl" }),
    };
    const adapter: AgentRuntimeAdapter = {
      kind: "fake",
      createSolverSession: async () => {
        calls.push("create");
        return handle;
      },
      resumeSolverSession: async (cfg) => {
        calls.push("resume");
        expect(cfg.persistedSession?.piSessionFile).toBe("/data/sessions/sdk-real.jsonl");
        return handle;
      },
      inject: async () => {},
      switchModel: async () => {},
      abort: async () => {},
      compact: async () => {},
    };
    const cfg = { persistedSession: { piSessionId: "sdk-id-99", piSessionFile: "/data/sessions/sdk-real.jsonl" } } as SolverSessionConfig;
    const h = await openSolverSession(adapter, cfg, true);
    expect(calls).toEqual(["resume"]);
    expect(h.persistence().externalSessionId).toBe("sdk-id-99");
    expect(h.persistence().sessionFile).toBe("/data/sessions/sdk-real.jsonl");
    await openSolverSession(adapter, cfg, false);
    expect(calls).toEqual(["resume", "create"]);
  });

  it("resolveAgentRuntime is pi once a provider and model exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "rio-rt-"));
    const repos = createRepositories(join(dir, "t.sqlite"));
    expect(resolveAgentRuntime(repos)).toBe("mock");
    const p = repos.providers.create({
      displayName: "opencode",
      protocol: "OPENAI_CHAT_COMPLETIONS",
      baseUrl: "https://example.com",
      apiKeyRef: "provider.apiKey.x",
      enabled: true,
    });
    repos.models.create({
      providerId: p.id,
      modelName: "deepseek-v4-flash",
      contextWindow: 200000,
      maxOutputTokens: 8192,
      enabled: true,
      role: "GENERAL",
    });
    const prev = process.env.RIO_AGENT_RUNTIME;
    delete process.env.RIO_AGENT_RUNTIME;
    expect(resolveAgentRuntime(repos)).toBe("pi");
    if (prev === undefined) delete process.env.RIO_AGENT_RUNTIME;
    else process.env.RIO_AGENT_RUNTIME = prev;
    repos.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
