// Pi SDK 全链路验证：本地 fake OpenAI-compatible server + 真实 PiAgentRuntimeAdapter。
// 不依赖任何真实 API key——验证 createAgentSession / models.json / systemPrompt /
// defineTool 工具调用 / 事件订阅 / ToolContext.emit 全链路。
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiAgentRuntimeAdapter, type PiProviderSpec } from "@rio/agent-runtime";
import { WorkspaceManager, type ToolContext } from "@rio/tool-runtime";
import { systemPromptFor } from "@rio/solver";

// ---------------------------------------------------------------------------
// fake OpenAI server (SSE streaming, 2 turns: tool_call → final text)
// ---------------------------------------------------------------------------

const seen = { requests: 0, hadTools: false, hadSystemPrompt: false, toolSchema: "" };
let turn = 0;

function sse(chunk: string): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function fakeOpenAI(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      seen.requests += 1;
      if (parsed.tools) {
        seen.hadTools = true;
        seen.toolSchema = JSON.stringify(parsed.tools[0]?.function?.name ?? "");
      }
      const messages = parsed.messages as { role: string; content?: string; tool_calls?: { function?: { name?: string } }[] }[];
      console.log("  [req]", seen.requests + 1, "roles:", messages.map((m) => m.role + (m.tool_calls?.[0]?.function?.name ? ":" + m.tool_calls[0].function.name : "")).join(","));
      if (messages.some((m) => m.role === "system" && m.content?.includes("RioMisc"))) seen.hadSystemPrompt = true;

      const hasToolResult = messages.some((m) => m.role === "tool");
      turn += 1;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });

      if (!hasToolResult) {
        // turn 1: ask the agent to call submit_flag_candidate
        res.write(sse({ choices: [{ delta: { role: "assistant", content: "" }, index: 0 }] }));
        res.write(
          sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_fake_1",
                      type: "function",
                      function: {
                        name: "submit_flag_candidate",
                        arguments: JSON.stringify({ value: "flag{pi_sdk_works}", confidence: 0.9, reason: "fake server test" }),
                      },
                    },
                  ],
                },
                index: 0,
              },
            ],
          }),
        );
        res.write(sse({ choices: [{ delta: {}, index: 0, finish_reason: "tool_calls" }] }));
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        // turn 2: acknowledge
        res.write(sse({ choices: [{ delta: { role: "assistant", content: "Flag submitted. Done." }, index: 0 }] }));
        res.write(sse({ choices: [{ delta: {}, index: 0, finish_reason: "stop" }] }));
        res.write("data: [DONE]\n\n");
        res.end();
      }
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolvePromise({ server, baseUrl: `http://127.0.0.1:${addr.port}/v1` });
    });
  });
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

const { server, baseUrl } = await fakeOpenAI();
const dataDir = mkdtempSync(join(tmpdir(), "rio-pi-sdk-"));
mkdirSync(join(dataDir, "sessions"), { recursive: true });
const piDir = join(dataDir, "pi");
const wm = new WorkspaceManager(join(dataDir, "workspaces"));
const layout = wm.ensure("ch_pitest");
writeFileSync(join(layout.root, "challenge.txt"), "# CHALLENGE: Pi SDK Test\nCATEGORY: MISC\n\n## DESCRIPTION\nProve the pipeline works.\n", "utf8");

const events: string[] = [];
const ctx: ToolContext = {
  challengeId: "ch_pitest",
  workspace: layout,
  sessionId: "sess_pi_smoke",
  safeResolve: (p: string) => wm.safeResolve(layout.root, p),
  emit: (kind, payload) => {
    events.push(`${kind}:${(payload as { value?: string }).value ?? ""}`);
    console.log("EMIT", kind, JSON.stringify(payload).slice(0, 180));
  },
  recordArtifact: () => null,
  nextResultFile: () => join(layout.results, "tool-0001.txt"),
  pythonExecutable: "python",
  allowNetwork: false,
} as ToolContext;

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

console.log("=== 创建真实 Pi session (provider:", baseUrl, ") ===");
const adapter = new PiAgentRuntimeAdapter(piDir).withProviders([spec]);
const handle = await adapter.createSolverSession({
  sessionId: "sess_pi_smoke",
  challengeId: "ch_pitest",
  solverType: "MISC",
  cwd: layout.work,
  workspaceRoot: layout.root,
  sessionDir: join(dataDir, "sessions"),
  systemPrompt: systemPromptFor("MISC") + "\n\nRioMisc solver session.",
  initialMessage: "Analyze challenge.txt and submit the flag candidate.",
  modelRef: { providerId: "fake-openai", modelId: "fake-model" },
  tools: [{ name: "submit_flag_candidate", description: "x" }],
  toolContext: ctx,
});

await Promise.race([handle.waitForIdle(), new Promise((r) => setTimeout(r, 30_000))]);
console.log("=== 结果 ===");
console.log("请求数:", seen.requests, "| 带 tools:", seen.hadTools, "| systemPrompt 注入:", seen.hadSystemPrompt);
console.log("工具 schema 名称:", seen.toolSchema);
console.log("全部事件:", events);
console.log("usage:", JSON.stringify(handle.usage()));

// assertions
const ok =
  seen.requests >= 2 && seen.hadTools && seen.hadSystemPrompt && events.includes("candidate:flag{pi_sdk_works}") && handle.usage().toolCalls >= 1;
console.log(ok ? "\n✅ PI SDK 全链路验证通过" : "\n❌ 验证失败");
console.log("session 文件:", readdirSync(join(dataDir, "sessions")).join(", "));

try {
  await adapter.abort(handle);
} catch {
  /* ignore */
}
try {
  (handle as unknown as { piSession?: { dispose?: () => void } }).piSession?.dispose?.();
} catch {
  /* ignore */
}
await new Promise((r) => setTimeout(r, 200));
await new Promise<void>((r) => server.close(() => r()));
try {
  rmSync(dataDir, { recursive: true, force: true });
} catch {
  /* windows lock */
}
process.exitCode = ok ? 0 : 1;
setTimeout(() => process.exit(ok ? 0 : 1), 2500).unref();
