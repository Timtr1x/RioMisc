// RioMisc Dashboard — single page with tabs: Overview / Challenges / Detail / Providers.
import { useCallback, useEffect, useState } from "react";
import { api, useEvents, fmtMs, type Status, type ChallengeRow, type ChallengeDetail } from "./api.js";

type Tab = "overview" | "challenges" | "detail" | "providers";

const TAB_LABEL: Record<Tab, string> = {
  overview: "总览",
  challenges: "题目",
  detail: "详情",
  providers: "模型",
};

const STATUS_ZH: Record<string, string> = {
  DISCOVERED: "已发现",
  PREPARING: "准备中",
  READY: "就绪",
  QUEUED: "排队",
  ACTIVE: "解题中",
  VERIFYING: "校验中",
  SUBMITTING: "提交中",
  SOLVED: "已解出",
  PAUSED: "已暂停",
  PARKED: "已搁置",
  UNSUPPORTED: "不支持",
  ERROR: "错误",
  UNKNOWN: "未知",
  ACTIVE_PROGRESS: "进行中",
  STALLED: "停滞",
  LOCKED: "未解锁",
  ELIGIBLE: "可领取",
  FETCHING: "获取中",
  FETCHED: "已获取",
  DECLINED: "已拒绝",
  NOT_SUPPORTED: "不支持",
  HEALTHY: "正常",
  DEGRADED: "降级",
  DOWN: "不可用",
  PENDING: "待确认",
  VERIFIED: "已验证",
  REJECTED_LOCAL: "本地拒绝",
  SUBMITTED: "已提交",
  WRONG: "错误",
  CORRECT: "正确",
  SUBMISSION_UNKNOWN: "结果未知",
  RATE_LIMITED: "限速",
  SENDING: "发送中",
  QUEUED_SUB: "排队提交",
};

function zh(code: string | null | undefined, fallback?: string): string {
  if (!code) return fallback ?? "—";
  return STATUS_ZH[code] ?? fallback ?? code;
}

