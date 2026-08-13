// RioMisc Dashboard — single page with tabs: Overview / Challenges / Detail / Providers.
import { useCallback, useEffect, useRef, useState } from "react";
import { api, useEvents, fmtMs, type Status, type ChallengeRow, type ChallengeDetail } from "./api.js";

type Tab = "overview" | "challenges" | "detail" | "providers";

export function App() {
  const [tab, setTab] = useState<Tab>("overview");
  const [status, setStatus] = useState<Status | null>(null);
  const [challenges, setChallenges] = useState<ChallengeRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [events, setEvents] = useState<string[]>([]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  useEffect(() => {
    void api<Status>("/status").then(setStatus).catch(() => setStatus(null));
    void api<ChallengeRow[]>("/challenges").then(setChallenges).catch(() => {});
  }, [refreshKey, tab]);

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
          CTF Misc/Crypto Autonomous Runtime · adapter={status?.adapter ?? "…"} · agent={status?.agentRuntime ?? "…"} · workers {status?.workers ?? 0}/{status?.workerSlots ?? 0} · disk {status?.diskFreeGb ?? "…"}GB free
        </span>
      </header>
      <nav>
        {(["overview", "challenges", "detail", "providers"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {tab === "overview" && <Overview status={status} challenges={challenges} events={events} />}
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

function Overview({ status, challenges, events }: { status: Status | null; challenges: ChallengeRow[]; events: string[] }) {
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
    } catch (e) {
      setTaskMsg({ ok: false, text: String((e as Error).message) });
    } finally {
      setTaskBusy(false);
    }
  };

  if (!status) return <div className="muted">server not reachable</div>;
  const cards: [string, number | string][] = [
    ["Total", status.total],
    ["Solved", status.solved],
    ["Active", status.active],
    ["Queued", status.queued],
    ["Preparing", status.preparing],
    ["Paused", status.paused],
    ["Parked", status.parked],
    ["Unsupported", status.unsupported],
    ["Errors", status.error],
    ["Misc solved", status.miscSolved],
    ["Crypto solved", status.cryptoSolved],
    ["Workers", `${status.workers}/${status.workerSlots}`],
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
          <h3>Provider health</h3>
          {status.providers.length === 0 && <div className="muted">no providers configured</div>}
          {status.providers.map((p) => (
            <div key={p.id}>
              {p.name} <span className={`badge ${p.health === "HEALTHY" ? "ok" : p.health === "DOWN" ? "err" : "warn"}`}>{p.health}</span>
            </div>
          ))}
        </div>
        <div className="panel">
          <h3>Recent events (SSE)</h3>
          <div className="timeline">
            {events.length === 0 && <div className="muted">waiting for events…</div>}
            {events.map((e, i) => (
              <div key={i} className="muted">{e}</div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}

const FILTERS = ["ALL", "MISC", "CRYPTO", "SOLVED", "ACTIVE", "QUEUED", "UNSUPPORTED", "ERROR"];

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
        <label>Filter</label>
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
      </form>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Title</th>
            <th>Cat</th>
            <th>Score</th>
            <th>Status</th>
            <th>Prio</th>
            <th>Elapsed</th>
            <th>Progress</th>
            <th>Hint</th>
            <th>Wrong</th>
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
              <td><span className={`status s-${c.status}`}>{c.status}</span>{c.blockedReason ? <span className="err" title={c.blockedReason}> ⚠</span> : null}</td>
              <td>{c.priorityScore ?? "-"}</td>
              <td>{fmtMs(c.elapsedMs)}</td>
              <td>{c.progress}</td>
              <td>{c.hint}</td>
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
    void api<ChallengeDetail>(`/challenges/${id}`).then(setD).catch(() => setD(null));
  }, [id, refresh]);

  if (!id) return <div className="muted">select a challenge</div>;
  if (!d) return <div className="muted">loading…</div>;

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
        <h3>{d.title} <span className={`status s-${d.lifecycleStatus}`}>{d.lifecycleStatus}</span> <span className="badge">{d.category}</span></h3>
        <p>{d.description}</p>
        <div className="buttons">
          {d.lifecycleStatus === "ACTIVE" && <button onClick={() => act(`/challenges/${id}/pause`)}>Pause</button>}
          {(d.lifecycleStatus === "PAUSED") && <button onClick={() => act(`/challenges/${id}/resume`)}>Resume</button>}
          {d.lifecycleStatus === "ACTIVE" && <button onClick={() => act(`/challenges/${id}/park`)}>Park</button>}
          {d.lifecycleStatus === "PARKED" && <button onClick={() => act(`/challenges/${id}/unpark`)}>Unpark</button>}
          <button onClick={() => act(`/challenges/${id}/restart`)} className="danger">Restart Solver</button>
          <button onClick={() => act(`/challenges/${id}/hint`)}>Force Hint</button>
          <button onClick={() => act(`/challenges/${id}/reflection`)}>Reflection</button>
          <button onClick={() => act(`/challenges/${id}/priority`, "POST", { priority: "HIGH" })}>Prio HIGH</button>
        </div>
        <form>
          <input placeholder="manual flag candidate" value={candidate} onChange={(e) => setCandidate(e.target.value)} />
          <button type="button" onClick={() => { void act(`/challenges/${id}/candidate`, "POST", { value: candidate, confidence: 0.9, reason: "manual dashboard candidate" }); setCandidate(""); }}>Add Candidate</button>
        </form>
        {err && <div className="err">{err}</div>}
      </div>

      <div className="detail-grid">
        <div className="panel">
          <h3>Attachments</h3>
          {d.attachments.map((a) => (
            <div key={a.id}>{a.name} <span className="muted">({a.sizeBytes ?? "?"}B, {a.downloadStatus})</span></div>
          ))}
          {d.attachments.length === 0 && <div className="muted">none</div>}
          <h3 style={{ marginTop: 10 }}>Artifacts</h3>
          {d.artifacts.slice(-10).map((a) => (
            <div key={a.id} className="muted">{a.operation}: {a.path} ({a.size}B)</div>
          ))}
          <h3 style={{ marginTop: 10 }}>Hints</h3>
          {d.hints.map((h, i) => (
            <div key={i} className="warn">💡 {h.content}</div>
          ))}
        </div>

        <div className="panel">
          <h3>Latest progress</h3>
          {d.progress.length === 0 && <div className="muted">no progress yet</div>}
          {d.progress.slice(-3).reverse().map((p) => (
            <div key={p.id} style={{ marginBottom: 8 }}>
              <div>{p.summary}</div>
              <div className="muted">confidence={p.confidence} stalled={p.stalled ? "yes" : "no"} · {new Date(p.createdAt).toLocaleTimeString()}</div>
            </div>
          ))}
          <h3 style={{ marginTop: 10 }}>Flag candidates</h3>
          {d.candidates.map((c) => (
            <div key={c.id}>
              <span className={c.status === "CORRECT" ? "ok" : c.status === "WRONG" ? "err" : ""}>{c.value}</span>{" "}
              <span className="badge">{c.status}</span> <span className="muted">conf={c.confidence}</span>
              {c.status === "VERIFIED" && <button style={{ marginLeft: 6 }} onClick={() => act(`/challenges/${id}/submit`, "POST", { candidateId: c.id })}>Submit</button>}
            </div>
          ))}
          {d.candidates.length === 0 && <div className="muted">none</div>}
          <h3 style={{ marginTop: 10 }}>Submissions</h3>
          {d.submissions.map((s) => (
            <div key={s.id}>
              <span className={s.status === "CORRECT" ? "ok" : s.status === "WRONG" ? "err" : ""}>{s.flagValue}</span> <span className="badge">{s.status}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3>Timeline</h3>
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
        <h3>Add provider</h3>
        <form>
          <input placeholder="display name" value={name} onChange={(e) => setName(e.target.value)} />
          <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
            <option>OPENAI_CHAT_COMPLETIONS</option>
            <option>OPENAI_RESPONSES</option>
            <option>ANTHROPIC_MESSAGES</option>
          </select>
          <input placeholder="base url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          <input placeholder="api key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <button type="button" onClick={addProvider}>Add Provider</button>
        </form>
      </div>
      <div className="panel">
        <h3>Providers</h3>
        {data?.providers.filter((p) => p.enabled !== 0).map((p) => (
          <div key={p.id} style={{ marginBottom: 8 }}>
            <b>{p.displayName}</b> <span className="badge">{p.protocol}</span> <span className={`badge ${p.health === "HEALTHY" ? "ok" : p.health === "DOWN" ? "err" : "warn"}`}>{p.health}</span>
            <span className="muted"> {p.baseUrl}</span>
            <div className="buttons">
              <button onClick={() => test(p.id)}>Test Connection</button>
              <button onClick={() => addModel(p.id)}>Add Model ({modelName || "model name"})</button>
              <input placeholder="model name" value={modelName} onChange={(e) => setModelName(e.target.value)} style={{ width: 180 }} />
            </div>
            {data.models.filter((m) => m.providerId === p.id).map((m) => (
              <div key={m.id} className="muted">model: {m.modelName} ({m.role})</div>
            ))}
          </div>
        ))}
        {data?.providers.length === 0 && <div className="muted">none</div>}
      </div>
      {msg && <div className="warn">{msg}</div>}
    </>
  );
}
