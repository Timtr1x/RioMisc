# RioMisc — CTF Misc/Crypto Autonomous Agent Runtime

西湖论剑 RioMisc：一个能够真实接入 CTF 比赛、自动发现/下载题目、调度 Solver Agent、
并行解题、获取 Hint、验证 Flag、限速自动提交、崩溃后持久化恢复的完整运行时代理。

> **里程碑状态：** MVP-1 已 RELEASED · MVP-1.1（运行时加固）已完成 · MVP-2 进行中（未宣布 Feature Complete）
> （详见文末「里程碑状态」）

> **架构三句话**：Control Plane 决定比赛怎么打；Solver Agent 决定一道题怎么解；
> Tool Runtime 决定 Agent 可以安全地做什么。
>
> NativeTrusted 模式不能阻止 Agent 生成的 Python 主动访问宿主机其他文件或网络。RioMisc 通过 Tool 路径守卫、环境变量过滤、超时和进程树清理降低风险，但这不是 OS 安全边界。MVP-1.1 默认继续采用该模式。

## 快速开始（Demo）

```bash
npm install
npm run dev          # 启动控制平面 + API (http://127.0.0.1:3000)
```

默认 `contest.adapter: none`：空比赛。Dashboard 总览有两个入口：

- **接入比赛**：全自动拉题 / 下载 / 派工 / 交 flag。没有赛事 API 时点「接入演示比赛（Mock）」即可走完整流水线；有 CTFd / DASCTF 时填地址 + Token。
- **单题模式**：粘贴一道题的 URL 或附件直链。与接赛入口共存，互不影响。

已配置 Provider + Model 时自动使用 Pi（真实 LLM）；否则回退 Mock Agent。
正式比赛建议把 `agent.allowMockFallback` 设为 `false`：有 Key 时绝不能悄悄换成 Mock。

要跑内置演示题，把 `config/runtime.yaml` 改成 `adapter: mock`。目录共 **22** 道
（21 道可解 + 1 道 WEB 标 unsupported）：原 10 道基础题、QR / WAV / Håstad、
视觉包（低对比 / 通道 / bitplane / alpha / GIF / 旋转 / 反色）和 DNS exfil pcap。

系统自动：

```
发现 → 下载附件(流式+SHA256) → Triage → 排队 → 最多 4 个 Solver 并行
→ Agent 解题（Pi 或 Mock，同一套 Tool Runtime）→ 候选 Flag → 本地验证
→ 自动提交（仅当赛事有官方裁判）→ CORRECT → SOLVED
```

只跑一部分 mock 题时设 `RIO_MOCK_ONLY=misc-006,misc-015`（逗号分隔 fixture id）。

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
  路径守卫（.. / UNC / 绝对路径 / junction）、ZIP roundtrip 与炸弹限制、
  fixtures 有效性、视觉解析、复核→候选
- 集成：MockContest 发现/下载/Hint 解锁/提交、SubmissionManager wrong→feedback→max-wrong→manual submit
- E2E：22 题目录、21 题无人值守全解（Mock Agent + 真实 `runTool`）、硬崩溃后恢复、Hint eligible→fetch
- 评测：`solveRegisteredWithTools` 走同一工具链解 QR / WAV / Håstad / 视觉包 / DNS

真实模型 soak（会打已配置的 Provider，不打印 Key）：

```bash
npx tsx scripts/llm-soak-mock.ts
# 默认只跑视觉包 + DNS（misc-006,008–015）；可用 RIO_MOCK_ONLY / RIO_SOAK_MS 覆盖
```

最近一次 DeepSeek（Pi，非 Mock）对这 9 道新 fixture 为 **9/9 SOLVED**。
Triage / Reflection 的独立真模型 soak、整本 21 题真模型 soak 还没作为门槛跑完。

## 架构

