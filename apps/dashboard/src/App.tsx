// RioMisc Dashboard — single page with tabs: Overview / Challenges / Detail / Providers.
import { useCallback, useEffect, useState } from "react";
import { api, useEvents, fmtMs, type Status, type ChallengeRow, type ChallengeDetail, type VisualReviewRow, type OrchestrationStatus, type ManagerPlanRow, type ChallengeOrchestrationView, type ReflectionRunRow } from "./api.js";
import { applyTheme, readTheme, type Theme } from "./theme.js";

type Tab = "overview" | "challenges" | "detail" | "orchestration" | "providers" | "reviews" | "benchmark";

const TAB_LABEL: Record<Tab, string> = {
  overview: "总览",
  challenges: "题目",
  detail: "详情",
  orchestration: "调度",
  providers: "模型",
  reviews: "视觉复核",
  benchmark: "评测",
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

function zhReflectTrigger(code: string | null | undefined): string {
  if (code === "manual") return "手动";
  if (code === "solver_request") return "Solver 请求";
  if (code === "wrong_flag") return "错 Flag";
  if (code === "no_signal_streak") return "连续无信号";
  if (code === "tool_repetition") return "重复实验";
  if (code === "stalled" || code === "stalled_120s") return "停滞";
  return code || "自动";
}

type ReflectionView = {
  createdAt: number;
  trigger: string;
  diagnosis: string;
  likelyMistakes: string[];
  missedEvidence: string[];
  recommendedNextSteps: string[];
  injected: boolean | null;
};

function pickLatestReflection(timeline: { type: string; createdAt: number; payloadJson: string }[]): ReflectionView | null {
  let latest: { type: string; createdAt: number; payloadJson: string } | null = null;
  for (const ev of timeline) {
    if (ev.type !== "REFLECTION_RUN") continue;
    if (!latest || ev.createdAt > latest.createdAt) latest = ev;
  }
  if (!latest) return null;
  try {
    const p = JSON.parse(latest.payloadJson) as {
      trigger?: string;
      diagnosis?: string;
      likelyMistakes?: string[];
      missedEvidence?: string[];
      recommendedNextSteps?: string[];
      injected?: boolean;
    };
    return {
      createdAt: latest.createdAt,
      trigger: typeof p.trigger === "string" ? p.trigger : "",
      diagnosis: p.diagnosis ?? "",
      likelyMistakes: p.likelyMistakes ?? [],
      missedEvidence: p.missedEvidence ?? [],
      recommendedNextSteps: p.recommendedNextSteps ?? [],
      injected: typeof p.injected === "boolean" ? p.injected : null,
    };
  } catch {
    return null;
  }
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

function parseJsonList(raw?: string): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function artifactTree(arts: { id: string; path: string; operation: string; parentArtifactId?: string | null }[]): string[] {
  const byParent = new Map<string | null, typeof arts>();
  for (const a of arts) {
    const k = a.parentArtifactId ?? null;
    const list = byParent.get(k) ?? [];
    list.push(a);
    byParent.set(k, list);
  }
  const lines: string[] = [];
  const walk = (parent: string | null, prefix: string) => {
    for (const a of byParent.get(parent) ?? []) {
      lines.push(`${prefix}${a.operation} → ${shortPath(a.path)}`);
      walk(a.id, `${prefix}  `);
    }
  };
  walk(null, "");
  if (lines.length === 0) {
    return arts.map((a) => `${a.operation} → ${shortPath(a.path)}`);
  }
  return lines;
}

function contestLabel(status: Status | null): string {
  if (!status) return "…";
  const c = status.contest;
  if (c?.kind === "dasctf" && c.baseUrl) return `DASCTF ${c.baseUrl}`;
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
        {(["overview", "challenges", "detail", "orchestration", "providers", "reviews", "benchmark"] as Tab[]).map((t) => (
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
      {tab === "orchestration" && <OrchestrationPanel refreshKey={refreshKey} onOpenChallenge={(id) => { setSelectedId(id); setTab("detail"); }} />}
      {tab === "providers" && <Providers refresh={refresh} refreshKey={refreshKey} />}
      {tab === "reviews" && <VisualReviews refreshKey={refreshKey} onOpenChallenge={(id) => { setSelectedId(id); setTab("detail"); }} />}
      {tab === "benchmark" && <BenchmarkPanel refreshKey={refreshKey} />}
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
  const [contestOrigins, setContestOrigins] = useState("");
  const [contestMsg, setContestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [contestBusy, setContestBusy] = useState(false);

  const contest = status?.contest;
  const connected =
    contest?.connected === true ||
    status?.adapter === "mock" ||
    status?.adapter === "ctfd" ||
    status?.adapter === "dasctf";

  const connectContest = async (kind: "mock" | "ctfd" | "dasctf") => {
    setContestBusy(true);
    setContestMsg(null);
    try {
      const r = await api<{ kind: string; lastListed: number; baseUrl: string | null }>("/contest/connect", {
        method: "POST",
        body:
          kind === "mock"
            ? { kind: "mock" }
            : {
                kind,
                baseUrl: contestUrl.trim(),
                token: contestToken.trim() || undefined,
                cookie: kind === "ctfd" ? contestCookie.trim() || undefined : undefined,
                miscCryptoOnly: true,
                trustedCredentialOrigins: contestOrigins.trim() || undefined,
              },
      });
      setContestMsg({
        ok: true,
        text: kind === "mock"
          ? `已接入演示比赛，Poller 正在自动拉题（本次列出 ${r.lastListed} 道），Solver 会自动开做并交 flag。`
          : `已接入 ${kind.toUpperCase()} ${r.baseUrl ?? contestUrl}，列出 ${r.lastListed} 道 Misc/Crypto，正在自动下载并派工。`,
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
          连上之后 Poller 会周期性拉题单，新题自动进解题流水线。DASCTF Agent 赛填平台 Host + AccessKey（不是大模型 Key）。
          没有赛事 API 时先点「接入演示比赛」。附件 CDN 需要带凭证时，填「信任的附件域名」。
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
              placeholder="https://pro.dasctf.com 或 CTFd 地址"
              value={contestUrl}
              onChange={(e) => setContestUrl(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="contest-token">AccessKey / Token</label>
            <input
              id="contest-token"
              type="password"
              placeholder="DASCTF: ak_live_… / CTFd: Token"
              value={contestToken}
              onChange={(e) => setContestToken(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="contest-cookie">Cookie（仅 CTFd 可选）</label>
            <input
              id="contest-cookie"
              placeholder="Cookie"
              value={contestCookie}
              onChange={(e) => setContestCookie(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="contest-origins">信任的附件域名（可选）</label>
            <input
              id="contest-origins"
              placeholder="https://files.ctf.example.com"
              value={contestOrigins}
              onChange={(e) => setContestOrigins(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="primary"
            onClick={() => void connectContest("dasctf")}
            disabled={contestBusy || !contestUrl.trim() || !contestToken.trim()}
          >
            {contestBusy ? "连接中…" : "接入 DASCTF Agent"}
          </button>
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
              {contest?.trustedCredentialOrigins && contest.trustedCredentialOrigins.length > 0
                ? ` · 信任域名 ${contest.trustedCredentialOrigins.join(", ")}`
                : ""}
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
  const [reflection, setReflection] = useState<ReflectionView | null>(null);

  const load = useCallback(() => {
    if (!id) return;
    void api<ChallengeDetail>(`/challenges/${id}`)
      .then((row) => {
        setD(row);
        const next = pickLatestReflection(row.timeline);
        if (next) setReflection(next);
      })
      .catch(() => setD(null));
  }, [id]);

  useEffect(() => {
    setReflection(null);
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
          createdAt: Date.now(),
          trigger: "manual",
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
      <ChallengeOrchestrationCard id={id} refreshKey={refreshKey} />

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
          <p className="muted">
            {zhReflectTrigger(reflection.trigger)}
            {reflection.createdAt ? ` · ${new Date(reflection.createdAt).toLocaleString()}` : ""}
          </p>
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
          <div className={reflection.injected === false ? "warn" : "ok"}>
            {reflection.injected === false
              ? "没有活着的 Solver，反思没有送进模型"
              : reflection.injected === true
                ? "已注入当前 Solver 会话"
                : "已写入时间线"}
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
          <h3 style={{ marginTop: 10 }}>假设</h3>
          {(d.hypotheses ?? []).length === 0 && <div className="muted">无</div>}
          {(d.hypotheses ?? []).map((h) => (
            <div key={h.id} style={{ marginBottom: 6 }}>
              <div>{h.status} · 置信度={h.confidence} · {h.description}</div>
              {parseJsonList(h.evidenceForJson).length > 0 && <div className="ok">正：{parseJsonList(h.evidenceForJson).join("；")}</div>}
              {parseJsonList(h.evidenceAgainstJson).length > 0 && <div className="err">反：{parseJsonList(h.evidenceAgainstJson).join("；")}</div>}
            </div>
          ))}
          <h3 style={{ marginTop: 10 }}>CryptoState</h3>
          {!d.cryptoState && <div className="muted">无</div>}
          {d.cryptoState && (
            <div style={{ marginBottom: 8 }}>
              <div>primitive=<b>{d.cryptoState.primitive}</b></div>
              {d.cryptoState.unknownVariables && d.cryptoState.unknownVariables.length > 0 && (
                <div className="muted">unknown: {d.cryptoState.unknownVariables.join(", ")}</div>
              )}
              {d.cryptoState.knownVariables && Object.keys(d.cryptoState.knownVariables).length > 0 && (
                <div className="break">
                  known: {Object.entries(d.cryptoState.knownVariables).map(([k, v]) => `${k}=${String(v.value).slice(0, 48)}`).join(" · ")}
                </div>
              )}
              {(d.cryptoState.attackCandidates ?? []).slice(0, 6).map((c) => (
                <div key={c.id} className="muted">{c.status} {c.attack} conf={c.confidence} cost={c.estimatedCost}</div>
              ))}
              {(d.cryptoState.attempts ?? []).slice(-4).map((a) => (
                <div key={a.id} className="break">{a.outcome} {a.attack}{a.tool ? `/${a.tool}` : ""}: {a.summary}</div>
              ))}
            </div>
          )}
          <h3 style={{ marginTop: 10 }}>实验账本</h3>
          {(d.experiments ?? []).length === 0 && <div className="muted">无</div>}
          {(d.experiments ?? []).slice(-8).map((e) => (
            <div key={e.id} className="muted break">{e.tool} → {e.outcome}: {e.resultSummary}{e.canonicalArgs ? ` · ${e.canonicalArgs}` : ""}</div>
          ))}
          <h3 style={{ marginTop: 10 }}>专家结论</h3>
          {(d.specialists ?? []).length === 0 && <div className="muted">无</div>}
          {(d.specialists ?? []).map((s) => (
            <div key={s.id}>
              {s.kind}: {s.conclusion}
              {parseJsonList(s.recommendedActionsJson).length > 0 && (
                <div className="muted">建议：{parseJsonList(s.recommendedActionsJson).join("，")}</div>
              )}
            </div>
          ))}
          <h3 style={{ marginTop: 10 }}>产物图</h3>
          {artifactTree(d.artifacts).map((line, i) => (
            <div key={i} className="muted break">{line}</div>
          ))}
          <h3 style={{ marginTop: 10 }}>视觉证据</h3>
          {(d.visualEvidence ?? []).length === 0 && <div className="muted">还没有 analyze_visual 结果</div>}
          {(d.visualEvidence ?? []).map((e) => (
            <div key={e.id} style={{ marginBottom: 8 }}>
              <div>{e.summary}</div>
              <div className="muted">{e.analyzer} · 置信度={e.confidence}</div>
              {e.observations?.filter((o) => o.type === "QR" && o.value).map((o, i) => (
                <div key={i} className="ok">QR: {o.value}</div>
              ))}
            </div>
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
type ModelCapabilities = { text: boolean; toolCalling: boolean; vision: boolean; reasoning: boolean; structuredOutput: boolean };
type ModelAssignments = {
  primarySolverModelId: string | null;
  reflectionModelId: string | null;
  visionModelId: string | null;
  triageModelId: string | null;
  managerModelId: string | null;
};
type ModelRow = {
  id: string;
  providerId: string;
  modelName: string;
  role: string;
  enabled?: number | boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  capabilities?: ModelCapabilities;
};

type ModelAddDraft = {
  name: string;
  contextWindow: string;
  maxOutputTokens: string;
  vision: boolean;
};

const DEFAULT_CONTEXT_WINDOW = 320000;
const DEFAULT_MAX_OUTPUT_TOKENS = 320000;

function emptyModelDraft(): ModelAddDraft {
  return {
    name: "",
    contextWindow: String(DEFAULT_CONTEXT_WINDOW),
    maxOutputTokens: String(DEFAULT_MAX_OUTPUT_TOKENS),
    vision: false,
  };
}

function parseLimit(raw: string, min: number, max: number): number | null {
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function isOn(v: number | boolean | undefined): boolean {
  return v !== 0 && v !== false;
}

function ChallengeOrchestrationCard({ id, refreshKey }: { id: string; refreshKey: number }) {
  const [orch, setOrch] = useState<ChallengeOrchestrationView | null>(null);
  const [runs, setRuns] = useState<ReflectionRunRow[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!id) return;
    void api<ChallengeOrchestrationView>(`/challenges/${id}/orchestration`).then(setOrch).catch(() => setOrch(null));
    void api<{ items: ReflectionRunRow[] }>(`/challenges/${id}/reflections`).then((r) => setRuns(r.items)).catch(() => setRuns([]));
  }, [id]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const patch = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api(`/challenges/${id}/orchestration`, { method: "PATCH", body });
      load();
    } finally {
      setBusy(false);
    }
  };

  if (!orch) return null;
  return (
    <div className="panel">
      <h3>调度 / Reflection</h3>
      <p>
        Manager 决策 <b>{orch.managerAction ?? "—"}</b> · 优先级 <b>{orch.managerPriority ?? "—"}</b>
      </p>
      <p className="muted">{orch.managerReason ?? "尚无 Manager 理由"}</p>
      <p>
        Strategy Lock <b>{orch.strategyLocked ? "ON" : "OFF"}</b> · Dispatch <b>{orch.manualDispatch}</b> · Reflection{" "}
        <b>{orch.reflectionEnabled ? "ON" : "OFF"} / {orch.reflectionMode ?? "—"}</b>
      </p>
      <div className="buttons">
        <button type="button" disabled={busy} onClick={() => void patch({ strategyLocked: !orch.strategyLocked })}>
          {orch.strategyLocked ? "Unlock" : "Lock Strategy"}
        </button>
        <button type="button" disabled={busy} onClick={() => void patch({ manualDispatch: "AUTO" })}>Auto</button>
        <button type="button" disabled={busy} onClick={() => void patch({ manualDispatch: "FORCE_START" })}>Force Start</button>
        <button type="button" disabled={busy} onClick={() => void patch({ manualDispatch: "FORCE_HOLD" })}>Force Hold</button>
        <button type="button" disabled={busy} onClick={() => void patch({ reflectionOverride: "ON" })}>Reflection On</button>
        <button type="button" disabled={busy} onClick={() => void patch({ reflectionOverride: "OFF" })}>Reflection Off</button>
        <button type="button" disabled={busy} onClick={() => void patch({ reflectionModeOverride: "HEURISTIC" })}>Heuristic</button>
        <button type="button" disabled={busy} onClick={() => void patch({ reflectionModeOverride: "LLM" })}>LLM</button>
        <button type="button" disabled={busy} onClick={() => void patch({ reflectionModeOverride: "HYBRID" })}>Hybrid</button>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api(`/challenges/${id}/reflection/run`, { method: "POST", body: {} }).finally(() => {
              setBusy(false);
              load();
            });
          }}
        >
          Reflect Now
        </button>
      </div>
      <h4>Reflection History</h4>
      {runs.length === 0 && <div className="muted">还没有反思记录</div>}
      {runs.slice(0, 8).map((r) => {
        let diagnosis = r.error ?? "";
        try {
          if (r.resultJson) diagnosis = String((JSON.parse(r.resultJson) as { diagnosis?: string }).diagnosis ?? diagnosis);
        } catch {
          /* ignore */
        }
        return (
          <div key={r.id} className="muted" style={{ marginBottom: 6 }}>
            {new Date(r.createdAt).toLocaleTimeString()} {r.trigger} · {r.mode}/{r.status}
            {diagnosis ? ` · ${diagnosis.slice(0, 160)}` : ""}
          </div>
        );
      })}
    </div>
  );
}

function OrchestrationPanel({ refreshKey, onOpenChallenge }: { refreshKey: number; onOpenChallenge: (id: string) => void }) {
  const [status, setStatus] = useState<OrchestrationStatus | null>(null);
  const [plans, setPlans] = useState<ManagerPlanRow[]>([]);
  const [openPlan, setOpenPlan] = useState<string | null>(null);
  const [challenges, setChallenges] = useState<ChallengeRow[]>([]);
  const [err, setErr] = useState("");

  const load = useCallback(() => {
    void api<OrchestrationStatus>("/orchestration/status").then(setStatus).catch((e) => setErr(String((e as Error).message)));
    void api<{ items: ManagerPlanRow[] }>("/orchestration/plans").then((r) => setPlans(r.items)).catch(() => {});
    void api<ChallengeRow[]>("/challenges").then(setChallenges).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [load, refreshKey]);

  const setMode = async (managerMode: string) => {
    await api("/orchestration/settings", { method: "PATCH", body: { managerMode } });
    load();
  };

  const health = status?.health ?? "OFF";
  const active = challenges.filter((c) => c.status === "ACTIVE");
  const queued = challenges.filter((c) => c.status === "QUEUED");

  return (
    <>
      <div className="panel" data-testid="orchestration-status">
        <h3>Manager 调度</h3>
        <div className="header-meta">
          <span className="chip">状态 <b>{health}</b></span>
          <span className="chip">模式 <b>{status?.mode ?? "…"}</b></span>
          <span className="chip">模型 <b>{status?.modelId ?? "未指定"}</b></span>
          <span className="chip">Solver <b>{status?.solverSlots.used ?? 0}/{status?.solverSlots.total ?? 0}</b></span>
          <span className="chip">Reflection <b>{status?.reflectionSlots.used ?? 0}/{status?.reflectionSlots.total ?? 0}</b></span>
          <span className="chip">上次 <b>{status?.lastReplanAt ? `${Math.round((Date.now() - status.lastReplanAt) / 1000)}s 前` : "—"}</b></span>
        </div>
        <p className="muted">
          触发 {status?.lastTrigger ?? "—"} · 计划 {status?.livePlanFresh ? "有效" : "过期/无"} · in-flight {status?.inFlight ?? 0}
          {status?.fallback ? " · 已回退确定性调度" : ""}
        </p>
        <div className="buttons">
          <button type="button" onClick={() => void setMode("OFF")}>OFF</button>
          <button type="button" onClick={() => void setMode("SHADOW")}>SHADOW</button>
          <button type="button" onClick={() => void setMode("ACTIVE")}>ACTIVE</button>
          <button type="button" className="primary" onClick={() => void api("/orchestration/replan", { method: "POST" }).then(load)}>立刻 Replan</button>
        </div>
        {err && <div className="err">{err}</div>}
      </div>
      <div className="panel">
        <h3>Active Solvers</h3>
        <table>
          <thead>
            <tr><th>题目</th><th>分类</th><th>分</th><th>进展</th><th>决策</th></tr>
          </thead>
          <tbody>
            {active.map((c) => (
              <tr key={c.id} onClick={() => onOpenChallenge(c.id)} style={{ cursor: "pointer" }}>
                <td>{shortTitle(c.title)}</td>
                <td>{c.category}</td>
                <td>{c.score ?? "—"}</td>
                <td>{zhProgress(c.progress)}</td>
                <td>CONTINUE</td>
              </tr>
            ))}
            {active.length === 0 && <tr><td colSpan={5} className="muted">没有正在解的题</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h3>Queue</h3>
        <table>
          <thead>
            <tr><th>题目</th><th>分</th><th>优先级</th><th>状态</th></tr>
          </thead>
          <tbody>
            {queued.slice(0, 20).map((c) => (
              <tr key={c.id} onClick={() => onOpenChallenge(c.id)} style={{ cursor: "pointer" }}>
                <td>{shortTitle(c.title)}</td>
                <td>{c.score ?? "—"}</td>
                <td>{c.priorityScore ?? "—"}</td>
                <td>{zhLife(c.status)}</td>
              </tr>
            ))}
            {queued.length === 0 && <tr><td colSpan={4} className="muted">队列为空</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="panel">
        <h3>Plan History</h3>
        {plans.map((p) => (
          <div key={p.id} style={{ marginBottom: 10 }}>
            <button type="button" className="ghost" onClick={() => setOpenPlan(openPlan === p.id ? null : p.id)}>
              {new Date(p.createdAt).toLocaleTimeString()} · {p.trigger} · {p.status} · {p.modelId ?? "—"} · {p.durationMs}ms
            </button>
            {openPlan === p.id && (
              <ul>
                {(p.decisions ?? []).map((d) => (
                  <li key={`${p.id}-${d.challengeId}`}>
                    {d.action} {d.challengeId} p={d.priority} ({d.status}{d.rejectionReason ? ` ${d.rejectionReason}` : ""}): {d.reason}
                  </li>
                ))}
                {(p.decisions ?? []).length === 0 && <li className="muted">无逐条决策</li>}
              </ul>
            )}
          </div>
        ))}
        {plans.length === 0 && <div className="muted">还没有 Manager 计划</div>}
      </div>
    </>
  );
}

function Providers({ refresh, refreshKey }: { refresh: () => void; refreshKey: number }) {
  const [data, setData] = useState<{ providers: ProviderRow[]; models: ModelRow[]; assignments?: ModelAssignments } | null>(null);
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState("OPENAI_CHAT_COMPLETIONS");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com");
  const [apiKey, setApiKey] = useState("");
  const [drafts, setDrafts] = useState<Record<string, ModelAddDraft>>({});
  const [limitEdits, setLimitEdits] = useState<Record<string, { contextWindow: string; maxOutputTokens: string }>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const draftOf = (providerId: string): ModelAddDraft => drafts[providerId] ?? emptyModelDraft();
  const patchDraft = (providerId: string, patch: Partial<ModelAddDraft>) => {
    setDrafts((s) => ({ ...s, [providerId]: { ...emptyModelDraft(), ...s[providerId], ...patch } }));
  };

  const load = useCallback(() => {
    void api<{ providers: ProviderRow[]; models: ModelRow[]; assignments?: ModelAssignments }>("/providers")
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
    const draft = draftOf(providerId);
    const modelName = draft.name.trim();
    if (!modelName) {
      setMsg({ ok: false, text: "先填模型名再点添加" });
      return;
    }
    const contextWindow = parseLimit(draft.contextWindow, 1024, 10_000_000);
    const maxOutputTokens = parseLimit(draft.maxOutputTokens, 64, 1_000_000);
    if (contextWindow === null) {
      setMsg({ ok: false, text: "上下文窗口须为 1024–10000000 的整数" });
      return;
    }
    if (maxOutputTokens === null) {
      setMsg({ ok: false, text: "最大输出 token 须为 64–1000000 的整数" });
      return;
    }
    setBusy(true);
    try {
      await api("/models", {
        method: "POST",
        body: {
          providerId,
          modelName,
          contextWindow,
          maxOutputTokens,
          capabilities: draft.vision ? { vision: true } : undefined,
        },
      });
      setDrafts((s) => ({ ...s, [providerId]: emptyModelDraft() }));
      setMsg({ ok: true, text: `已添加模型 ${modelName}` });
      done();
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message) });
    } finally {
      setBusy(false);
    }
  };

  const saveModelLimits = async (model: ModelRow) => {
    const edit = limitEdits[model.id] ?? {
      contextWindow: String(model.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
      maxOutputTokens: String(model.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS),
    };
    const contextWindow = parseLimit(edit.contextWindow, 1024, 10_000_000);
    const maxOutputTokens = parseLimit(edit.maxOutputTokens, 64, 1_000_000);
    if (contextWindow === null) {
      setMsg({ ok: false, text: "上下文窗口须为 1024–10000000 的整数" });
      return;
    }
    if (maxOutputTokens === null) {
      setMsg({ ok: false, text: "最大输出 token 须为 64–1000000 的整数" });
      return;
    }
    setBusy(true);
    try {
      await api(`/models/${model.id}`, { method: "PATCH", body: { contextWindow, maxOutputTokens } });
      setMsg({ ok: true, text: `已更新 ${model.modelName} 的 token 上限` });
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
      const r = await api<{ result: { authentication: boolean; textApi: boolean; toolCall: boolean; visionApi?: boolean | null; latencyMs: number; message?: string } }>(
        `/providers/${providerId}/test`,
        { method: "POST" },
      );
      const ok = r.result.authentication && r.result.textApi && r.result.toolCall && r.result.visionApi !== false;
      const visionBit = r.result.visionApi === null || r.result.visionApi === undefined ? "跳过" : r.result.visionApi ? "OK" : "失败";
      setMsg({
        ok,
        text: `测试连接：鉴权=${r.result.authentication} 文本=${r.result.textApi} 工具=${r.result.toolCall} 视觉=${visionBit} ${r.result.latencyMs}ms${r.result.message ? " · " + r.result.message : ""}`,
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

  const setAssignment = async (slot: keyof ModelAssignments, modelId: string | null) => {
    setBusy(true);
    try {
      await api("/models/assignments", { method: "PUT", body: { [slot]: modelId } });
      setMsg({ ok: true, text: "已更新模型分配" });
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
              {models.map((m) => {
                const edit = limitEdits[m.id] ?? {
                  contextWindow: String(m.contextWindow ?? DEFAULT_CONTEXT_WINDOW),
                  maxOutputTokens: String(m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS),
                };
                return (
                  <div key={m.id} style={{ margin: "6px 0" }}>
                    <span className={m.role === "PRIMARY" ? "ok" : ""}>
                      {m.modelName}
                    </span>{" "}
                    <span className="badge">{m.role === "PRIMARY" ? "主模型" : m.role === "FALLBACK" ? "备用" : "普通"}</span>
                    {m.capabilities?.vision && <span className="badge">视觉能力</span>}
                    {m.capabilities?.reasoning && <span className="badge">推理</span>}
                    <span className="muted">
                      {" "}
                      窗口 {m.contextWindow ?? "?"} · 输出 {m.maxOutputTokens ?? "?"}
                    </span>
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
                    <div className="field-row" style={{ marginTop: 6 }}>
                      <div className="field">
                        <label htmlFor={`edit-ctx-${m.id}`}>上下文窗口</label>
                        <input
                          id={`edit-ctx-${m.id}`}
                          type="number"
                          min={1024}
                          max={10000000}
                          value={edit.contextWindow}
                          onChange={(e) =>
                            setLimitEdits((s) => ({
                              ...s,
                              [m.id]: { ...edit, contextWindow: e.target.value },
                            }))
                          }
                        />
                      </div>
                      <div className="field">
                        <label htmlFor={`edit-out-${m.id}`}>最大输出 token</label>
                        <input
                          id={`edit-out-${m.id}`}
                          type="number"
                          min={64}
                          max={1000000}
                          value={edit.maxOutputTokens}
                          onChange={(e) =>
                            setLimitEdits((s) => ({
                              ...s,
                              [m.id]: { ...edit, maxOutputTokens: e.target.value },
                            }))
                          }
                        />
                      </div>
                      <button type="button" disabled={busy} onClick={() => void saveModelLimits(m)}>
                        保存上限
                      </button>
                    </div>
                  </div>
                );
              })}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void addModel(p.id);
                }}
              >
                <div className="field-row">
                  <div className="field">
                    <label htmlFor={`model-${p.id}`}>模型名称</label>
                    <input
                      id={`model-${p.id}`}
                      placeholder="deepseek-v4-flash"
                      value={draftOf(p.id).name}
                      onChange={(e) => patchDraft(p.id, { name: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`model-ctx-${p.id}`}>上下文窗口</label>
                    <input
                      id={`model-ctx-${p.id}`}
                      type="number"
                      min={1024}
                      max={10000000}
                      value={draftOf(p.id).contextWindow}
                      onChange={(e) => patchDraft(p.id, { contextWindow: e.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor={`model-out-${p.id}`}>最大输出 token</label>
                    <input
                      id={`model-out-${p.id}`}
                      type="number"
                      min={64}
                      max={1000000}
                      value={draftOf(p.id).maxOutputTokens}
                      onChange={(e) => patchDraft(p.id, { maxOutputTokens: e.target.value })}
                    />
                  </div>
                </div>
                <p className="muted">默认 320000，可按模型改。新上限要重启 Solver 才生效。</p>
                <div className="buttons">
                  <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={draftOf(p.id).vision}
                      onChange={(e) => patchDraft(p.id, { vision: e.target.checked })}
                    />
                    具备视觉能力
                  </label>
                  <button type="submit" className="primary" disabled={busy}>添加模型</button>
                  <button type="button" disabled={busy} onClick={() => void test(p.id)}>测试连接</button>
                  <button type="button" className="danger" disabled={busy} onClick={() => void removeProvider(p.id, p.displayName)}>
                    停用
                  </button>
                </div>
              </form>
            </div>
          );
        })}
        {providers.length === 0 && <div className="muted">暂无可用 Provider</div>}
      </div>
      <div className="panel">
        <h3>运行时模型分配</h3>
        <p className="muted">不要用角色写死「视觉模型」。一个模型可以同时解题和看图。分配只是告诉系统哪一个负责哪件事。</p>
        {(["primarySolverModelId", "reflectionModelId", "visionModelId", "triageModelId", "managerModelId"] as const).map((slot) => {
          const label =
            slot === "primarySolverModelId"
              ? "主解题模型"
              : slot === "reflectionModelId"
                ? "反思模型"
                : slot === "visionModelId"
                  ? "视觉模型"
                  : slot === "managerModelId"
                    ? "调度 Manager 模型"
                    : "分诊模型";
          const enabledProviderIds = new Set(providers.map((p) => p.id));
          const all = (data?.models ?? []).filter((m) => isOn(m.enabled) && enabledProviderIds.has(m.providerId));
          const assigned = data?.assignments?.[slot] ?? "";
          const value = all.some((m) => m.id === assigned) ? assigned : "";
          return (
            <div className="field" key={slot}>
              <label htmlFor={`assign-${slot}`}>{label}</label>
              <select
                id={`assign-${slot}`}
                value={value}
                onChange={(e) => void setAssignment(slot, e.target.value || null)}
                disabled={busy}
              >
                <option value="">未指定</option>
                {all.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.modelName}
                    {m.capabilities?.vision ? " · 视觉" : ""}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
      {msg && <div className={msg.ok ? "ok" : "err"}>{msg.text}</div>}
    </>
  );
}

function VisualReviews({ refreshKey, onOpenChallenge }: { refreshKey: number; onOpenChallenge: (id: string) => void }) {
  const [items, setItems] = useState<VisualReviewRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(() => {
    void api<{ items: VisualReviewRow[] }>("/visual-reviews")
      .then((r) => setItems(r.items))
      .catch((e) => setMsg(String((e as Error).message)));
  }, []);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const answer = async (id: string, observation: string, useful: boolean) => {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; injected?: boolean; candidates?: string[] }>(`/visual-reviews/${id}/answer`, {
        method: "POST",
        body: { observation, useful },
      });
      setDrafts((s) => ({ ...s, [id]: "" }));
      const flags = r.candidates ?? [];
      setMsg(
        flags.length
          ? `已回写观察，并提交候选：${flags.join(", ")}`
          : useful
            ? "已回写给人眼观察（未识别为 flag 形态，故未交候选）"
            : "已回写：无明显视觉线索",
      );
      load();
    } catch (e) {
      setMsg(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const pending = items.filter((r) => r.status === "PENDING");
  const answered = items.filter((r) => r.status === "ANSWERED");
  return (
    <div className="panel">
      <h3>视觉复核队列</h3>
      <p className="muted">Agent 调用 request_visual_review 后不会停工。回答会注入 HUMAN VISUAL OBSERVATION；若内容是 flag 形态，会同时作为候选提交。</p>
      {pending.length === 0 && <div className="muted">没有待复核的图片</div>}
      {pending.map((r) => (
        <div key={r.id} className="panel" style={{ marginTop: 12 }}>
          <div>
            <button type="button" className="ghost" onClick={() => onOpenChallenge(r.challengeId)}>
              {r.challengeId}
            </button>
            <span className="muted break"> {r.sourcePath}</span>
          </div>
          <div>问题：{r.question}</div>
          {r.reason && <div className="muted">原因：{r.reason}</div>}
          <img
            alt=""
            src={`/api/challenges/${r.challengeId}/workspace?path=${encodeURIComponent(r.sourcePath)}`}
            style={{ maxWidth: "100%", maxHeight: 240, marginTop: 8, background: "#111" }}
          />
          <div className="field" style={{ marginTop: 8 }}>
            <label htmlFor={`rev-${r.id}`}>人眼观察</label>
            <input
              id={`rev-${r.id}`}
              value={drafts[r.id] ?? ""}
              onChange={(e) => setDrafts((s) => ({ ...s, [r.id]: e.target.value }))}
              placeholder="例如：flag{hello} 或 Blue bit 1 写着 TRY_ALPHA"
            />
          </div>
          <div className="buttons">
            <button
              type="button"
              className="primary"
              disabled={busy || !(drafts[r.id] ?? "").trim()}
              onClick={() => void answer(r.id, (drafts[r.id] ?? "").trim(), true)}
            >
              提交观察
            </button>
            <button type="button" disabled={busy} onClick={() => void answer(r.id, "No useful visual clue", false)}>
              无明显视觉线索
            </button>
          </div>
        </div>
      ))}
      {answered.length > 0 && <h3 style={{ marginTop: 16 }}>已回答</h3>}
      {answered.slice(0, 8).map((r) => (
        <div key={r.id} className="muted" style={{ marginTop: 6 }}>
          {r.challengeId} · {r.sourcePath} · {r.answerJson}
        </div>
      ))}
      {msg && <div className="muted" style={{ marginTop: 8 }}>{msg}</div>}
    </div>
  );
}

function BenchmarkPanel({ refreshKey }: { refreshKey: number }) {
  const [data, setData] = useState<{
    manifests: { id: string; category: string; flag: string; expectedTechniques: string[] }[];
    runs: { id: string; manifestId: string; solved: boolean; durationMs: number; error: string | null }[];
    summary?: { total: number; solved: number; failed: number; solveRate: number; medianMs: number };
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    void api<{
      manifests: { id: string; category: string; flag: string; expectedTechniques: string[] }[];
      runs: { id: string; manifestId: string; solved: boolean; durationMs: number; error: string | null }[];
      summary?: { total: number; solved: number; failed: number; solveRate: number; medianMs: number };
    }>("/benchmarks").then(setData);
  }, []);
  useEffect(() => {
    load();
  }, [load, refreshKey]);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<{
        results: { id: string; manifestId: string; solved: boolean; durationMs: number; error: string | null }[];
        summary: { total: number; solved: number; failed: number; solveRate: number; medianMs: number };
      }>("/benchmarks/run", { method: "POST", body: {} });
      setData((prev) => ({
        manifests: prev?.manifests ?? [],
        runs: r.results,
        summary: r.summary,
      }));
    } finally {
      setBusy(false);
    }
  };
  const s = data?.summary;
  return (
    <div className="panel">
      <h3>Benchmark</h3>
      <p className="muted">用已实现的 Misc/Crypto 工具跑固定 fixture，不调用大模型。</p>
      <button type="button" className="primary" disabled={busy} onClick={() => void run()}>
        {busy ? "评测中…" : "跑全部评测"}
      </button>
      {s && (
        <div className="ok" style={{ marginTop: 10 }}>
          汇总：{s.total} 题 · 解出 {s.solved} · 失败 {s.failed} · Solve Rate {(s.solveRate * 100).toFixed(0)}% · 中位 {s.medianMs}ms
        </div>
      )}
      {(data?.manifests ?? []).map((m) => (
        <div key={m.id} className="muted" style={{ marginTop: 8 }}>
          {m.id} · {m.category} · 期望 {m.expectedTechniques.join(", ")}
        </div>
      ))}
      <h3 style={{ marginTop: 12 }}>最近结果</h3>
      {(data?.runs ?? []).length === 0 && <div className="muted">还没跑过</div>}
      {(data?.runs ?? []).slice(0, 12).map((r) => (
        <div key={r.id} className={r.solved ? "ok" : "err"}>
          {r.manifestId} · {r.solved ? "解出" : "失败"} · {r.durationMs}ms {r.error ?? ""}
        </div>
      ))}
    </div>
  );
}
