# RioMisc — CTF Misc/Crypto Autonomous Agent Runtime

西湖论剑 RioMisc：接入 CTF 比赛后自动发现 / 下载题目、调度 Solver、并行解题、
取 Hint、校验 Flag、限速提交，崩溃后从 SQLite 恢复。只处理 Misc 和 Crypto；
Web / Pwn / Reverse 标 `UNSUPPORTED`，不启动 Solver。

> **状态：** MVP-1 与 MVP-1.1 已 RELEASED。MVP-2（视觉 / 语义工具 / 规划账本）
> 和 2.5（工具渐进披露、Manager 派发、四模式 Reflection）已落地，有测试。
> **未宣布 Feature Complete**：整本 21 题真模型 soak、Triage/Reflection 独立
> 真模型 soak 还没当门槛跑完。

> **架构三句话**：Control Plane 决定比赛怎么打；Solver Agent 决定一道题怎么解；
> Tool Runtime 决定 Agent 可以安全地做什么。
>
> 执行模式是 **NativeTrusted**，不是 OS 沙箱。Agent 写出的 Python 仍可能访问
> 宿主机文件或网络。路径守卫、环境变量过滤、超时和进程树清理会降低风险，
> 但不是安全边界。

## 快速开始

```bash
npm install
npm run dev                       # 控制平面 + API  http://127.0.0.1:3000
npm run dev -w apps/dashboard     # 监控台          http://127.0.0.1:5173
```

需要 Node ≥ 22.5（内置 `node:sqlite`）和本机 Python 3。默认 `contest.adapter: none`，开机是空比赛。

**部署不会再下载一份「解题工具箱」。** `npm install` 只装 Node 包（含 Pi SDK）。
inspect / ZIP / PCAP / RSA / LLL / 视觉等写在仓库 catalog 里。Python 必须事先装好，
缺了进程起不来。`ffmpeg`、Sage 是可选增强，没有就跳过对应能力。
赛场步骤见 [docs/deploy.md](docs/deploy.md)。

Dashboard 总览两个入口，可同时用：

- **接入比赛**：自动拉题 / 下载 / 派工 / 交 flag。没有赛事 API 时点「接入演示比赛（Mock）」；
  **DASCTF Agent** 填 Host + AccessKey；CTFd 填地址 + Token/Cookie。
  也可 yaml 写 `adapter: dasctf|ctfd` + `baseUrl`（AccessKey 用 `DASCTF_ACCESS_KEY`，勿提交 git）。
  大模型走平台「网关 URL」作 Provider baseUrl，**模型 API Key 仍是你自己的**，不是平台 AccessKey。
- **单题模式**：粘贴题目页 URL 或附件直链，不依赖比赛 API。

已配置可用的 Provider + Model 时，下一道 Solver 自动走 Pi（真 LLM）；否则回退 Mock。
正式比赛把 `agent.allowMockFallback` 设为 `false`：没模型就停，不要假装在解。

内置 Mock 目录 **22** 道（21 可解 + 1 道 WEB 标 unsupported）：基础编解码 / 压缩 /
PNG 拖尾 / LSB / HTTP PCAP、XOR / 小 RSA / 共模 / LCG / Håstad、QR / WAV、
视觉包（低对比 / 通道 / bitplane / alpha / GIF / 旋转 / 反色）和 DNS exfil。
yaml 改 `adapter: mock`，或设 `RIO_MOCK_ONLY=misc-006,misc-015` 只跑一部分。

接上比赛或 Mock 之后的流水线：

```
发现 → 下载附件（流式 + SHA256）→ Triage → 排队
  →（可选）Manager 决定本轮谁占 Solver 位
  → 最多 solverConcurrency 个 Solver（默认 4）
  → Agent 解题（Pi 或 Mock，同一套 Tool Runtime）
  → 候选 Flag → 本地验证
  → 有官方裁判才自动提交 → CORRECT → SOLVED
```

**Manager 默认关。** 打开它不会多出「去平台拉题」；拉题靠比赛接入。
Manager 只在几十道题抢 4 个槽时做派发。