```
                         Competition API (Mock / Local / Idle / CTFd / URL)
                               │
                               ▼
┌────────────────────────────────────────────────────┐
│                   Control Plane                    │
│  Poller · ChallengeRegistry · StateMachine         │
│  EventLog/SQLite · Scheduler · WorkerPool(子进程)   │
│  HintManager · SubmissionManager · Watchdog        │
│  RecoveryManager · ModelRegistry · EventBus(SSE)   │
│  VisualReview · Reflection · StartPolicy           │
└───────────────┬──────────────────┬─────────────────┘
                ▼                  ▼
       Solver Worker (fork)   Dashboard / CLI (REST+SSE)
                │
                ▼
┌────────────────────────────────────────────────────┐
│         AgentRuntimeAdapter (唯一 Agent 接触点)      │
│   PiAgentRuntimeAdapter (SDK 封装, lazy import)    │
│   MockAgentRuntime (确定性解题 Agent)               │
└───────────────────────┬────────────────────────────┘
                        ▼
┌────────────────────────────────────────────────────┐
│   Tool Runtime: FS Guard · ProcessRunner · Python  │
│   ZIP/PNG/PCAP · 视觉 / Crypto / Misc 语义工具      │
│   输出限制(12KB inline) · 实验账本 ALREADY_TESTED    │
└───────────────────────┬────────────────────────────┘
                        ▼
                   Workspace (input/work/artifacts/results/state/agent)
```

## 目录

```
apps/server         Fastify API + SSE + 控制平面 + solver worker 子进程
apps/cli            rio CLI (start/status/challenges/pause/hint/solve …)
apps/dashboard      React/Vite 监控台（含视觉复核、评测页）
packages/domain         纯类型 + Zod schema（无任何框架依赖）
packages/database       node:sqlite 仓储层（Repository 模式）
packages/contest        ContestAdapter · MockContest · Poller · RateLimiter · DiskManager · fixtures
packages/scheduler      优先级评分 · 资源信号量
packages/agent-runtime  AgentRuntimeAdapter · MockAgent · Pi 适配器（隔离层）
packages/tool-runtime   Workspace/FS Guard · ProcessRunner · 工具注册表
packages/visual-runtime 概览 / QR / 变换 / bitplane / 频谱图 / GIF / Vision HTTP
packages/misc-runtime   PCAP / 字符串 / 签名 / 拖尾数据 / 实验账本
packages/crypto-runtime RSA / CRT / Håstad / LCG / XOR / 本地 LLL
packages/solver         System Prompts · 确定性 Triage
packages/eval           注册题 runTool 求解 + benchmark
docker/                 可选 Sage 镜像（工具默认本机 NativeTrusted，不强制 Docker）
agent/prompts/          Solver/Triage/Reflection 提示词原文
config/runtime.yaml     运行配置（Zod 启动校验）
scripts/llm-soak-mock.ts  真模型 soak（只打已存 Key，不打印明文）
```

## 模型怎么调工具

工具在**本机**跑（`NativeTrusted`），不进 Docker。`docker/` 里的 Sage
镜像是可选后端：本机 PATH 上有 `sage`、Python 能 `import fpylll`、或
Docker 里已经有 `sagemath/sagemath` 时，`lll_reduce` 才会去用；否则走
打包的整数 LLL。Windows 上没有官方 fpylll / Sage 轮子，所以默认就是本地实现。

Solver 不会自己去敲文件系统。Pi 适配器只把 CORE 工具（约 15 个，含
`discover_tools` / `get_tool_help` / `execute_tool`）注册成 `defineTool`；
隐藏的 Misc/Crypto 工具经 catalog 白名单由 `execute_tool` 调用 `runTool`，结果写回
workspace `results/tool-NNNN.txt` 和实验账本。Mock Agent 走同一条
`runTool`，所以演示赛和真模型赛的工具语义一致。

