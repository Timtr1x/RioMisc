# MVP-1.1 runtime baseline

NativeTrusted 不是 OS sandbox。Agent 生成的 Python 仍能访问工作区外文件和网络；RioMisc 用路径守卫、环境变量过滤、超时和进程树清理降低风险。

已落地：

- Crash recovery 矩阵（PREPARING / ACTIVE / VERIFYING 按 candidate / SUBMITTING 按 submission）
- Pi session 持久化与 `resumeSolverSession`（含 DB 里的 `pi_session_file`）
- UNKNOWN 提交永不自动重交
- Hint stall 用最近有效 progress；失败 backoff；unsupported 不打 API
- 附件名消毒、bounded IO、ZIP/GZIP/PCAP 限制
- 优先级只加一次 manualPriority；三种 StartPolicy
- URL fetch：8MB HTML / 128MB 附件 / 30s / 私网 SSRF / 有限跳转
- `agent.allowMockFallback=false` 时标 `MODEL_RUNTIME_UNAVAILABLE`
- 非 loopback 监听需要 `RIO_API_TOKEN`
- Dashboard / `/api/health` 暴露 blocked、unknown submissions、session mode

压测（已实跑）：

- `npm run stress-burst`：30 题，peakWorkers=4 = solverConcurrency，`/api/health` 持续响应，无双 worker / 双 lease
- `npm run stress-large-file`：256MB inspect + sha256 + search，heapDelta 远小于文件体积

验收脚本（已实跑）：

- `npm run typecheck`
- `npx vitest run tests/unit tests/integration tests/e2e`
- `npm run pi-smoke`（假 OpenAI + 真 Pi SDK）
- `npm run pi-e2e`（worker 子进程 → Pi SDK → 提交 → WRONG）

未纳入 1.1 的：用真实付费模型做长时间 soak。那是进赛前的运维检查，不是运行时可靠性缺口。
