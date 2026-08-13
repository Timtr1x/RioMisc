# RioMisc — CTF Misc/Crypto Autonomous Agent Runtime (MVP-1)

西湖论剑 RioMisc：一个能够真实接入 CTF 比赛、自动发现/下载题目、调度 Solver Agent、
并行解题、获取 Hint、验证 Flag、限速自动提交、崩溃后持久化恢复的完整运行时代理。

> **架构三句话**：Control Plane 决定比赛怎么打；Solver Agent 决定一道题怎么解；
> Tool Runtime 决定 Agent 可以安全地做什么。

## 快速开始（Demo）

```bash
npm install
npm run dev          # 启动控制平面 + API (http://127.0.0.1:3000)
```

默认 `contest.adapter: none`：空比赛，Dashboard 粘贴题目 URL 即开始一道真实任务。
已配置 Provider + Model 时自动使用 Pi（真实 LLM）；否则回退 Mock Agent。

要跑内置 11 道演示题，把 `config/runtime.yaml` 改成 `adapter: mock`，系统自动：

```
发现 → 下载附件(流式+SHA256) → Triage → 排队 → 最多 4 个 Solver 并行
→ Mock Agent 解题(真实调用 Python/Tool Runtime) → 候选 Flag → 本地验证
→ 自动提交 → CORRECT → SOLVED
```

Dashboard（另开终端）：

```bash
npm run dev -w apps/dashboard     # http://127.0.0.1:5173
```

CLI：

```bash
npm run cli -- status
npm run cli -- challenges
npm run cli -- challenge ch_crypto-002
```

单题模式（不依赖比赛 API）：

```bash
mkdir /tmp/ch && cd /tmp/ch
# challenge.json + attachments/ + answer.json
npm run solve -- /tmp/ch --timeout 300
```

## 测试

```bash
npm test                # 单元 + 集成 + E2E（E2E 约 5 分钟）
```

覆盖（对应文档 §110-117）：

- 单元：StateMachine 全部合法/非法转换、优先级评分、API 限速、Flag 去重、
  路径守卫（.. / UNC / 绝对路径 / junction）、ZIP roundtrip 与炸弹限制、fixtures 有效性
- 集成：MockContest 发现/下载/Hint 解锁/提交、SubmissionManager wrong→feedback→max-wrong→manual submit
- E2E：11 题无人值守全解、硬崩溃后恢复（不丢任何 challenge/session/workspace）、Hint eligible→fetch

## 架构

```
                         Competition API (MockContest / LocalContest / 真实比赛 Adapter)
                               │
                               ▼
┌────────────────────────────────────────────────────┐
│                   Control Plane                    │
│  Poller · ChallengeRegistry · StateMachine         │
│  EventLog/SQLite · Scheduler · WorkerPool(子进程)   │
│  HintManager · SubmissionManager · Watchdog        │
│  RecoveryManager · ModelRegistry · EventBus(SSE)   │
└───────────────┬──────────────────┬─────────────────┘
                ▼                  ▼
       Solver Worker (fork)   Dashboard / CLI (REST+SSE)
                │
                ▼
┌────────────────────────────────────────────────────┐
│         AgentRuntimeAdapter (唯一 Agent 接触点)      │
│   PiAgentRuntimeAdapter (SDK 封装, lazy import)    │
│   MockAgentRuntime (确定性解题 Agent, 默认)         │
└───────────────────────┬────────────────────────────┘
                        ▼
┌────────────────────────────────────────────────────┐
│   Tool Runtime: FS Guard · ProcessRunner · Python  │
│   ZIP/PNG/PCAP 检查 · 输出限制(12KB inline)         │
└───────────────────────┬────────────────────────────┘
                        ▼
                   Workspace (input/work/artifacts/results/state/agent)
```

## 目录

```
apps/server     Fastify API + SSE + 控制平面 + solver worker 子进程
apps/cli        rio CLI (start/status/challenges/pause/hint/solve …)
apps/dashboard  React/Vite 监控台
packages/domain         纯类型 + Zod schema（无任何框架依赖）
packages/database       node:sqlite 仓储层（Repository 模式）
packages/contest        ContestAdapter · MockContest · Poller · RateLimiter · DiskManager · fixtures
packages/scheduler      优先级评分 · 资源信号量
packages/agent-runtime  AgentRuntimeAdapter · MockAgent · Pi 适配器（隔离层）
packages/tool-runtime   Workspace/FS Guard · ProcessRunner · zip/png/pcap · 工具注册表
packages/solver         System Prompts · 确定性 Triage
docker/                 misc/crypto/sage worker 镜像（Docker 可用时启用）
agent/prompts/          Solver/Triage/Reflection 提示词原文
config/runtime.yaml     运行配置（Zod 启动校验）
```

## 关键机制

- **状态机**：所有 Challenge 生命周期转换必须经过 `StateMachine.transition()`，
  转换 + 事件写入同一 SQLite 事务；禁止散落的 `challenge.status = ...`。
- **Worker 隔离**：每个 Solver 是独立 fork 的子进程（`tsx` 启动），Agent SDK 崩溃
  不影响控制平面；Session 持久化在磁盘，Worker 只是临时执行资源（Challenge → Session → Worker）。
