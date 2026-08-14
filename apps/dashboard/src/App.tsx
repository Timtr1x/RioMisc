// RioMisc Dashboard — single page with tabs: Overview / Challenges / Detail / Providers.
import { useCallback, useEffect, useState } from "react";
import { api, useEvents, fmtMs, type Status, type ChallengeRow, type ChallengeDetail } from "./api.js";
import { applyTheme, readTheme, type Theme } from "./theme.js";

type Tab = "overview" | "challenges" | "detail" | "providers";

const TAB_LABEL: Record<Tab, string> = {
  overview: "总览",
  challenges: "题目",
  detail: "详情",
  providers: "模型",
};

const LIFECYCLE_ZH: Record<string, string> = {
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
};

const PROGRESS_ZH: Record<string, string> = {
  UNKNOWN: "—",
  ACTIVE: "有进展",
  STALLED: "停滞",
};

const HINT_ZH: Record<string, string> = {
  NOT_SUPPORTED: "不支持 Hint",
  LOCKED: "Hint 未解锁",
  ELIGIBLE: "可取 Hint",
  FETCHING: "正在取 Hint",
  FETCHED: "已有 Hint",
  DECLINED: "无 Hint",
};

const FLAG_ZH: Record<string, string> = {
  PENDING: "待确认",
  VERIFIED: "已验证",
  REJECTED_LOCAL: "本地格式拒绝",
  SUBMITTED: "已提交裁判",
  WRONG: "裁判判错",
  CORRECT: "正确",
  SUBMISSION_UNKNOWN: "结果未知",
  QUEUED: "排队提交",
  SENDING: "发送中",
  RATE_LIMITED: "限速",
  UNKNOWN: "未知",
};

function zhLife(code: string | null | undefined): string {
  if (!code) return "—";
  return LIFECYCLE_ZH[code] ?? code;
}
function zhProgress(code: string | null | undefined): string {
  if (!code) return "—";
  return PROGRESS_ZH[code] ?? code;
}
function zhHint(code: string | null | undefined): string {
  if (!code) return "—";
  return HINT_ZH[code] ?? code;
}
function zhFlag(code: string | null | undefined): string {
  if (!code) return "—";
  return FLAG_ZH[code] ?? code;
}
function zhHealth(code: string | null | undefined): string {
  if (code === "HEALTHY") return "正常";
  if (code === "DEGRADED") return "降级";
  if (code === "DOWN") return "不可用";
  return code ?? "—";
}

const HEALTH_CLASS: Record<string, string> = { HEALTHY: "ok", DOWN: "err", DEGRADED: "warn" };

function shortId(id: string): string {
  if (id.startsWith("ch_url_") && id.length > 18) return `url…${id.slice(-6)}`;
  if (id.length > 18) return `${id.slice(0, 8)}…${id.slice(-4)}`;
  return id;
}

function shortTitle(title: string): string {
  if (title.length > 36 && /^[a-f0-9]{32,}$/i.test(title)) return `${title.slice(0, 10)}…${title.slice(-8)}`;
  return title;
}

function shortPath(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/");
  return parts.length <= 3 ? parts.join("/") : parts.slice(-3).join("/");
}

function contestLabel(status: Status | null): string {
  if (!status) return "…";
  const c = status.contest;
  if (c?.kind === "ctfd" && c.baseUrl) return `CTFd ${c.baseUrl}`;
  if (c?.kind === "mock" || status.adapter === "mock") return "演示赛 Mock";
  if (c?.kind === "local" || status.adapter === "local") return "单题本地";
  return "未接入";
}

function tabFromHash(): Tab {
  const h = window.location.hash.replace("#", "") as Tab;
  return h in TAB_LABEL ? h : "overview";
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.getAttribute("data-theme") as Theme) || readTheme());
  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  };
  return (
    <button type="button" className="ghost" onClick={toggle} aria-pressed={theme === "light"} aria-label={theme === "dark" ? "切换到浅色模式" : "切换到深色模式"}>
      {theme === "dark" ? "浅色模式" : "深色模式"}
    </button>
  );
}

