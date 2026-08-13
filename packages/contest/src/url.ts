// URL Challenge Fetcher — 输入一个网址，自动抓取题目（题面 + 附件）。
//
// 支持三种来源：
//   1. 直接附件链接（.zip/.png/.pcap/...）→ 当作单个附件 + 文件名标题
//   2. CTF 平台题目页（CTFd / 通用 HTML）→ 提取标题/描述/附件链接并下载
//   3. CTFd JSON API（/api/v1/challenges/{id}）→ 标准字段
//
// 产出与 LocalContest 相同的目录结构，后续全流程（Triage → Solver → 候选）不变。

export interface FetchedChallenge {
  title: string;
  category: string;
  description: string;
  sourceUrl: string;
  attachments: { name: string; data: Buffer }[];
}

const UA = "rio-misc-agent/0.1 (CTF solver; authorized use)";

const ATTACHMENT_EXT = new Set([
  "zip", "rar", "7z", "tar", "gz", "bz2", "xz",
  "png", "jpg", "jpeg", "gif", "bmp", "webp", "svg", "ico",
  "txt", "md", "csv", "json", "xml", "py", "c", "cpp", "js", "go", "rs",
  "pcap", "pcapng", "wav", "mp3", "flac", "ogg",
  "pdf", "doc", "docx", "xls", "xlsx", "bin", "dat", "raw", "img", "iso",
  "sqlite", "db", "key", "pem", "crt", "der", "apk", "elf", "exe", "so", "dll",
]);

const BLOCKED_HOSTS = new Set([
  "github.com", // 仓库页是 JS 渲染，且可能要求登录；raw 链接可以直接抓
]);

interface ParsedHtml {
  title: string;
  description: string;
  links: string[];
  isCtfd: boolean;
}

