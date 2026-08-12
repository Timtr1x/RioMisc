// 终极验证：完整系统 + 真实 Pi SDK runtime。
// fake OpenAI server 扮演"模型"（直接提交一个候选 flag），验证：
// worker 子进程 → 真实 PiAgentRuntimeAdapter → 工具执行 → IPC candidate
// → 控制平面验证 → MockContest 提交 → WRONG → 反馈注入 worker。
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { startRuntime } from "../apps/server/src/index.js";

process.env.CTF_RUNTIME_MASTER_KEY = "pi-e2e-test-key";
process.env.RIO_AGENT_RUNTIME = "pi";

// fake OpenAI: 第一回合直接要求模型……不，fake 直接返回 tool_call
let turn = 0;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c: Buffer) => (body += c.toString()));
  req.on("end", () => {
    const parsed = JSON.parse(body);
    const messages = parsed.messages as { role: string }[];
    const hasTool = messages.some((m) => m.role === "tool");
    turn++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const sse = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
    if (!hasTool) {
      res.write(sse({ choices: [{ delta: { role: "assistant", content: "" }, index: 0 }] }));
      res.write(
        sse({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "c1",
                    type: "function",
                    function: {
                      name: "submit_flag_candidate",
                      arguments: JSON.stringify({ value: "flag{pi_worker_e2e}", confidence: 0.95, reason: "fake model derived it" }),
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
    } else {
      res.write(sse({ choices: [{ delta: { role: "assistant", content: "understood" }, index: 0 }] }));
      res.write(sse({ choices: [{ delta: {}, index: 0, finish_reason: "stop" }] }));
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
console.log("fake openai on", port);

const dataDir = mkdtempSync(join(tmpdir(), "rio-pi-e2e-"));
const runtime = await startRuntime({
  skipApi: true,
  configOverrides: {
    contest: { adapter: "mock", poll: { initialMs: 1000, maxMs: 2000 } },
    workers: { solverConcurrency: 2, triageConcurrency: 2 },
    watchdog: { checkMs: 3000, heartbeatMs: 2500, leaseTtlMs: 8000 },
    submission: { autoSubmit: true, confidenceThreshold: 0.85, localMaxWrong: 3, defaultCooldownMs: 0 },
    paths: { dataDir, configDir: join(process.cwd(), "config") },
  },
});

// 注册表：加 fake provider + PRIMARY model
const provider = await runtime.registry.addProvider({
  displayName: "Fake OpenAI",
  protocol: "OPENAI_CHAT_COMPLETIONS",
  baseUrl: `http://127.0.0.1:${port}/v1`,
  apiKey: "sk-fake",
  enabled: true,
});
await runtime.registry.addModel({
  providerId: provider.id,
  modelName: "fake-model",
  contextWindow: 128000,
  maxOutputTokens: 8192,
  role: "PRIMARY",
  enabled: true,
});
console.log("provider + model 注册完成");

// 等一道题 ACTIVE + worker 用真实 Pi runtime 解出 candidate → 提交
const deadline = Date.now() + 120_000;
let submissionSeen = false;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  const subs = runtime.repos.submissions.listByChallenge("ch_misc-001");
  if (subs.length > 0) {
    submissionSeen = true;
    console.log("submission:", subs[0]!.status, subs[0]!.flagValue);
    break;
  }
  const c = runtime.repos.challenges.get("ch_misc-001");
  if (c) console.log("misc-001:", c.lifecycleStatus, "solver:", c.currentSolverType);
}

// 等 WRONG 反馈注入（mock 会拒绝 flag{pi_worker_e2e}）
let wrongSeen = false;
const deadline2 = Date.now() + 60_000;
while (Date.now() < deadline2) {
  await new Promise((r) => setTimeout(r, 2000));
  const subs = runtime.repos.submissions.listByChallenge("ch_misc-001");
  if (subs.some((s) => s.status === "WRONG")) {
    wrongSeen = true;
    console.log("WRONG 反馈已记录");
    break;
  }
  if (subs.length === 0) break;
}

const ok = submissionSeen && wrongSeen;
console.log(ok ? "\n✅ 真实 Pi runtime 完整系统链路验证通过" : "\n❌ 失败");
console.log("requests:", turn, "| submission:", submissionSeen, "| wrong feedback:", wrongSeen);
server.close();
await runtime.close();
rmSync(dataDir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