- **Lease + 恢复**：心跳 15s / TTL 45s；启动时 `RecoveryManager` 清理过期 lease、
  重新入队 ACTIVE、重驱 SUBMITTING（先查 submission 历史，绝不盲目重交）。
- **提交安全**：`challenge_id + flag_hash` 唯一约束；同 Flag 永不重复提交；
  本地验证（格式/去重/example 检测/证据）；3 次 Wrong 后 AUTO_SUBMIT_DISABLED。
- **Hint**：`startChallenge() + 10min → ELIGIBLE`，策略（stalled 才取）→ FETCHED → 注入 session。
- **限速优先级**：SUBMIT(0) > HINT(1) > DETAIL(2) > POLL(3) > DOWNLOAD(4)，大附件下载永不阻塞提交。
- **Secret**：API Key 走 AES-256-GCM 加密文件（`CTF_RUNTIME_MASTER_KEY`），SQLite/日志/prompt 中绝不出现明文。
- **Mock Agent**：确定性"解题 Agent"，走与真实 LLM 完全相同的工具链
  （inspect/extract/run_python），可解全部 10 道 mock 题；Pi SDK 可用时
  `RIO_AGENT_RUNTIME=pi` 切换到真实 LLM，接口不变。

## 与规格文档的差异（如实记录）

1. **SQLite 驱动**：规格建议 better-sqlite3 + Drizzle ORM；本机无 VS C++ 工具链，
   better-sqlite3 编译失败，改用 Node 24 内置 `node:sqlite`（零原生依赖）。
   Repository 模式（规格硬性要求）不变，未来可无痛换库。
2. **Pi SDK（重要更新）**：`@earendil-works/pi-coding-agent`（npm 官方 registry
   有 0.84.1，维护者 mitsuhiko/badlogic，homepage: github.com/earendil-works/pi-mono）。
   早期一次 `npm install` 因 better-sqlite3 原生编译失败整体回滚，导致包目录为空，
   并非"空包"。现已安装并**用真实类型完整对接**：
   - `PiAgentRuntimeAdapter` 用真实 SDK API 重写（`createAgentSession` /
     `DefaultResourceLoader.systemPromptOverride` / `defineTool`+typebox /
     `ModelRuntime.create({modelsPath, authPath})` / `setRuntimeApiKey` /
     `SessionManager.create/open`），`pi-sdk.d.ts` stub 已删除。
   - Provider 映射：注册表（DB）→ `data/pi/models.json` + `setRuntimeApiKey`
     运行时注入 → API Key 不落明文（§56）。
   - 工具 schema 对模型宽容（`evidence` 等可选字段 optional），模型省略字段
     不再导致校验失败。
   - 已用**本地 fake OpenAI 端点（SSE）全链路验证**：2 回合真实请求、
     工具 schema 传递、systemPrompt 注入、工具执行 → `candidate` 事件 → 模型
     收到工具结果。`npm run pi-smoke`（单 session 全链路）和
     `npm run pi-e2e`（完整系统：worker 子进程 → 真实 SDK → 提交 → WRONG 反馈）
     可随时复跑。
3. **Dashboard/UI**：保持最小可用（Overview/Challenges/Detail/Providers），
   规格中的其余页面可在此基础上扩展。

## 使用真实 LLM（Pi 运行时）

```bash
# 1. 配置 Provider（Dashboard → Providers 或 API/CLI）
#    Add Provider: baseUrl + protocol + API key（加密落盘，两阶段测试验证）

# 2. 用 Pi 运行时启动
RIO_AGENT_RUNTIME=pi npm run dev

# 3. 无 Provider 时自动回退 MockAgent（同一工具链，闭环仍可跑通）
```

注意：Pi 会读取 `~/.pi/agent` 下的全局扩展/skills 配置；本系统通过
`agentDir` 指向 `data/pi` 隔离，避免污染用户全局配置。

## 配置

`config/runtime.yaml` 全部字段 Zod 校验，非法配置直接拒绝启动。
API Key 通过 Dashboard「Add Provider」或 CLI 配置，加密落盘。

## MVP-1 Definition of Done 对照

- [x] Windows 原生启动 · SQLite 自动迁移 · 配置校验 · SecretStore
- [x] Mock Contest · 轮询 · 动态放题 · 题目更新 · Start · Hint · Submit · 限速 · 重试
- [x] Workspace · 流式下载 · SHA256 · 磁盘预算 · Artifact 记录
- [x] 状态机 · 事件日志 · Scheduler · Worker lease · 崩溃恢复
- [x] Agent Adapter · 持久化/恢复 Session · 模型切换 · Progress/Candidate/Reflection/Handoff
- [x] Misc 基础套件 · Crypto 基础套件 · 单题模式（rio solve）
- [x] 本地验证 · 去重 · Cooldown · Wrong 反馈 · Max wrong · Correct→SOLVED
- [x] Dashboard · CLI · Provider 配置/测试 · 健康监控 · 结构化日志
- [x] 服务器崩溃恢复 · Worker 崩溃恢复 · API 暂时性失败恢复