/** 简易 HTML 解析（无依赖）：title、正文文本、链接收集。 */
function parseHtml(html: string, baseUrl: string): ParsedHtml {
  const out: ParsedHtml = { title: "", description: "", links: [], isCtfd: false };
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (titleMatch) out.title = titleMatch[1]!.replace(/\s+/g, " ").trim();

  out.isCtfd =
    /ctfd/i.test(html) ||
    /challenge-window/i.test(html) ||
    /challenges\.[a-z0-9]+\.js/i.test(html) ||
    /\/api\/v1\/challenges\//i.test(html);

  // 描述：优先找常见容器，其次整页文本
  const descSelectors = [
    /<div[^>]*class="[^"]*(?:challenge[-_]?description|problem[-_]?statement|description)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div[^>]*id="[^"]*(?:challenge[-_]?description|description|problem)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const re of descSelectors) {
    const m = re.exec(html);
    if (m?.[1]) {
      out.description = m[1]
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/\s+/g, " ")
        .trim();
      break;
    }
  }
  if (!out.description) {
    const bodyMatch = /<body[^>]*>([\s\S]*?)<\/body>/i.exec(html);
    if (bodyMatch) {
      out.description = bodyMatch[1]!
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 2000);
    }
  }

  // 附件链接：<a href> 指向常见附件扩展名，或带 download/attachment 特征
  const anchorRe = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1]!;
    const label = m[2]!.replace(/<[^>]+>/g, "").trim().toLowerCase();
    const ext = href.split("?")[0]!.split("#")[0]!.split(".").pop()?.toLowerCase() ?? "";
    const looksLikeFile =
      ATTACHMENT_EXT.has(ext) ||
      /download|attachment|file=/i.test(href) ||
      /download|attachment|\.zip|\.png|\.pcap/i.test(label);
    if (looksLikeFile && !/^mailto:|^javascript:|^#/.test(href)) {
      try {
        out.links.push(new URL(href, baseUrl).toString());
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}

async function download(url: string): Promise<{ data: Buffer; contentType: string; finalUrl: string }> {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": UA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const data = Buffer.from(await res.arrayBuffer());
  return { data, contentType: res.headers.get("content-type") ?? "", finalUrl: res.url };
}

function guessNameFromUrl(url: string): string {
  const path = new URL(url).pathname;
  const base = path.split("/").filter(Boolean).pop() ?? "attachment";
  return decodeURIComponent(base);
}

/**
 * 从 URL 抓取题目。抛错时给出可读信息。
 */
export async function fetchChallengeFromUrl(url: string): Promise<FetchedChallenge> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`不是合法 URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`仅支持 http/https: ${url}`);
  }
  const host = parsed.hostname.replace(/^www\./, "");
  if (BLOCKED_HOSTS.has(host)) {
    throw new Error(
      `${host} 是 JS 渲染页面，直接抓取不可靠。请改用 raw 文件直链（如 raw.githubusercontent.com/...）或把题目下载到本地后 rio solve <目录>`,
    );
  }

  const { data, contentType, finalUrl } = await download(url);
  const base = finalUrl;

  // 1) 直接是文件（非 HTML/JSON）
  if (!contentType.includes("text/html") && !contentType.includes("application/json") && !contentType.includes("text/plain")) {
    return {
      title: guessNameFromUrl(finalUrl).replace(/\.[^.]+$/, ""),
      category: "MISC",
      description: `附件：${guessNameFromUrl(finalUrl)}（从 ${url} 下载）`,
      sourceUrl: url,
      attachments: [{ name: guessNameFromUrl(finalUrl), data }],
    };
  }

  // 2) JSON（CTFd API 响应 或 通用题目 JSON）
  if (contentType.includes("application/json") || /^\[?\s*\{/.test(data.toString("utf8").slice(0, 200))) {
    const json = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
    const d = (json.data ?? json) as Record<string, unknown>;
    const name = String(d.name ?? d.title ?? guessNameFromUrl(finalUrl));
    const files = Array.isArray(d.files) ? (d.files as (string | { url?: string; name?: string })[]) : [];
    const attachments: { name: string; data: Buffer }[] = [];
    for (const f of files) {
      const fUrl = typeof f === "string" ? f : f.url;
      if (!fUrl) continue;
      const dl = await download(new URL(fUrl, base).toString());
      attachments.push({ name: typeof f === "object" && f.name ? f.name : guessNameFromUrl(dl.finalUrl), data: dl.data });
    }
    return {
      title: name,
      category: String(d.category ?? "MISC").toUpperCase(),
      description: String(d.description ?? ""),
      sourceUrl: url,
      attachments,
    };
  }

  // 3) HTML 页面
  const html = data.toString("utf8");
  const page = parseHtml(html, base);

  // CTFd 平台：尝试 JSON API（URL 形如 /challenges#<id>-<slug>）
  if (page.isCtfd) {
    const idMatch = /#(\d+)[-_]/.exec(parsed.hash) ?? /\/challenges\/(\d+)/.exec(parsed.pathname);
    if (idMatch) {
      const apiUrl = `${parsed.origin}/api/v1/challenges/${idMatch[1]}`;
      try {
        const apiRes = await fetch(apiUrl, { headers: { "user-agent": UA } });
        if (apiRes.ok) {
          const json = (await apiRes.json()) as { data: Record<string, unknown> };
          const d = json.data;
          const files = Array.isArray(d.files) ? (d.files as string[]) : [];
          const attachments: { name: string; data: Buffer }[] = [];
          for (const f of files) {
            const dl = await download(new URL(f, parsed.origin).toString());
            attachments.push({ name: guessNameFromUrl(dl.finalUrl), data: dl.data });
          }
          return {
            title: String(d.name ?? page.title),
            category: String(d.category ?? "MISC").toUpperCase(),
            description: String(d.description ?? page.description),
            sourceUrl: url,
            attachments,
          };
        }
      } catch {
        /* 平台可能需要登录/鉴权，退回 HTML 解析 */
      }
    }
  }

  // 4) 通用 HTML：标题 + 描述 + 附件链接
  const attachments: { name: string; data: Buffer }[] = [];
  for (const link of page.links.slice(0, 10)) {
    try {
      const dl = await download(link);
      attachments.push({ name: guessNameFromUrl(dl.finalUrl), data: dl.data });
    } catch {
      /* 单个附件失败不阻塞整体 */
    }
  }

  return {
    title: page.title || guessNameFromUrl(finalUrl).replace(/\.[^.]+$/, ""),
    category: "MISC",
    description: page.description,
    sourceUrl: url,
    attachments,
  };
}

/** 把抓取结果落盘成 LocalContest 目录结构（challenge.json + attachments/）。 */
export async function writeChallengeToDir(fetched: FetchedChallenge, dir: string): Promise<string> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  mkdirSync(join(dir, "attachments"), { recursive: true });
  writeFileSync(
    join(dir, "challenge.json"),
    JSON.stringify(
      {
        title: fetched.title,
        category: fetched.category,
        description: fetched.description,
        sourceUrl: fetched.sourceUrl,
      },
      null,
      2,
    ),
    "utf8",
  );
  for (const a of fetched.attachments) {
    writeFileSync(join(dir, "attachments", a.name), a.data);
  }
  return dir;
}
