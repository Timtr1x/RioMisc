// Pi Resume E2E (guide §18): drive the shipped PiAgentRuntimeAdapter against a
// fake OpenAI-compatible server. Phase 1 writes a real session file with
// tool-call history; phase 2 resume must replay that history on the next request.
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiAgentRuntimeAdapter, type PiProviderSpec, type SolverSessionHandle } from "@rio/agent-runtime";
import { WorkspaceManager, type ToolContext } from "@rio/tool-runtime";
import { systemPromptFor } from "@rio/solver";
import { buildResumeMessage } from "../../apps/server/src/control/session-resume.ts";

const SCRATCH = process.env.GROK_SCRATCH ?? "C:\\Users\\tim\\AppData\\Local\\Temp\\grok-goal-ae1fe9f8a299\\implementer";

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
  name?: string;
}

interface ChatReq {
  messages?: ChatMessage[];
  tools?: unknown;
  stream?: boolean;
}

function writeScratch(name: string, text: string): void {
  mkdirSync(SCRATCH, { recursive: true });
  writeFileSync(join(SCRATCH, name), text, "utf8");
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function toolCallSse(id: string, name: string, args: unknown): string {
  return (
    sse({ choices: [{ delta: { role: "assistant", content: "" }, index: 0 }] }) +
    sse({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          index: 0,
        },
      ],
    }) +
    sse({ choices: [{ delta: {}, index: 0, finish_reason: "tool_calls" }] }) +
    "data: [DONE]\n\n"
  );
}

function textSse(text: string): string {
  return (
    sse({ choices: [{ delta: { role: "assistant", content: text }, index: 0 }] }) +
    sse({ choices: [{ delta: {}, index: 0, finish_reason: "stop" }] }) +
    "data: [DONE]\n\n"
  );
}

function toolResultCount(messages: ChatMessage[]): number {
  return messages.filter((m) => m.role === "tool" || m.role === "function").length;
}

function hasAssistantToolCall(messages: ChatMessage[]): boolean {
  return messages.some((m) => {
    if (m.role !== "assistant") return false;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) return true;
    if (Array.isArray(m.content)) {
      return (m.content as { type?: string }[]).some((p) => p.type === "tool_use" || p.type === "function_call");
    }
    return false;
  });
}

function hasToolResult(messages: ChatMessage[]): boolean {
  if (toolResultCount(messages) > 0) return true;
  return messages.some((m) => {
    if (Array.isArray(m.content)) {
      return (m.content as { type?: string }[]).some((p) => p.type === "tool_result" || p.type === "function_call_output");
    }
    return false;
  });
}

function hasUser(messages: ChatMessage[]): boolean {
  return messages.some((m) => m.role === "user");
}

function kickoffOnly(messages: ChatMessage[]): boolean {
  const nonSystem = messages.filter((m) => m.role !== "system");
  return nonSystem.length > 0 && nonSystem.every((m) => m.role === "user") && !hasAssistantToolCall(messages) && !hasToolResult(messages);
}

async function disposeHandle(handle: SolverSessionHandle | null): Promise<void> {
  if (!handle) return;
  const raw = handle as unknown as { piSession?: { abort?: () => Promise<void>; dispose?: () => void } };
  try {
    await handle.abort();
  } catch {
    /* ignore */
  }
  try {
    raw.piSession?.dispose?.();
  } catch {
    /* ignore */
  }
}

