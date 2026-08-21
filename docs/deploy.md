# 部署指南

RioMisc 是本机进程，不是「装完会自己去下 steghide / binwalk / Sage」的发行包。
`npm install` 只拉 **Node 依赖**（含 Pi SDK）。题目分析工具写在仓库的
TypeScript catalog 里，启动时已经在代码中，**不会再下载一份工具箱**。

Solver 需要算东西时：

| 来源 | 会不会自动下载 | 没有时 |
|---|---|---|
| Node 包（`npm install`） | 会（一次） | 装不上就起不来 |
| 仓库内工具（inspect / ZIP / PCAP / RSA / LLL / QR / bitplane …） | 不会，已在代码里 | — |
| 本机 Python（`run_python`） | 不会 | **启动失败**（必须先装好） |
| `ffmpeg`（视频抽帧） | 不会 | 该工具返回失败，PNG/JPEG/GIF 仍可用 |
| Sage / fpylll / Docker Sage | 不会 | `lll_reduce` 走打包的整数 LLL |

Agent 写出的 Python **可以**自己 `pip install`，那是模型行为，不是部署流程。
正式赛场不要依赖「现场现装包」。

---

## 1. 机器要求

**必须**

- Windows / Linux / macOS
- **Node.js ≥ 22.5**（用内置 `node:sqlite`）
- **Python 3** 在 PATH 上（Windows 一般是 `python`，或设 `RIO_PYTHON` 为绝对路径）
- 磁盘：配置默认 workspace 上限 80GB、单题软限 8GB，按赛题附件留余量
- 出站网络：调模型 API；接 CTFd 时还要能访问比赛站和附件 CDN

**按需**

- `ffmpeg`：视频抽关键帧
- `sage`，或 Python 能 `import fpylll`，或本机已有 `sagemath/sagemath` 镜像：更强 LLL
- Docker：只为可选 Sage 镜像，**不是**默认运行方式

不需要、也不会自动安装：steghide、zsteg、binwalk、tshark、exiftool。
PCAP / 图片 / 压缩包解析是仓库里的实现。

---

## 2. 装到本机

```bash
git clone <你的仓库> && cd rio-misc-agent
npm install
```

`npm install` 之后检查：

```bash
node -v          # ≥ 22.5
python --version # 或: set RIO_PYTHON=C:\Path\to\python.exe
npx tsc --noEmit -p tsconfig.json
```

启动：

```bash
npm run dev                       # API  http://127.0.0.1:3000
npm run dev -w apps/dashboard     # UI   http://127.0.0.1:5173
```

必须两个进程。API **不托管** Dashboard 静态文件；Vite 把 `/api` 代理到 3000。
默认只绑 `127.0.0.1`。

数据目录默认 `./data/`（SQLite、workspaces、sessions、加密密钥、`.master_key`）。
已在 `.gitignore`，换机器请整目录拷走，不要只拷代码。

---

## 3. 接比赛前的配置

编辑 `config/runtime.yaml`（非法值会拒启动）：

```yaml
contest:
  adapter: none          # 空盘；Dashboard 再点「接入比赛」
  # adapter: mock        # 内置 22 题演示
  # --- DASCTF Agent API（game/api_doc.md）---
  # adapter: dasctf
  # baseUrl: https://pro.dasctf.com
  # token: ""            # X-Agent-AccessKey；或环境变量 DASCTF_ACCESS_KEY（勿提交 git）
  # --- CTFd 兼容 ---
  # adapter: ctfd
  # baseUrl: https://ctf.example.com
  # token: ""            # 或环境变量 CTFD_TOKEN
  # cookie: ""           # 或 CTFD_COOKIE
  # miscCryptoOnly: true
  # trustedCredentialOrigins:
  #   - https://files.ctf.example.com

agent:
  allowMockFallback: false   # 正式赛：没模型就停

server:
  host: 127.0.0.1
  port: 3000
  # 若改成 0.0.0.0，必须同时设 RIO_API_TOKEN（≥8 字符）

manager:
  enabled: false         # 打开也不会多出「去拉题」
  mode: SHADOW           # 确认计划后再改 ACTIVE

reflection:
  mode: HYBRID
```

### DASCTF Agent 赛（推荐 Dashboard）

1. 概览页 → **接入 DASCTF Agent**
2. 比赛地址：`https://pro.dasctf.com`（控制台 Server Host）
3. AccessKey：控制台 `ak_live_…`（**只用于比赛接口**，不是大模型 Key）
4. 连上后 Poller 自动拉 Misc/Crypto；需要靶机时会调 `build-exercise-env`

离线探针（不启动整站）：

```powershell
$env:DASCTF_ACCESS_KEY="ak_live_..."
$env:DASCTF_BASE_URL="https://pro.dasctf.com"
npx tsx scripts/dasctf-probe.ts
```