```yaml
# config/runtime.yaml
manager:
  enabled: false          # true 才调用 Manager
  mode: SHADOW            # OFF | SHADOW（只记录）| ACTIVE（闸调度）
reflection:
  enabledByDefault: true
  mode: HYBRID            # OFF | HEURISTIC | LLM | HYBRID
```

CLI：

```bash
npm run cli -- status
npm run cli -- challenges
npm run cli -- manager status
npm run cli -- manager enable          # SHADOW
npm run cli -- strategy ch_crypto-002
npm run cli -- reflect ch_crypto-002
```

本地文件夹单题（`challenge.json` + `attachments/`，`answer.json` 可选）：

```bash
npm run solve -- /path/to/challenge --timeout 300
```

## 测试

```bash
npm test                 # 单元 + 集成 + E2E（E2E 大约 10 分钟）
npm run test:ci          # 只跑单元 + 集成
npm run typecheck
npm run docs:tools       # 从 catalog 生成 docs/tools/
```

当前覆盖（都走仓库里的实现，不是另写一套）：

- 单元：状态机、优先级、Flag 去重、路径守卫、ZIP 炸弹限制、视觉解析、
  工具披露 catalog、Manager snapshot / Policy / TTL / debounce、
  Reflection 门闩 / fingerprint / 四模式
- 集成：Contest 发现下载提交、StartPolicy、Manager 40 题 / 4 槽派发、
  Manager 失败仍启动 Solver、Reflection 注入同一 worker、题级 Reflection OFF
- E2E：22 题 Mock 目录、21 题无人值守全解（Mock Agent + 真 `runTool`）、
  硬崩溃恢复、Hint eligible→fetch
- 评测：`solveRegisteredWithTools` 解 QR / WAV / Håstad / 视觉包 / DNS

真模型 soak（打已配置的 Provider，不打印 Key）：

```bash
npx tsx scripts/llm-soak-mock.ts
# 默认视觉包 + DNS（misc-006,008–015）；RIO_MOCK_ONLY / RIO_SOAK_MS 可覆盖
```

最近一次 DeepSeek（Pi，非 Mock）对这 9 道是 **9/9 SOLVED**。
整本 21 题真模型 soak、Triage / Reflection 独立真模型 soak 没有当门槛跑完。

Pi SDK 冒烟：`npm run pi-smoke`、`npm run pi-e2e`（本地 fake OpenAI SSE）。

## 架构

```
                    Competition API
              (Mock / Local / Idle / CTFd / URL)
                           │
                           ▼
                 发现 / 准备 / 便宜 triage
                           │
                           ▼
              Manager Snapshot（可选，默认不调用）
                           │
                     Dispatch Plan
                           │
                    Policy + Scheduler     ← 唯一启动 Worker 的地方
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
        Solver A        Solver B        Solver C
           │               │               │
       Reflector?      Reflector?      Reflector?
        （可选，不占 Solver 槽）
```

硬约束：**一题最多一个 Solver Worker**。Manager 不启动进程、不改 Challenge
生命周期、不调 Contest API、不交 flag。Reflector 没有工具、没有长期 Session。

```
┌────────────────────────────────────────────────────┐
│                   Control Plane                    │
│  Poller · StateMachine · SQLite · Scheduler        │
│  WorkerPool · Hint · Submission · Watchdog         │
│  Recovery · ModelRegistry · EventBus(SSE)          │
│  VisualReview · Reflection · Manager · StartPolicy │
└───────────────┬──────────────────┬─────────────────┘
                ▼                  ▼
       Solver Worker (fork)   Dashboard / CLI
                │
                ▼
┌────────────────────────────────────────────────────┐
│         AgentRuntimeAdapter（唯一 Agent 接触点）     │
│   PiAgentRuntimeAdapter · MockAgentRuntime         │
└───────────────────────┬────────────────────────────┘
                        ▼
┌────────────────────────────────────────────────────┐
│  Tool Runtime：CORE ≤15 + discover / help / execute │
│  FS Guard · ProcessRunner · 实验账本 ALREADY_TESTED  │
└────────────────────────────────────────────────────┘
```