describe("pi-resume e2e", () => {
  let server: Server | null = null;
  let dataDir: string | null = null;
  let phase1: SolverSessionHandle | null = null;
  let phase2: SolverSessionHandle | null = null;

  afterEach(async () => {
    await disposeHandle(phase2);
    await disposeHandle(phase1);
    phase1 = null;
    phase2 = null;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* windows lock */
      }
      dataDir = null;
    }
  });

  it("resumed next request contains first-session user / assistant-tool-call / tool-result history", async () => {
    try {
      await import("@earendil-works/pi-coding-agent");
    } catch (e) {
      writeScratch("pi-resume.log", `Pi SDK failed to load:\n${String(e)}`);
      throw e;
    }

    const captured: { phase: 1 | 2; body: ChatReq }[] = [];
    let phase: 1 | 2 = 1;
    let phase2Body: ChatReq | null = null;

    server = createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        let body: ChatReq = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as ChatReq;
        } catch {
          body = {};
        }
        captured.push({ phase, body });
        if (phase === 2 && !phase2Body) phase2Body = body;

        const messages = body.messages ?? [];
        const toolsDone = toolResultCount(messages);
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (phase === 1 && toolsDone === 0) {
          res.end(toolCallSse("call_a", "list_workspace", { path: "." }));
        } else if (phase === 1 && toolsDone === 1) {
          res.end(
            toolCallSse("call_b", "report_progress", {
              summary: "listed workspace, continuing analysis",
              confidence: 0.4,
              progress: "MINOR",
              stalled: false,
            }),
          );
        } else {
          res.end(textSse(phase === 1 ? "progress recorded" : "continuing from restored state"));
        }
      });
    });

    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    dataDir = mkdtempSync(join(tmpdir(), "rio-pi-resume-"));
    mkdirSync(join(dataDir, "sessions"), { recursive: true });
    const wm = new WorkspaceManager(join(dataDir, "workspaces"));
    const layout = wm.ensure("ch_resume");
    writeFileSync(join(layout.root, "challenge.txt"), "# CHALLENGE: Resume E2E\nCATEGORY: MISC\n\n## DESCRIPTION\nProve Pi resume keeps history.\n", "utf8");

    const ctx: ToolContext = {
      challengeId: "ch_resume",
      workspace: layout,
      sessionId: "sess_resume",
      safeResolve: (p: string) => wm.safeResolve(layout.root, p),
      emit: () => {},
      recordArtifact: () => null,
      nextResultFile: () => join(layout.results, "tool-0001.txt"),
      pythonExecutable: process.env.RIO_PYTHON ?? "python",
      networkIsolation: "NONE",
    };

    const spec: PiProviderSpec = {
      id: "fake-openai",
      displayName: "Fake OpenAI",
      protocol: "OPENAI_CHAT_COMPLETIONS",
      baseUrl,
      apiKeyRef: "ref.test",
      apiKey: "sk-fake",
      modelId: "fake-model",
      contextWindow: 128000,
      maxOutputTokens: 8192,
    };

    const adapter = new PiAgentRuntimeAdapter(join(dataDir, "pi")).withProviders([spec]);
    const sessionDir = join(dataDir, "sessions");
    const sessionConfigBase = {
      sessionId: "sess_resume",
      challengeId: "ch_resume",
      solverType: "MISC" as const,
      cwd: layout.work,
      workspaceRoot: layout.root,
      sessionDir,
      systemPrompt: systemPromptFor("MISC") + "\n\nRioMisc solver session.",
      modelRef: { providerId: "fake-openai", modelId: "fake-model" },
      tools: [
        { name: "list_workspace", description: "list" },
        { name: "report_progress", description: "progress" },
      ],
      toolContext: ctx,
    };

    phase1 = await adapter.createSolverSession({
      ...sessionConfigBase,
      initialMessage: "Start solving. Call list_workspace then report_progress.",
    });
    await Promise.race([phase1.waitForIdle(), new Promise((r) => setTimeout(r, 60_000))]);

    const persisted = phase1.persistence();
    expect(persisted.sessionFile, "SDK must report a session file").toBeTruthy();
    expect(existsSync(persisted.sessionFile!), "SDK session file must exist on disk").toBe(true);
    expect(persisted.externalSessionId, "SDK must report a session id").toBeTruthy();

    await disposeHandle(phase1);
    phase1 = null;
    await new Promise((r) => setTimeout(r, 200));

    phase = 2;
    const adapter2 = new PiAgentRuntimeAdapter(join(dataDir, "pi")).withProviders([spec]);
    phase2 = await adapter2.resumeSolverSession({
      ...sessionConfigBase,
      initialMessage: buildResumeMessage({ newHints: [], wrongFlags: [], revisionSummary: null }),
      persistedSession: {
        piSessionId: persisted.externalSessionId,
        piSessionFile: persisted.sessionFile,
      },
    });
    await Promise.race([phase2.waitForIdle(), new Promise((r) => setTimeout(r, 60_000))]);

    const logPayload = {
      sdkLoaded: true,
      persisted,
      phase1Requests: captured.filter((c) => c.phase === 1).length,
      phase2Requests: captured.filter((c) => c.phase === 2).length,
      phase2Messages: phase2Body?.messages ?? null,
    };
    writeScratch("pi-resume.log", JSON.stringify(logPayload, null, 2));

    expect(phase2Body, "phase-2 request was never received by the fake server").toBeTruthy();
    const messages = phase2Body!.messages ?? [];
    expect(kickoffOnly(messages), "phase-2 was only a new kickoff — resume did not restore history").toBe(false);
    expect(hasUser(messages)).toBe(true);
    expect(hasAssistantToolCall(messages)).toBe(true);
    expect(hasToolResult(messages)).toBe(true);
  }, 180_000);
});