export function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash);
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
      const flag = typeof e.payload?.value === "string" ? ` ${e.payload.value}` : "";
      const failN = typeof e.payload?.consecutiveFailures === "number" ? e.payload.consecutiveFailures : null;
      const failName = typeof e.payload?.name === "string" ? e.payload.name : "模型";
      const err = typeof e.payload?.message === "string" ? String(e.payload.message).slice(0, 80) : "";
      let title = e.type;
      if (e.type === "FLAG_CANDIDATE_FOUND") title = `出 Flag${flag}`;
      else if (e.type === "MODEL_PROVIDER_UNHEALTHY") {
        title = `${failName} API 连续失败 ${failN ?? "多"} 次，已${e.payload?.health === "DOWN" ? "不可用" : "降级"}`;
      } else if (e.type === "SOLVER_ERROR") title = `模型调用失败${err ? "：" + err : ""}`;
      setEvents((prev) => [`${new Date(e.createdAt).toLocaleTimeString()} ${title}`, ...prev].slice(0, 60));
      setRefreshKey((k) => k + 1);
    });
  }, []);

  return (
    <>
      <header className="app-header">
        <div>
          <h1>RioMisc</h1>
          <div className="header-meta">
            <span className="chip">比赛 <b>{contestLabel(status)}</b></span>
            <span className="chip">引擎 <b>{status?.agentRuntime === "pi" ? "真实模型" : status?.agentRuntime === "mock" ? "Mock" : "…"}</b></span>
            <span className="chip">执行 <b>{status?.executionMode === "NATIVE_TRUSTED" ? "Native / Trusted" : status?.executionMode ?? "…"}</b></span>
            <span className="chip">工人 <b>{status?.workers ?? 0}/{status?.workerSlots ?? 0}</b></span>
            <span className="chip">磁盘 <b>{status?.diskFreeGb ?? "…"}GB</b></span>
          </div>
        </div>
        <div className="header-actions">
          <ThemeToggle />
        </div>
      </header>
      <nav>
        {(["overview", "challenges", "detail", "providers"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => { setTab(t); window.location.hash = t; }}>
            {TAB_LABEL[t]}
          </button>
        ))}
      </nav>
      <ProviderHealthBanner
        providers={status?.providers ?? []}
        onOpen={() => {
          setTab("providers");
          window.location.hash = "providers";
        }}
      />
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
          onDeleted={(id) => {
            setSelectedId((cur) => (cur === id ? null : cur));
            refresh();
          }}
        />
      )}
      {tab === "detail" && (
        <Detail
          id={selectedId ?? challenges[0]?.id ?? ""}
          refresh={refresh}
          refreshKey={refreshKey}
          onDeleted={(id) => {
            setSelectedId((cur) => (cur === id ? null : cur));
            setTab("challenges");
            refresh();
          }}
        />
      )}
      {tab === "providers" && <Providers refresh={refresh} refreshKey={refreshKey} />}
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
  const [contestUrl, setContestUrl] = useState("");
  const [contestToken, setContestToken] = useState("");
  const [contestCookie, setContestCookie] = useState("");
  const [contestMsg, setContestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [contestBusy, setContestBusy] = useState(false);

  const contest = status?.contest;
  const connected = contest?.connected === true || status?.adapter === "mock" || status?.adapter === "ctfd";

  const connectContest = async (kind: "mock" | "ctfd") => {
    setContestBusy(true);
    setContestMsg(null);
    try {
      const r = await api<{ kind: string; lastListed: number; baseUrl: string | null }>("/contest/connect", {
        method: "POST",
        body:
          kind === "mock"
            ? { kind: "mock" }
            : { kind: "ctfd", baseUrl: contestUrl.trim(), token: contestToken.trim() || undefined, cookie: contestCookie.trim() || undefined, miscCryptoOnly: true },
      });
      setContestMsg({
        ok: true,
        text: kind === "mock"
          ? `已接入演示比赛，Poller 正在自动拉题（本次列出 ${r.lastListed} 道），Solver 会自动开做并交 flag。`
          : `已接入 ${r.baseUrl ?? contestUrl}，列出 ${r.lastListed} 道 Misc/Crypto，正在自动下载并派工。`,
      });
    } catch (e) {
      setContestMsg({ ok: false, text: String((e as Error).message) });
    } finally {
      setContestBusy(false);
    }
  };

  const disconnectContest = async () => {
    setContestBusy(true);
    setContestMsg(null);
    try {
      await api("/contest/disconnect", { method: "POST" });
      setContestMsg({ ok: true, text: "已断开比赛。已在跑的题会停在当前状态，不会再拉新题。" });
    } catch (e) {
      setContestMsg({ ok: false, text: String((e as Error).message) });
    } finally {
      setContestBusy(false);
    }
  };

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

  if (!status) return <div className="panel empty">服务器未连接。确认 API 已在 127.0.0.1:3000 启动。</div>;
  const pipeline: [string, number | string][] = [
    ["解题中", status.active],
    ["排队", status.queued],
    ["准备中", status.preparing],
    ["已暂停", status.paused],
    ["已搁置", status.parked],
    ["Blocked", status.blocked ?? 0],
    ["Unknown 提交", status.unknownSubmissions ?? 0],
  ];
  const results: [string, number | string][] = [
    ["题目总数", status.total],
    ["已解出", status.solved],
    ["Misc 已解", status.miscSolved],
    ["Crypto 已解", status.cryptoSolved],
    ["不支持", status.unsupported],
    ["错误", status.error],
    ["工人", `${status.workers}/${status.workerSlots}`],
  ];
  return (
    <>
      <div className="panel">
        <h3>接入比赛 — 全自动拉题 / 下载 / 派工 / 交 flag</h3>
        <p className="muted">
          连上之后 Poller 会周期性拉题单，新题自动进解题流水线。没有赛事 API 时先点「接入演示比赛」。
        </p>
        <div className="buttons" style={{ marginTop: 0 }}>
          <button type="button" className="primary" onClick={() => void connectContest("mock")} disabled={contestBusy || connected}>
            {contestBusy && !contestUrl ? "接入中…" : "接入演示比赛（Mock，无需平台）"}
          </button>
          <button type="button" className="danger" onClick={() => void disconnectContest()} disabled={contestBusy || !connected}>
            断开比赛
          </button>
        </div>
        <form className="field-row">
          <div className="field">
            <label htmlFor="contest-url">比赛地址</label>
            <input
              id="contest-url"
              placeholder="https://ctf.example.com"
              value={contestUrl}
              onChange={(e) => setContestUrl(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="contest-token">Access Token（可选）</label>
            <input
              id="contest-token"
              type="password"
              placeholder="Token"
              value={contestToken}
              onChange={(e) => setContestToken(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="contest-cookie">Cookie（可选）</label>
            <input
              id="contest-cookie"
              placeholder="Cookie"
              value={contestCookie}
              onChange={(e) => setContestCookie(e.target.value)}
            />
          </div>
          <button type="button" onClick={() => void connectContest("ctfd")} disabled={contestBusy || !contestUrl.trim()}>
            {contestBusy ? "连接中…" : "接入 CTFd"}
          </button>
        </form>
        <div style={{ marginTop: 8 }}>
          {connected ? (
            <span className="ok">
              已接入：{contestLabel(status)}
              {typeof contest?.lastListed === "number" ? ` · 上次列出 ${contest.lastListed} 道` : ""}
              {contest?.lastPollAt ? ` · 拉取 ${new Date(contest.lastPollAt).toLocaleTimeString()}` : ""}
            </span>
          ) : (
            <span className="muted">当前未接入比赛，只会处理下面粘贴的单题。</span>
          )}
        </div>
        {contest?.lastError && <div className="err" style={{ marginTop: 6 }}>拉取出错：{contest.lastError}</div>}
        {contestMsg && <div className={contestMsg.ok ? "ok" : "err"} style={{ marginTop: 6 }}>{contestMsg.text}</div>}
        {status.agentRuntime === "mock" && (
          <div className="warn" style={{ marginTop: 8 }}>
            当前是 Mock Agent，演示赛会用内置解题器交 flag；要接真实大模型请到「模型」页加 Provider。
          </div>
        )}
      </div>
      <div className="panel">
        <h3>单题模式 — 粘贴一道题的网址（自动抓取题面+附件并解题）</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void startTask();
          }}
        >
          <div className="field">
            <label htmlFor="task-url">题目或附件 URL</label>
            <input
              id="task-url"
              placeholder="https://example.com/challenge 或 直接附件链接 .zip/.png/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <button type="submit" className="primary" disabled={taskBusy}>
            {taskBusy ? "抓取中…" : "开始任务"}
          </button>
        </form>
        {taskMsg && <div className={taskMsg.ok ? "ok" : "err"}>{taskMsg.text}</div>}
      </div>
      <p className="section-label">当前流水线</p>
      <div className="cards">
        {pipeline.map(([lbl, num]) => (
          <div className="card" key={lbl}>
            <div className="num">{num}</div>
            <div className="lbl">{lbl}</div>
          </div>
        ))}
      </div>
      <p className="section-label">累计结果</p>
      <div className="cards">
        {results.map(([lbl, num]) => (
          <div className="card" key={lbl}>
            <div className="num">{num}</div>
            <div className="lbl">{lbl}</div>
          </div>
        ))}
      </div>
      <div className="detail-grid">
        <div className="panel">
          <h3>模型健康</h3>
          {status.providers.length === 0 && <div className="empty">尚未配置 Provider</div>}
          {status.providers.map((p) => (
            <div key={p.id}>
              {p.name} <span className={`badge ${HEALTH_CLASS[p.health] ?? "warn"}`}>{zhHealth(p.health)}</span>
              {(p.consecutiveFailures ?? 0) > 0 && (
                <span className="muted"> · 连续失败 {p.consecutiveFailures} 次</span>
              )}
            </div>
          ))}
        </div>
        <div className="panel">
          <h3>最近事件</h3>
          <div className="timeline">
            {events.length === 0 && <div className="empty">等待事件…</div>}
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

function Challenges({
  challenges,
  onSelect,
  onDeleted,
}: {
  challenges: ChallengeRow[];
  onSelect: (id: string) => void;
  onDeleted: (id: string) => void;
}) {
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
      <form>
        <div className="field" style={{ flex: "0 0 180px" }}>
        <label htmlFor="challenge-filter">筛选</label>
        <select id="challenge-filter" value={filter} onChange={(e) => setFilter(e.target.value)}>
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        </div>
      </form>
      {rows.length === 0 ? (
        <div className="panel empty">没有符合筛选的题目。</div>
      ) : (
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="clip">ID</th>
              <th className="wrap">标题</th>
              <th>类型</th>
              <th>状态</th>
              <th>耗时</th>
              <th className="wrap">Flag</th>
              <th>进度</th>
              <th>错交</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className={c.status === "SOLVED" ? "solved" : ""} onClick={() => onSelect(c.id)} style={{ cursor: "pointer" }}>
                <td className="clip" title={c.id}>{shortId(c.id)}</td>
                <td className="wrap" title={c.title}>{shortTitle(c.title)}</td>
                <td>{c.category}</td>
                <td><span className={`status s-${c.status}`}>{zhLife(c.status)}</span>{c.blockedReason ? <span className="err" title={c.blockedReason}> ⚠</span> : null}</td>
                <td>{fmtMs(c.elapsedMs)}</td>
                <td className="flag-cell">
                  {c.flag ? (
                    <>
                      <span className={c.flagStatus === "CORRECT" || c.flagStatus === "VERIFIED" ? "ok" : ""}>{c.flag}</span>
                      <div className="muted">{zhFlag(c.flagStatus)}{c.flagAt ? ` · ${new Date(c.flagAt).toLocaleTimeString()}` : ""}</div>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>{zhProgress(c.progress)}</td>
                <td>{c.wrong}</td>
                <td>
                  <button
                    className="danger"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!window.confirm(`删除「${c.title}」？会停掉 Solver、清掉 workspace，并且不会再自动拉回。`)) return;
                      void api(`/challenges/${c.id}`, { method: "DELETE" })
                        .then(() => onDeleted(c.id))
                        .catch((err) => window.alert(String((err as Error).message)));
                    }}
                  >
                    删除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </>
  );
}

function Detail({
  id,
  refresh,
  refreshKey,
  onDeleted,
}: {
  id: string;
  refresh: () => void;
  refreshKey: number;
  onDeleted: (id: string) => void;
}) {
  const [d, setD] = useState<ChallengeDetail | null>(null);
  const [candidate, setCandidate] = useState("");
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [reflection, setReflection] = useState<{
    diagnosis: string;
    likelyMistakes: string[];
    missedEvidence: string[];
    recommendedNextSteps: string[];
    injected: boolean;
  } | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    void api<ChallengeDetail>(`/challenges/${id}`)
      .then((row) => {
        setD(row);
        const ev = [...row.timeline].reverse().find((e) => e.type === "REFLECTION_RUN");
        if (ev) {
          try {
            const p = JSON.parse(ev.payloadJson) as {
              diagnosis?: string;
              likelyMistakes?: string[];
              missedEvidence?: string[];
              recommendedNextSteps?: string[];
            };
            setReflection((cur) =>
              cur ?? {
                diagnosis: p.diagnosis ?? "",
                likelyMistakes: p.likelyMistakes ?? [],
                missedEvidence: p.missedEvidence ?? [],
                recommendedNextSteps: p.recommendedNextSteps ?? [],
                injected: true,
              },
            );
          } catch {
            /* ignore */
          }
        }
      })
      .catch(() => setD(null));
  }, [id]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 2000);
    return () => clearInterval(timer);
  }, [load, refreshKey]);

  if (!id) return <div className="panel empty">请先在「题目」里选一道题</div>;
  if (!d) return <div className="panel empty">加载中…</div>;

  const act = async (path: string, method = "POST", body?: unknown) => {
    setBusy(true);
    try {
      const r = await api<Record<string, unknown>>(path, { method, body });
      setErr("");
      if (path.endsWith("/reflection")) {
        setReflection({
          diagnosis: String(r.diagnosis ?? ""),
          likelyMistakes: (r.likelyMistakes as string[]) ?? [],
          missedEvidence: (r.missedEvidence as string[]) ?? [],
          recommendedNextSteps: (r.recommendedNextSteps as string[]) ?? [],
          injected: Boolean(r.injected),
        });
        setNote(r.injected ? "反思已写入 Solver 会话" : "反思已生成，但当前没有活着的 Solver，只记在详情里");
      } else if (path.endsWith("/pause")) {
        setNote("已暂停");
      } else if (path.endsWith("/resume")) {
        setNote("已继续，等待调度");
      } else if (path.endsWith("/park")) {
        setNote("已搁置");
      } else if (path.endsWith("/hint")) {
        setNote(r.hint ? "已获取 Hint" : "Hint 不可用");
      } else {
        setNote("已执行");
      }
      load();
      refresh();
    } catch (e) {
      setErr(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="panel">
        <h3>{d.title} <span className={`status s-${d.lifecycleStatus}`}>{zhLife(d.lifecycleStatus)}</span> <span className="badge">{d.category}</span></h3>
        <p>{d.description}</p>
        <div className="buttons">
          {d.lifecycleStatus === "ACTIVE" && (
            <button disabled={busy} onClick={() => act(`/challenges/${id}/pause`)}>
              暂停
            </button>
          )}
          {d.lifecycleStatus === "PAUSED" && (
            <button disabled={busy} onClick={() => act(`/challenges/${id}/resume`)}>
              继续
            </button>
          )}
          {d.lifecycleStatus === "ACTIVE" && (
            <button disabled={busy} onClick={() => act(`/challenges/${id}/park`)}>
              搁置
            </button>
          )}
          {d.lifecycleStatus === "PARKED" && (
            <button disabled={busy} onClick={() => act(`/challenges/${id}/unpark`)}>
              取消搁置
            </button>
          )}
          <button disabled={busy} onClick={() => act(`/challenges/${id}/restart`)} className="danger">
            重启 Solver
          </button>
          <button disabled={busy} onClick={() => act(`/challenges/${id}/hint`)}>
            强制取 Hint
          </button>
          <button disabled={busy} onClick={() => act(`/challenges/${id}/reflection`)}>
            反思
          </button>
          <button disabled={busy} onClick={() => act(`/challenges/${id}/priority`, "POST", { priority: "HIGH" })}>
            优先级：高
          </button>
          <button
            disabled={busy}
            className="danger"
            onClick={() => {
              if (!window.confirm(`删除「${d.title}」？会停掉 Solver、清掉 workspace，并且不会再自动拉回。`)) return;
              setBusy(true);
              void api(`/challenges/${id}`, { method: "DELETE" })
                .then(() => onDeleted(id))
                .catch((e) => setErr(String((e as Error).message)))
                .finally(() => setBusy(false));
            }}
          >
            删除
          </button>
        </div>
        <form>
          <input placeholder="手动输入候选 Flag" value={candidate} onChange={(e) => setCandidate(e.target.value)} />
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              void act(`/challenges/${id}/candidate`, "POST", { value: candidate, confidence: 0.9, reason: "dashboard 手动候选" });
              setCandidate("");
            }}
          >
            添加候选
          </button>
        </form>
        {note && <div className="ok" style={{ marginTop: 8 }}>{note}</div>}
        {err && <div className="err">{err}</div>}
      </div>

      {d.candidates.length > 0 && (
        <div className="panel flag-banner">
          <h3>Agent 给出了 Flag</h3>
          {[...d.candidates].reverse().slice(0, 3).map((c) => (
            <div key={c.id} style={{ marginBottom: 8 }}>
              <code>{c.value}</code>
              <div className="muted">
                {zhFlag(c.status)} · 置信度={c.confidence} · {new Date(c.createdAt).toLocaleTimeString()}
                {c.reason ? ` · ${c.reason}` : ""}
              </div>
              {c.status !== "WRONG" && c.status !== "CORRECT" && (
                <div className="buttons" style={{ marginTop: 6 }}>
                  {c.status === "VERIFIED" && (
                    <button disabled={busy} onClick={() => act(`/challenges/${id}/submit`, "POST", { candidateId: c.id })}>
                      提交裁判
                    </button>
                  )}
                  <button disabled={busy} onClick={() => act(`/challenges/${id}/accept`, "POST", { candidateId: c.id })}>
                    对，收题
                  </button>
                  <button className="danger" disabled={busy} onClick={() => act(`/challenges/${id}/reject`, "POST", { candidateId: c.id })}>
                    错，继续跑
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {reflection && (
        <div className="panel">
          <h3>反思结果</h3>
          <p>{reflection.diagnosis}</p>
          {reflection.likelyMistakes.length > 0 && (
            <>
              <div className="muted">可能的问题</div>
              <ul>
                {reflection.likelyMistakes.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          )}
          {reflection.missedEvidence.length > 0 && (
            <>
              <div className="muted">可能漏掉的证据</div>
              <ul>
                {reflection.missedEvidence.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </>
          )}
          <div className="muted">建议下一步</div>
          <ul>
            {reflection.recommendedNextSteps.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          <div className={reflection.injected ? "ok" : "warn"}>
            {reflection.injected ? "已注入当前 Solver 会话" : "没有活着的 Solver，反思没有送进模型"}
          </div>
        </div>
      )}

      {(() => {
        const unknownSub = d.submissions.find((s) => s.status === "UNKNOWN" || s.status === "SENDING");
        const unknownCand = d.candidates.find((c) => c.status === "SUBMISSION_UNKNOWN");
        if (!unknownSub && !unknownCand && d.blockedReason !== "SUBMISSION_OUTCOME_UNKNOWN") return null;
        const flag = unknownCand?.value ?? unknownSub?.flagValue ?? "";
        return (
          <div className="panel warn-banner">
            <h3>提交结果未知</h3>
            <p>
              Flag: <code>{flag}</code>
            </p>
            <p>RioMisc 无法确认赛事服务器是否已处理此次提交。系统不会自动重复提交。</p>
            <div className="buttons">
              {unknownCand && (
                <button onClick={() => act(`/challenges/${id}/accept`, "POST", { candidateId: unknownCand.id })}>Mark Correct</button>
              )}
              {unknownCand && (
                <button className="danger" onClick={() => act(`/challenges/${id}/reject`, "POST", { candidateId: unknownCand.id })}>
                  Mark Wrong
                </button>
              )}
              {unknownSub && (
                <button onClick={() => act(`/challenges/${id}/retry-submission`, "POST", { submissionId: unknownSub.id })}>
                  Retry Submission
                </button>
              )}
              <button onClick={() => act(`/challenges/${id}/resume-solving`)}>Resume Solving</button>
            </div>
          </div>
        );
      })()}

      <div className="detail-grid">
        <div className="panel">
          <h3>附件</h3>
          {d.attachments.map((a) => (
            <div key={a.id} className="break">{a.name} <span className="muted">({a.sizeBytes ?? "?"}B, {a.downloadStatus})</span></div>
          ))}
          {d.attachments.length === 0 && <div className="muted">无</div>}
          <h3 style={{ marginTop: 10 }}>产物</h3>
          {d.artifacts.slice(-10).map((a) => (
            <div key={a.id} className="muted break" title={a.path}>{a.operation}: {shortPath(a.path)} ({a.size}B)</div>
          ))}
          <h3 style={{ marginTop: 10 }}>Session</h3>
          {(d.sessions ?? []).length === 0 && <div className="muted">无</div>}
          {(d.sessions ?? []).map((s) => (
            <div key={s.id} className="muted">
              {s.id} · {s.mode === "resumed" ? "resumed" : "fresh"} · {s.providerId ?? "—"} / {s.modelId ?? "—"} · {s.status}
            </div>
          ))}
          <h3 style={{ marginTop: 10 }}>官方 Hint</h3>
          {d.hints.map((h, i) => (
            <div key={i} className="warn">{h.content}</div>
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
              <span className="badge">{zhFlag(c.status)}</span> <span className="muted">置信度={c.confidence}</span>
              {c.status !== "WRONG" && c.status !== "CORRECT" && (
                <span className="buttons" style={{ display: "inline", marginLeft: 8 }}>
                  {c.status === "VERIFIED" && (
                    <button onClick={() => act(`/challenges/${id}/submit`, "POST", { candidateId: c.id })}>提交裁判</button>
                  )}
                  <button onClick={() => act(`/challenges/${id}/accept`, "POST", { candidateId: c.id })}>对，收题</button>
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
              <span className={s.status === "CORRECT" ? "ok" : s.status === "WRONG" ? "err" : ""}>{s.flagValue}</span> <span className="badge">{zhFlag(s.status)}</span>
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

function ProviderHealthBanner({
  providers,
  onOpen,
}: {
  providers: { id: string; name: string; health: string; consecutiveFailures?: number }[];
  onOpen: () => void;
}) {
  const bad = providers.filter((p) => p.health === "DEGRADED" || p.health === "DOWN");
  if (bad.length === 0) return null;
  const down = bad.some((p) => p.health === "DOWN");
  return (
    <div className={`panel ${down ? "danger-banner" : "warn-banner"}`}>
      <h3>模型 API 连续失败</h3>
      {bad.map((p) => (
        <p key={p.id}>
          {p.name} 已连续失败 {p.consecutiveFailures ?? (p.health === "DOWN" ? 5 : 3)} 次，状态：{zhHealth(p.health)}。
          不会自动换备用模型，解题可能卡住。
        </p>
      ))}
      <div className="buttons">
        <button type="button" className="primary" onClick={onOpen}>
          去模型页测试 / 换主模型
        </button>
      </div>
    </div>
  );
}

type ProviderRow = {
  id: string;
  displayName: string;
  protocol: string;
  baseUrl: string;
  health: string;
  consecutiveFailures?: number;
  enabled: number | boolean;
};
type ModelRow = { id: string; providerId: string; modelName: string; role: string; enabled?: number | boolean };

function isOn(v: number | boolean | undefined): boolean {
  return v !== 0 && v !== false;
}

function Providers({ refresh, refreshKey }: { refresh: () => void; refreshKey: number }) {
  const [data, setData] = useState<{ providers: ProviderRow[]; models: ModelRow[] } | null>(null);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState("OPENAI_CHAT_COMPLETIONS");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com");
  const [apiKey, setApiKey] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    void api<{ providers: ProviderRow[]; models: ModelRow[] }>("/providers")
      .then(setData)
      .catch((e) => setMsg({ ok: false, text: String((e as Error).message) }));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const done = () => {
    load();
    refresh();
  };

  const addProvider = async () => {
    if (!name.trim() || !baseUrl.trim() || !apiKey.trim()) {
      setMsg({ ok: false, text: "名称、接口地址和 API Key 都要填" });
      return;
    }
    setBusy(true);
    try {
      await api("/providers", { method: "POST", body: { displayName: name.trim(), protocol, baseUrl: baseUrl.trim(), apiKey } });
      setName("");
      setApiKey("");
      setMsg({ ok: true, text: "Provider 已添加" });
      done();
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const addModel = async (providerId: string) => {
    const modelName = (drafts[providerId] ?? "").trim();
    if (!modelName) {
      setMsg({ ok: false, text: "先填模型名再点添加" });
      return;
    }
    setBusy(true);
    try {
      await api("/models", { method: "POST", body: { providerId, modelName, contextWindow: 200000, maxOutputTokens: 8192 } });
      setDrafts((s) => ({ ...s, [providerId]: "" }));
      setMsg({ ok: true, text: `已添加模型 ${modelName}` });
      done();
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const test = async (providerId: string) => {
    setBusy(true);
    setMsg({ ok: true, text: "正在测试连接…" });
    try {
      const r = await api<{ result: { authentication: boolean; textApi: boolean; toolCall: boolean; latencyMs: number; message?: string } }>(
        `/providers/${providerId}/test`,
        { method: "POST" },
      );
      const ok = r.result.authentication && r.result.textApi && r.result.toolCall;
      setMsg({
        ok,
        text: `测试连接：鉴权=${r.result.authentication} 文本=${r.result.textApi} 工具=${r.result.toolCall} ${r.result.latencyMs}ms${r.result.message ? " · " + r.result.message : ""}`,
      });
      done();
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const setPrimary = async (modelId: string) => {
    setBusy(true);
    try {
      await api(`/models/${modelId}/role`, { method: "POST", body: { role: "PRIMARY" } });
      setMsg({ ok: true, text: "已设为主模型" });
      done();
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const removeProvider = async (id: string, label: string) => {
    if (!window.confirm(`停用 Provider「${label}」？`)) return;
    setBusy(true);
    try {
      await api(`/providers/${id}`, { method: "DELETE" });
      setMsg({ ok: true, text: "已停用 Provider" });
      done();
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const removeModel = async (id: string, label: string) => {
    if (!window.confirm(`移除模型「${label}」？`)) return;
    setBusy(true);
    try {
      await api(`/models/${id}`, { method: "DELETE" });
      setMsg({ ok: true, text: `已移除 ${label}` });
      done();
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const providers = (data?.providers ?? []).filter((p) => isOn(p.enabled));
  const modelsOf = (providerId: string) => (data?.models ?? []).filter((m) => m.providerId === providerId && isOn(m.enabled));

  return (
    <>
      <div className="panel">
        <h3>添加 Provider</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void addProvider();
          }}
        >
          <div className="field">
            <label htmlFor="prov-name">显示名称</label>
            <input id="prov-name" placeholder="opencode" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="prov-protocol">协议</label>
            <select id="prov-protocol" value={protocol} onChange={(e) => setProtocol(e.target.value)}>
              <option>OPENAI_CHAT_COMPLETIONS</option>
              <option>OPENAI_RESPONSES</option>
              <option>ANTHROPIC_MESSAGES</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="prov-url">接口地址</label>
            <input id="prov-url" placeholder="https://api.openai.com" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="prov-key">API Key</label>
            <input id="prov-key" placeholder="sk-…" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
          <button type="submit" className="primary" disabled={busy}>添加 Provider</button>
        </form>
      </div>
      <div className="panel">
        <h3>已配置的 Provider</h3>
        {providers.map((p) => {
          const models = modelsOf(p.id);
          const hasPrimary = models.some((m) => m.role === "PRIMARY");
          return (
            <div key={p.id} style={{ marginBottom: 16 }}>
              <div>
                <b>{p.displayName}</b> <span className="badge">{p.protocol}</span>{" "}
                <span className={`badge ${HEALTH_CLASS[p.health] ?? "warn"}`}>{zhHealth(p.health)}</span>
                {(p.consecutiveFailures ?? 0) > 0 && (
                  <span className={p.health === "DOWN" || p.health === "DEGRADED" ? "warn" : "muted"}>
                    {" "}
                    连续失败 {p.consecutiveFailures} 次
                  </span>
                )}
                <span className="muted break"> {p.baseUrl}</span>
              </div>
              {(p.health === "DEGRADED" || p.health === "DOWN") && (
                <div className={p.health === "DOWN" ? "err" : "warn"}>
                  模型 API 连续失败，当前不会自动切换备用模型。可点「测试连接」或换主模型。
                </div>
              )}
              {!hasPrimary && models.length > 0 && <div className="warn">还没有主模型，调度会用列表里第一个</div>}
              {models.length === 0 && <div className="muted">还没有模型。先填名称再点添加。</div>}
              {models.map((m) => (
                <div key={m.id} style={{ margin: "6px 0" }}>
                  <span className={m.role === "PRIMARY" ? "ok" : ""}>
                    {m.modelName}
                  </span>{" "}
                  <span className="badge">{m.role === "PRIMARY" ? "主模型" : m.role === "FALLBACK" ? "备用" : "普通"}</span>
                  <span className="buttons" style={{ display: "inline", marginLeft: 8 }}>
                    {m.role !== "PRIMARY" && (
                      <button disabled={busy} onClick={() => void setPrimary(m.id)}>
                        设为主模型
                      </button>
                    )}
                    <button className="danger" disabled={busy} onClick={() => void removeModel(m.id, m.modelName)}>
                      移除
                    </button>
                  </span>
                </div>
              ))}
              <form
                className="buttons"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addModel(p.id);
                }}
              >
                <div className="field">
                  <label htmlFor={`model-${p.id}`}>模型名称</label>
                  <input
                    id={`model-${p.id}`}
                    placeholder="deepseek-v4-flash"
                    value={drafts[p.id] ?? ""}
                    onChange={(e) => setDrafts((s) => ({ ...s, [p.id]: e.target.value }))}
                  />
                </div>
                <button type="submit" className="primary" disabled={busy}>添加模型</button>
                <button type="button" disabled={busy} onClick={() => void test(p.id)}>测试连接</button>
                <button type="button" className="danger" disabled={busy} onClick={() => void removeProvider(p.id, p.displayName)}>
                  停用
                </button>
              </form>
            </div>
          );
        })}
        {providers.length === 0 && <div className="muted">暂无可用 Provider</div>}
      </div>
      {msg && <div className={msg.ok ? "ok" : "err"}>{msg.text}</div>}
    </>
  );
}