## 工具怎么暴露给模型

工具在本机跑（`NativeTrusted`），不进 Docker。Pi 适配器只把 **15 个 CORE**
注册成 `defineTool`（工作区读写、inspect、Python、进度 / 交 flag、
`discover_tools` / `get_tool_help` / `execute_tool`）。其余 **38** 个
Misc / Crypto / 视觉攻击在 catalog 里，模型必须 `discover → help → execute`。
`execute_tool` 只能打 DISCOVERABLE 白名单，打不到 CORE。

完整名单由 catalog 生成：`docs/tools/`（`npm run docs:tools`）。

`lll_reduce` 默认走打包的整数 LLL；PATH 上有 `sage`、Python 能
`import fpylll`、或本机已有 `sagemath/sagemath` 镜像时才改走外部后端。
Windows 没有官方 fpylll / Sage 轮子，所以默认就是本地实现。

Vision 不是第二条 Agent 循环：Solver 调 `analyze_visual`，本地先做
QR / 通道 / bitplane；`AUTO` / `VISION_MODEL` 才打视觉模型 HTTP。
返回 map 形 observations 或把 flag 写在 `reasoning_content` 里时会 salvage。

已经发生过的真实调用：

- 现场 DASCTF PNG（extra IDAT scanlines）：Solver 自己调了
  `inspect_file` / `extract_archive` / `run_python` / `analyze_visual` 等，
  单题实验账本 70+ 条。
- 视觉包 + DNS 的 DeepSeek soak：9/9，Pi，模型自己选工具（含
  `discover_tools` / `execute_tool`）。

## Manager 和 Reflection

**Manager**（`manager.enabled`，默认 false）

| 模式 | 行为 |
|---|---|
| OFF | 不调用模型，调度与 MVP-2 相同 |
| SHADOW | 出计划并落库，**不拦** Scheduler |
| ACTIVE | 只有计划允许 `START` 的排队题才能占槽；计划过期或模型失败回退确定性调度 |

人工 Lock / Force Start / Force Hold 永远高于 Manager。
Dashboard「调度」页、`GET /api/orchestration/status`、`rio manager status` 可看
模式、健康、槽位和计划历史。

**Reflection**（默认 HYBRID，不占 Solver 槽，最多 `reflection.maxConcurrent` 路）

| 模式 | 行为 |
|---|---|
| OFF | 不自动跑；Dashboard「Reflect Now」仍可强制一次 |
| HEURISTIC | 只用现有启发式，不打模型 |
| LLM | 打 `reflectionModelId`（否则 primarySolver / primary）；失败记 FAILED |
| HYBRID | 先打模型，失败再 heuristic，状态 `FALLBACK` |

自动触发：错 Flag、连续 3 次 `NO_SIGNAL`、120s 无进展、重复实验、Solver 请求。
相同状态 fingerprint 不重复跑。结果注入**同一** Solver；worker 不在线则下次
start / resume 再送。

模型分配槽：主解题 / 反思 / 视觉 / 分诊 / **Manager**（Dashboard「模型」页）。

## 关键机制

- **状态机**：生命周期只能经 `StateMachine.transition()`，与事件同一事务。
- **Worker**：每题一个 fork 子进程。SDK 崩溃不影响控制平面。
- **Lease + 恢复**：心跳 15s / TTL 45s。启动时清过期 lease、ACTIVE 回排队、
  重驱 SUBMITTING（先查提交历史，绝不盲目重交）。进行中的 Reflection 标 FAILED。
- **提交**：`challenge_id + flag_hash` 唯一；同 Flag 不重交；3 次 Wrong 后
  `AUTO_SUBMIT_DISABLED`。CTFd / Mock 有裁判才自动交；URL / idle 停在 VERIFIED。