const HEALTH_CLASS: Record<string, string> = { HEALTHY: "ok", DOWN: "err", DEGRADED: "warn" };

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [status, setStatus] = useState<Status | null>(null);
  const [challenges, setChallenges] = useState<ChallengeRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [events, setEvents] = useState<string[]>([]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  useEffect(() => {
    const tick = () => {
      void api<Status>("/status").then(setStatus).catch(() => setStatus(null));
      void api<ChallengeRow[]>("/challenges").then(setChallenges).catch(() => {});
    };
    tick();
    const timer = setInterval(tick, 2000);
    return () => clearInterval(timer);
  }, [refreshKey]);

  useEffect(() => {
    return useEvents((e) => {
      setEvents((prev) => [new Date(e.createdAt).toLocaleTimeString() + " " + e.type, ...prev].slice(0, 60));
      setRefreshKey((k) => k + 1);
    });
  }, []);

  return (
    <>
      <header>
        <h1>⚡ RioMisc</h1>
        <span className="sub">
          CTF Misc/Crypto 自动解题 · 适配器={status?.adapter ?? "…"} · 引擎={status?.agentRuntime === "pi" ? "真实模型" : status?.agentRuntime === "mock" ? "Mock" : "…"} · 工人 {status?.workers ?? 0}/{status?.workerSlots ?? 0} · 磁盘剩余 {status?.diskFreeGb ?? "…"}GB
        </span>
      </header>
      <nav>
        {(["overview", "challenges", "detail", "providers"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </nav>
      {tab === "overview" && (
        <Overview
          status={status}
          challenges={challenges}
          events={events}
          onStarted={(id) => {
            setSelectedId(id);
            setTab("detail");
            refresh();
          }}
        />
      )}
      {tab === "challenges" && (
        <Challenges
          challenges={challenges}
          onSelect={(id) => {
            setSelectedId(id);
            setTab("detail");
          }}
        />
      )}
      {tab === "detail" && <Detail id={selectedId ?? challenges[0]?.id ?? ""} refresh={refresh} />}
      {tab === "providers" && <Providers refresh={refresh} />}
    </>
  );
}

function Overview({
  status,
  events,
  onStarted,
}: {
  status: Status | null;
  challenges: ChallengeRow[];
  events: string[];
  onStarted: (id: string) => void;
}) {
  const [url, setUrl] = useState("");
  const [taskMsg, setTaskMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [taskBusy, setTaskBusy] = useState(false);

  const startTask = async () => {
    const u = url.trim();
    if (!u) return;
    setTaskBusy(true);
    setTaskMsg(null);
    try {
      const r = await api<{ challengeId: string; title: string; category: string; attachments: number }>("/tasks/from-url", { method: "POST", body: { url: u } });
      setTaskMsg({ ok: true, text: `已开始任务「${r.title}」(${r.category})，附件 ${r.attachments} 个 → ${r.challengeId}` });
      setUrl("");
      onStarted(r.challengeId);
    } catch (e) {
      setTaskMsg({ ok: false, text: String((e as Error).message) });
    } finally {
      setTaskBusy(false);
    }
  };

  if (!status) return <div className="muted">服务器未连接</div>;
  const cards: [string, number | string][] = [
    ["题目总数", status.total],
    ["已解出", status.solved],
    ["解题中", status.active],
    ["排队", status.queued],
    ["准备中", status.preparing],
    ["已暂停", status.paused],
    ["已搁置", status.parked],
    ["不支持", status.unsupported],
    ["错误", status.error],
    ["Misc 已解", status.miscSolved],
    ["Crypto 已解", status.cryptoSolved],
    ["工人", `${status.workers}/${status.workerSlots}`],
  ];
  return (
    <>
      <div className="panel">
        <h3>▶ 开始新任务 — 输入题目网址（自动抓取题面+附件并解题）</h3>
        <form>
          <input
            style={{ flex: 1, minWidth: 320 }}
            placeholder="https://example.com/challenge 或 直接附件链接 .zip/.png/..."
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && startTask()}
          />
          <button type="button" onClick={startTask} disabled={taskBusy}>
            {taskBusy ? "抓取中…" : "开始任务"}
          </button>
        </form>
        {taskMsg && <div className={taskMsg.ok ? "ok" : "err"} style={{ marginTop: 8 }}>{taskMsg.text}</div>}
        {status.agentRuntime === "mock" && (
          <div className="warn" style={{ marginTop: 8 }}>
            当前是 Mock Agent，不会调用大模型。在「模型」页添加 Provider 后重启，就会自动走真实 LLM。
          </div>
        )}
        {status.adapter === "mock" && (
          <div className="warn" style={{ marginTop: 8 }}>
            当前加载了 11 道演示题，会占满 worker。只跑自己的题时把 config/runtime.yaml 的 contest.adapter 设为 none。
          </div>
        )}
      </div>
      <div className="cards">
        {cards.map(([lbl, num]) => (
          <div className="card" key={lbl}>
            <div className="num">{num}</div>
            <div className="lbl">{lbl}</div>
          </div>
        ))}
      </div>
      <div className="detail-grid">
        <div className="panel">
          <h3>模型健康</h3>
          {status.providers.length === 0 && <div className="muted">尚未配置 Provider</div>}
          {status.providers.map((p) => (
            <div key={p.id}>
              {p.name} <span className={`badge ${HEALTH_CLASS[p.health] ?? "warn"}`}>{zh(p.health)}</span>
            </div>
          ))}
        </div>
        <div className="panel">
          <h3>最近事件</h3>
          <div className="timeline">
            {events.length === 0 && <div className="muted">等待事件…</div>}
            {events.map((e, i) => (
              <div key={i} className="muted">{e}</div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

const FILTERS: { value: string; label: string }[] = [
  { value: "ALL", label: "全部" },
  { value: "MISC", label: "MISC" },
  { value: "CRYPTO", label: "CRYPTO" },
  { value: "SOLVED", label: "已解出" },
  { value: "ACTIVE", label: "解题中" },
  { value: "QUEUED", label: "排队" },
  { value: "UNSUPPORTED", label: "不支持" },
  { value: "ERROR", label: "错误" },
];

function Challenges({ challenges, onSelect }: { challenges: ChallengeRow[]; onSelect: (id: string) => void }) {
  const [filter, setFilter] = useState("ALL");
  const rows = challenges.filter((c) => {
    if (filter === "ALL") return true;
    if (filter === "SOLVED") return c.status === "SOLVED";
    if (filter === "ACTIVE") return c.status === "ACTIVE";
    if (filter === "QUEUED") return c.status === "QUEUED";
    return c.category === filter;
  });
  return (
    <>
      <form style={{ marginBottom: 10 }}>
        <label>筛选</label>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </form>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>标题</th>
            <th>类型</th>
            <th>分值</th>
            <th>状态</th>
            <th>优先级</th>
            <th>耗时</th>
            <th>进度</th>
            <th>提示</th>
            <th>错交</th>
            <th>Solver</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className={c.status === "SOLVED" ? "solved" : ""} onClick={() => onSelect(c.id)} style={{ cursor: "pointer" }}>
              <td>{c.id}</td>
              <td>{c.title}</td>
              <td>{c.category}</td>
              <td>{c.score ?? "-"}</td>
              <td><span className={`status s-${c.status}`}>{zh(c.status)}</span>{c.blockedReason ? <span className="err" title={c.blockedReason}> ⚠</span> : null}</td>
              <td>{c.priorityScore ?? "-"}</td>
              <td>{fmtMs(c.elapsedMs)}</td>
              <td>{c.progress === "UNKNOWN" ? "—" : zh(c.progress)}</td>
              <td>{zh(c.hint)}</td>
              <td>{c.wrong}</td>
              <td>{c.solver ?? "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Detail({ id, refresh }: { id: string; refresh: () => void }) {
  const [d, setD] = useState<ChallengeDetail | null>(null);
  const [candidate, setCandidate] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!id) return;
    const load = () => {
      void api<ChallengeDetail>(`/challenges/${id}`).then(setD).catch(() => setD(null));
    };
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [id, refresh]);

  if (!id) return <div className="muted">请先选择一道题</div>;
  if (!d) return <div className="muted">加载中…</div>;

  const act = async (path: string, method = "POST", body?: unknown) => {
    try {
      await api(path, { method, body });
      setErr("");
      refresh();
    } catch (e) {
      setErr(String((e as Error).message));
    }
  };

  return (
    <>
      <div className="panel">
        <h3>{d.title} <span className={`status s-${d.lifecycleStatus}`}>{zh(d.lifecycleStatus)}</span> <span className="badge">{d.category}</span></h3>
        <p>{d.description}</p>
        <div className="buttons">
          {d.lifecycleStatus === "ACTIVE" && <button onClick={() => act(`/challenges/${id}/pause`)}>暂停</button>}
          {(d.lifecycleStatus === "PAUSED") && <button onClick={() => act(`/challenges/${id}/resume`)}>继续</button>}
          {d.lifecycleStatus === "ACTIVE" && <button onClick={() => act(`/challenges/${id}/park`)}>搁置</button>}
          {d.lifecycleStatus === "PARKED" && <button onClick={() => act(`/challenges/${id}/unpark`)}>取消搁置</button>}
          <button onClick={() => act(`/challenges/${id}/restart`)} className="danger">重启 Solver</button>
          <button onClick={() => act(`/challenges/${id}/hint`)}>强制取 Hint</button>
          <button onClick={() => act(`/challenges/${id}/reflection`)}>反思</button>
          <button onClick={() => act(`/challenges/${id}/priority`, "POST", { priority: "HIGH" })}>优先级：高</button>
        </div>
        <form>
          <input placeholder="手动输入候选 Flag" value={candidate} onChange={(e) => setCandidate(e.target.value)} />
          <button type="button" onClick={() => { void act(`/challenges/${id}/candidate`, "POST", { value: candidate, confidence: 0.9, reason: "dashboard 手动候选" }); setCandidate(""); }}>添加候选</button>
        </form>
        {err && <div className="err">{err}</div>}
      </div>

      <div className="detail-grid">
        <div className="panel">
          <h3>附件</h3>
          {d.attachments.map((a) => (
            <div key={a.id}>{a.name} <span className="muted">({a.sizeBytes ?? "?"}B, {a.downloadStatus})</span></div>
          ))}
          {d.attachments.length === 0 && <div className="muted">无</div>}
          <h3 style={{ marginTop: 10 }}>产物</h3>
          {d.artifacts.slice(-10).map((a) => (
            <div key={a.id} className="muted">{a.operation}: {a.path} ({a.size}B)</div>
          ))}
          <h3 style={{ marginTop: 10 }}>官方 Hint</h3>
          {d.hints.map((h, i) => (
            <div key={i} className="warn">💡 {h.content}</div>
          ))}
        </div>

        <div className="panel">
          <h3>最新进度</h3>
          {d.progress.length === 0 && <div className="muted">暂无进度</div>}
          {d.progress.slice(-3).reverse().map((p) => (
            <div key={p.id} style={{ marginBottom: 8 }}>
              <div>{p.summary}</div>
              <div className="muted">置信度={p.confidence} 停滞={p.stalled ? "是" : "否"} · {new Date(p.createdAt).toLocaleTimeString()}</div>
            </div>
          ))}
          <h3 style={{ marginTop: 10 }}>候选 Flag</h3>
          <div className="muted" style={{ marginBottom: 8 }}>
            没有官方裁判时请人工选择：对 → 收题；错 → 告诉 Agent 继续跑。
          </div>
          {d.candidates.map((c) => (
            <div key={c.id} style={{ marginBottom: 6 }}>
              <span className={c.status === "CORRECT" ? "ok" : c.status === "WRONG" ? "err" : ""}>{c.value}</span>{" "}
              <span className="badge">{zh(c.status)}</span> <span className="muted">置信度={c.confidence}</span>
              {c.status !== "WRONG" && (
                <span className="buttons" style={{ display: "inline", marginLeft: 8 }}>
                  {c.status === "VERIFIED" && (
                    <button onClick={() => act(`/challenges/${id}/submit`, "POST", { candidateId: c.id })}>提交裁判</button>
                  )}
                  {c.status !== "CORRECT" && (
                    <button onClick={() => act(`/challenges/${id}/accept`, "POST", { candidateId: c.id })}>对，收题</button>
                  )}
                  <button className="danger" onClick={() => act(`/challenges/${id}/reject`, "POST", { candidateId: c.id })}>
                    错，继续跑
                  </button>
                </span>
              )}
            </div>
          ))}
          {d.candidates.length === 0 && <div className="muted">暂无</div>}
          <h3 style={{ marginTop: 10 }}>提交记录</h3>
          {d.submissions.map((s) => (
            <div key={s.id}>
              <span className={s.status === "CORRECT" ? "ok" : s.status === "WRONG" ? "err" : ""}>{s.flagValue}</span> <span className="badge">{zh(s.status)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>时间线</h3>
        <div className="timeline">
          {d.timeline.map((e) => (
            <div key={e.id ?? e.createdAt + e.type} className="muted">
              {new Date(e.createdAt).toLocaleTimeString()} <b>{e.type}</b>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function Providers({ refresh }: { refresh: () => void }) {
  const [data, setData] = useState<{ providers: { id: string; displayName: string; protocol: string; baseUrl: string; health: string; enabled: number }[]; models: { id: string; providerId: string; modelName: string; role: string }[] } | null>(null);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState("OPENAI_CHAT_COMPLETIONS");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com");
  const [apiKey, setApiKey] = useState("");
  const [modelName, setModelName] = useState("");
  const [msg, setMsg] = useState("");
  useEffect(() => {
    void api("/providers").then(setData).catch(() => {});
  }, [refresh]);

  const addProvider = async () => {
    try {
      await api("/providers", { method: "POST", body: { displayName: name, protocol, baseUrl, apiKey } });
      setName(""); setApiKey("");
      refresh();
    } catch (e) { setMsg(String((e as Error).message)); }
  };
  const addModel = async (providerId: string) => {
    try {
      await api("/models", { method: "POST", body: { providerId, modelName, contextWindow: 200000, maxOutputTokens: 8192 } });
      refresh();
    } catch (e) { setMsg(String((e as Error).message)); }
  };
  const test = async (providerId: string) => {
    try {
      const r = await api<{ result: { authentication: boolean; textApi: boolean; toolCall: boolean; latencyMs: number; message?: string } }>(`/providers/${providerId}/test`, { method: "POST" });
      setMsg(`test: auth=${r.result.authentication} text=${r.result.textApi} tool=${r.result.toolCall} ${r.result.latencyMs}ms${r.result.message ? " · " + r.result.message : ""}`);
      refresh();
    } catch (e) { setMsg(String((e as Error).message)); }
  };

  return (
    <>
      <div className="panel">
        <h3>添加 Provider</h3>
        <form>
          <input placeholder="显示名称" value={name} onChange={(e) => setName(e.target.value)} />
          <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
            <option>OPENAI_CHAT_COMPLETIONS</option>
            <option>OPENAI_RESPONSES</option>
            <option>ANTHROPIC_MESSAGES</option>
          </select>
          <input placeholder="接口地址" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <input placeholder="API Key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <button type="button" onClick={addProvider}>添加 Provider</button>
        </form>
      </div>
      <div className="panel">
        <h3>已配置的 Provider</h3>
        {data?.providers.filter((p) => p.enabled !== 0).map((p) => (
          <div key={p.id} style={{ marginBottom: 8 }}>
            <b>{p.displayName}</b> <span className="badge">{p.protocol}</span> <span className={`badge ${HEALTH_CLASS[p.health] ?? "warn"}`}>{zh(p.health)}</span>
            <span className="muted"> {p.baseUrl}</span>
            <div className="buttons">
              <button onClick={() => test(p.id)}>测试连接</button>
              <button onClick={() => addModel(p.id)}>添加模型（{modelName || "先填模型名"}）</button>
              <input placeholder="模型名称" value={modelName} onChange={(e) => setModelName(e.target.value)} style={{ width: 180 }} />
            </div>
            {data.models.filter((m) => m.providerId === p.id).map((m) => (
              <div key={m.id} className="muted">
                模型：{m.modelName}（{m.role === "PRIMARY" ? "主模型" : m.role === "FALLBACK" ? "备用" : "普通"}）
                {m.role !== "PRIMARY" && (
                  <button style={{ marginLeft: 8 }} onClick={() => void api(`/models/${m.id}/role`, { method: "POST", body: { role: "PRIMARY" } }).then(refresh).catch((e) => setMsg(String((e as Error).message)))}>
                    设为主模型
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
        {data?.providers.length === 0 && <div className="muted">暂无</div>}
      </div>
      {msg && <div className="warn">{msg}</div>}
    </>
  );
}