Vision 不是第二条 Agent 循环：Solver 调 `analyze_visual`，VisualRuntime
本地先做 QR / 通道 / bitplane；`AUTO` / `VISION_MODEL` 才额外打视觉模型
HTTP。视觉模型返回 map 形 observations 或把 flag 写在 `reasoning_content`
里时，解析器会 salvage，不再要求必须是数组 JSON。

已经发生过的真实调用（不是纸面设计）：

- 现场 DASCTF PNG（extra IDAT scanlines）：Solver 自己调了
  `inspect_file` / `extract_archive` / `run_python` / `analyze_visual` /
  `write_work_file` / `extract_visible_text` 等，单题实验账本 70+ 条。
- 视觉包 + DNS 的 DeepSeek soak：9/9，Pi runtime，模型自己选工具。

## 关键机制

- **状态机**：所有 Challenge 生命周期转换必须经过 `StateMachine.transition()`，
  转换 + 事件写入同一 SQLite 事务；禁止散落的 `challenge.status = ...`。
- **Worker 隔离**：每个 Solver 是独立 fork 的子进程（`tsx` 启动），Agent SDK 崩溃
  不影响控制平面；Session 持久化在磁盘，Worker 只是临时执行资源（Challenge → Session → Worker）。
- **Lease + 恢复**：心跳 15s / TTL 45s；启动时 `RecoveryManager` 清理过期 lease、
  重新入队 ACTIVE、重驱 SUBMITTING（先查 submission 历史，绝不盲目重交）。
- **提交安全**：`challenge_id + flag_hash` 唯一约束；同 Flag 永不重复提交；
  本地验证（格式/去重/example 检测/证据）；3 次 Wrong 后 AUTO_SUBMIT_DISABLED。
- **自动提交**：`autoSubmit` + `confidenceThreshold`（默认 0.85）。
  CTFd / Mock 有官方裁判，达标就交；URL / idle 没有官方裁判，候选停在
  VERIFIED，等人在 Dashboard 点接受。视觉复核里长得像 flag 的回答会以
  0.95 置信度再走一遍候选通道。
- **Hint**：`startChallenge() + 10min → ELIGIBLE`，策略（stalled 才取）→ FETCHED → 注入 session。
- **限速优先级**：SUBMIT(0) > HINT(1) > DETAIL(2) > POLL(3) > DOWNLOAD(4)，大附件下载永不阻塞提交。
- **Secret**：API Key 走 AES-256-GCM 加密文件（`CTF_RUNTIME_MASTER_KEY`），SQLite/日志/prompt 中绝不出现明文。
- **视觉预算**：默认每题最多 40 次 Vision HTTP（`visual.maxVisionCallsPerChallenge`）。
  提示词要求先 `LOCAL_ONLY`，同一张图不要反复打 Vision。
- **Mock Agent**：确定性解题 Agent，走与真实 LLM 完全相同的工具链。
  可解全部 21 道可解 mock 题。有 Provider 时走 Pi，接口不变。

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
3. **Dashboard/UI**：Vite + React + 现有 CSS。不要引入 Tailwind / shadcn。
   Overview / Challenges / Detail / Providers / 视觉复核 / 评测页已落地。

## 使用真实 LLM（Pi 运行时）

```bash
# 1. 配置 Provider（Dashboard → Providers 或 API/CLI）
#    Add Provider: baseUrl + protocol + API key（加密落盘，两阶段测试验证）

# 2. 用 Pi 运行时启动
RIO_AGENT_RUNTIME=pi npm run dev

# 3. 无 Provider 时自动回退 MockAgent（同一工具链，闭环仍可跑通）
#    正式比赛：agent.allowMockFallback: false
```

注意：Pi 会读取 `~/.pi/agent` 下的全局扩展/skills 配置；本系统通过
`agentDir` 指向 `data/pi` 隔离，避免污染用户全局配置。

## 配置

`config/runtime.yaml` 全部字段 Zod 校验，非法配置直接拒绝启动。
API Key 通过 Dashboard「Add Provider」或 CLI 配置，加密落盘。