### 大模型网关（game/gateway_doc.md）

正式赛 **必须** 走平台「网关 URL」，不要直连 `api.minimaxi.com`。凭证边界：

| 填哪里 | 填什么 |
|---|---|
| Provider 接口地址 | 控制台 **网关 URL**，如 `https://llm-gateway.dasctf.com/llm-gateway/proxy/e/ROOTaD_VNfr2UJwy` |
| Provider API Key | 你自己的 MiniMax / 上游 Key（**不是** 平台 AccessKey） |
| 比赛接入 AccessKey | 只用于拉题/交 flag |

Dashboard → 模型：

1. Add Provider
   - Protocol：`ANTHROPIC_MESSAGES`（MiniMax Anthropic 兼容）
   - Base URL：粘贴控制台网关 URL（整段复制，不要自己拼路径）
   - API Key：MiniMax Key
2. 添加模型名（如 `MiniMax-M3`），点「测试连接」
3. 设为主解题（及可选反思 / Manager）

路径说明：若控制台「原始 BaseURL」写成了  
`https://api.minimaxi.com/anthropic/v1/messages`，生成的网关 URL **本身就是** messages 端点；RioMisc 会识别 `/llm-gateway/proxy/`，**不再**追加 `/v1/messages`（否则 404）。  
更稳妥的登记方式是原始 URL 只写到 `https://api.minimaxi.com/anthropic`，再让 Agent 拼 `/v1/messages`；两种都能用。

一键把现有 MiniMax Key 迁到网关（需 API 已启动）：

```powershell
npx tsx scripts/setup-dasctf-gateway.ts
```

有可用 Provider + Model 后，下一道 Solver 自动走 Pi。不要用
`RIO_AGENT_RUNTIME=mock` 打正式赛。

Master key：环境变量 `CTF_RUNTIME_MASTER_KEY`，否则第一次启动写
`data/.master_key`。丢了这个文件，已存的 API Key 解不开。

---

## 4. 赛场建议流程

1. 赛前在本机 `npm install`，跑通 Mock 或 `npm run test:ci`。
2. `allowMockFallback: false`，配好 **网关 URL + 自己的模型 Key** 并测试连接。
3. Dashboard 接入 DASCTF / CTFd，或 yaml + 环境变量（**AccessKey 勿提交仓库**）。
4. 附件若在另一个域名，把该 origin 填进 `trustedCredentialOrigins`。
5. 先保持 `manager.enabled: false`；题多再 `SHADOW` 观察，再 `ACTIVE`。
6. 只让本机浏览器打开 `http://127.0.0.1:5173`，不要把 API 暴露到公网。
7. 备份 `data/`（至少 `database/`、`secrets.enc`、`.master_key`）。

更新代码：`git pull` → `npm install` → 重启两个进程。SQLite 会跑迁移。
不要在赛中途换 Node 大版本或删 `data/`。

---

## 5. 环境变量

| 变量 | 作用 |
|---|---|
| `RIO_PYTHON` | Python 可执行文件（绝对路径最稳） |
| `RIO_DATA_DIR` | **覆盖** yaml 里的 `paths.dataDir`（可用仓库根 `.env`，已在 `.gitignore`） |
| `RIO_CONFIG` | 覆盖配置文件路径 |
| `RIO_HOST` / `RIO_PORT` | API 监听 |
| `RIO_API_TOKEN` | 非 loopback 监听时必填 |
| `RIO_API` | CLI 连哪台 API（默认 `http://127.0.0.1:3000`） |
| `CTF_RUNTIME_MASTER_KEY` | 加密密钥；不设则用 `data/.master_key` |
| `CTFD_TOKEN` / `CTFD_COOKIE` | 可代替 yaml 里的凭据 |
| `RIO_AGENT_RUNTIME` | 强制 `pi` 或 `mock`（一般不用） |
| `RIO_MOCK_ONLY` | Mock 只跑列出的 fixture id |

---

## 6. 常见问题

**启动报 Python executable not found**  
装 Python 3，或 `RIO_PYTHON` 指到 `python.exe`。

**有 Key 却在走 Mock**  
Provider/模型没启用，或 `RIO_AGENT_RUNTIME=mock`。看 Dashboard 顶栏「引擎」。

**CTFd 附件 401/403**  
附件 CDN 和比赛站不同源时，加 `trustedCredentialOrigins`。

**想用公网 IP 打开 Dashboard**  
不要。非 loopback 绑 API 必须带 token，而且 NativeTrusted 下 Agent 就在这台机器上跑。

**要不要 Docker？**  
默认不要。镜像只给可选 Sage。Solver 在宿主机跑。