- **Hint**：`startChallenge() + 10min → ELIGIBLE`，默认 stalled 才取。
- **限速**：SUBMIT > HINT > DETAIL > POLL > DOWNLOAD，大附件不挡提交。
- **Secret**：API Key 走 AES-256-GCM（`CTF_RUNTIME_MASTER_KEY`），不进 SQLite / 日志 / prompt。
- **视觉预算**：每题最多 40 次 Vision HTTP。提示词要求先 `LOCAL_ONLY`。

## 配置

`config/runtime.yaml` 经 Zod 校验，非法值拒启动。常用块：

```yaml
contest:      # none | mock | local | ctfd
challenge:    # startPolicy
workers:      # solverConcurrency / triageConcurrency
agent:        # allowMockFallback
manager:      # enabled / mode / planTtlMs / maxCandidates
reflection:   # mode / maxConcurrent / cooldownMs
visual:       # maxVisionCallsPerChallenge
server:       # 127.0.0.1:3000；非 loopback 需 RIO_API_TOKEN
```

Provider 在 Dashboard「模型」添加（两阶段连通性测试）。运行时按
「有没有可用 Provider + Model」选择 Pi 或 Mock；`RIO_AGENT_RUNTIME=pi|mock` 可强制。

Pi 的 `agentDir` 指到 `data/pi`，不读用户 `~/.pi/agent`。

## 目录

```
apps/server          Fastify API + SSE + 控制平面 + solver worker
apps/cli             rio CLI
apps/dashboard       总览 / 题目 / 详情 / 调度 / 模型 / 视觉复核 / 评测
packages/domain      类型 + Zod（无框架依赖）
packages/database    node:sqlite 仓储（含 orchestration / reflection_runs）
packages/contest     ContestAdapter · Mock · CTFd · Poller · fixtures
packages/scheduler   优先级 · 信号量
packages/agent-runtime   Adapter · Mock · Pi 0.84
packages/tool-runtime    Catalog（CORE + DISCOVERABLE）· FS Guard · runTool
packages/visual-runtime  QR / 变换 / bitplane / 频谱图 / GIF / Vision HTTP
packages/misc-runtime    PCAP / 字符串 / 实验账本
packages/crypto-runtime  RSA / CRT / Håstad / LCG / XOR / 本地 LLL
packages/solver      System prompts · 确定性 Triage
packages/eval        注册题 runTool 求解
docs/deploy.md       部署：依赖、不会自动下载什么、赛场清单
docs/tools/          由 catalog 生成的工具说明
config/runtime.yaml  运行配置
scripts/llm-soak-mock.ts   真模型 soak（不打印 Key）
```

存储用 Node 内置 `node:sqlite`，不用 better-sqlite3。Dashboard 是 Vite + React +
现有 CSS，不要加 Tailwind / shadcn。

## 里程碑

### 已 RELEASED

**MVP-1**：接赛、状态机、Worker/Lease、Mock/Pi Adapter、基础 Misc/Crypto 工具、
单题模式、提交安全、Dashboard/CLI、崩溃恢复。

**MVP-1.1**：真 Pi Session Resume、Recovery 矩阵、UNKNOWN 提交不自动重交、
Hint 不误取、大文件 bounded IO、URL 单题 SSRF 防护、Provider DEGRADED/DOWN、
非 loopback 需 API token、CI。

### 已落地、未宣布 Feature Complete

**MVP-2**：VisualRuntime、视觉复核、语义工具 + 实验账本、Hypothesis / Artifact DAG、
22 题 Mock 目录、eval 走真 `runTool`、视觉包 + DNS 真模型 9/9。

**MVP-2.5**：Pi 只注册 CORE 15 + discover/help/execute；Manager OFF/SHADOW/ACTIVE
（默认 OFF）；Reflection OFF/HEURISTIC/LLM/HYBRID（默认 HYBRID）。

### 还没当门槛关掉

- 整本 21 题真模型 soak（Mock E2E 是 21/22）
- Triage / Reflection 独立真模型 soak
- 频谱图藏字等更难 fixture
- Manager 自动 PARK / 抢占（`allowAutoPark` 保持 false）
- 整场 Manager 30～100 题压力验收