## 里程碑状态

### MVP-1（已 RELEASED）

- [x] Windows 原生启动 · SQLite 自动迁移 · 配置校验 · SecretStore
- [x] Mock Contest · 轮询 · 动态放题 · 题目更新 · Start · Hint · Submit · 限速 · 重试
- [x] Workspace · 流式下载 · SHA256 · 磁盘预算 · Artifact 记录
- [x] 状态机 · 事件日志 · Scheduler · Worker lease · 崩溃恢复
- [x] Agent Adapter · 持久化/恢复 Session · 模型切换 · Progress/Candidate/Reflection/Handoff
- [x] Misc 基础套件 · Crypto 基础套件 · 单题模式（rio solve）
- [x] 本地验证 · 去重 · Cooldown · Wrong 反馈 · Max wrong · Correct→SOLVED
- [x] Dashboard · CLI · Provider 配置/测试 · 健康监控 · 结构化日志
- [x] 服务器崩溃恢复 · Worker 崩溃恢复 · API 暂时性失败恢复

### MVP-1.1（运行时加固，已完成）

- [x] 真 Pi Session Resume（DB 记录 `pi_session_file`，worker 恢复原上下文）
- [x] Crash Recovery 矩阵（PREPARING / ACTIVE / VERIFYING / SUBMITTING）
- [x] UNKNOWN 提交永不自动重交
- [x] Hint 不误取：stall 判定 + 失败 backoff + unsupported 不打 API
- [x] 大文件无 OOM：附件名消毒、bounded IO、ZIP/GZIP/PCAP 限制
- [x] URL 单题接入：8MB HTML / 128MB 附件 / 30s / 私网 SSRF 防护 / 有限跳转
- [x] Provider 故障可见：3 次失败 DEGRADED、5 次 DOWN，`/api/health` 暴露
- [x] 压测实跑：30 题 burst + 256MB 大文件（heapDelta 远小于文件体积）
- [x] 非 loopback 监听需 `RIO_API_TOKEN` · SQLite 关停幂等 · CI
- [x] 验收：typecheck / unit+integration / E2E / pi-smoke / pi-e2e 全部通过

> 1.1 的六个退出指标（真 Pi Resume、Recovery 矩阵、UNKNOWN 不重交、Hint 不误取、
> 大文件无 OOM、30 题 burst + 真实模型）全部达成，按 `开发指南1.1.md` §92 正式标记 RELEASED。

### MVP-2（进行中，未宣布 Feature Complete）

已落地、且有测试或真模型证据的部分：

- [x] VisualRuntime：概览 / QR / 变换 / bitplane / 频谱图 / GIF 帧 / Vision HTTP
- [x] Vision 解析 2.0.2：数组或 map 形 observations；从 prose / `reasoning_content` salvage `flag{…}`
- [x] 视觉复核：像 flag 的人工回答会以 0.95 置信度进入候选
- [x] 工具默认本机执行（NativeTrusted）。`lll_reduce` 自带整数 LLL；本机/Docker 有 Sage 或 fpylll 时才改走外部后端
- [x] Misc / Crypto 语义工具 + 实验账本（`ALREADY_TESTED` + force）
- [x] Hypothesis 落库 · Artifact `parentArtifactId` DAG · HUMAN VisualEvidence 持久化
- [x] Mock 目录 22（21 可解 + WEB）；eval / Mock 策略走真实 `runTool`
- [x] 视觉包 + DNS 真模型 soak 9/9（DeepSeek / Pi）

还没当作门槛关闭的部分：

- [ ] 不宣布 Feature Complete（CryptoState 表、Triage/Reflection 真模型 soak 等仍缺）
- [ ] 频谱图藏字、MT19937 等更难 fixture
- [ ] 整本 21 题真模型 soak（目前 Mock E2E 21/22，真模型只 soak 了 9 道新题）
