// MockAgentRuntime — a deterministic, scriptable stand-in for a real LLM agent.
// It genuinely solves the mock fixtures by using the same Tool Runtime the Pi
// agent would use (inspect/extract/python), emitting progress/candidate events.
// This keeps the whole E2E loop testable without any model API.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SolverSessionConfig, SolverSessionHandle, AgentRuntimeAdapter } from "./adapter.js";
import { runTool, type ToolResult, type ToolContext } from "@rio/tool-runtime";

const FLAG_RE = /flag\{[^}]+\}/g;

interface MockHandle extends SolverSessionHandle {
  rejected: Set<string>;
  idlePromise: Promise<void>;
  resolveIdle: () => void;
  busy: boolean;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  owner: SolverSessionConfig | null;
}

interface Strategy {
  name: string;
  match(desc: string, files: string[]): boolean;
  run(ctx: ToolContext, desc: string, rejected: Set<string>): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Strategies (ordered; first match wins, later strategies used after rejection)
// ---------------------------------------------------------------------------

async function tool(ctx: ToolContext, name: string, params: unknown): Promise<ToolResult> {
  return runTool(ctx, name, params);
}

function extractFlags(text: string): string[] {
  return [...new Set(text.match(FLAG_RE) ?? [])];
}

function firstFlag(text: string, rejected: Set<string>): string | null {
  const flags = extractFlags(text);
  return flags.find((f) => !rejected.has(f)) ?? null;
}

async function readTextFiles(ctx: ToolContext, dir: string): Promise<string> {
  const list = await tool(ctx, "list_workspace", { path: dir });
  const entries = (list.data as { entries: { name: string; dir: boolean }[] })?.entries ?? [];
  let text = "";
  for (const e of entries) {
    if (e.dir) {
      text += await readTextFiles(ctx, `${dir}/${e.name}`);
      continue;
    }
    const r = await tool(ctx, "read_challenge_file", { path: `${dir}/${e.name}` });
    if (r.ok && typeof r.data === "object" && r.data && "text" in r.data) {
      text += String((r.data as { text: string }).text) + "\n";
    }
  }
  return text;
}

function python(ctx: ToolContext, code: string): Promise<ToolResult> {
  return tool(ctx, "run_python", { code, timeoutMs: 30_000 });
}

const STRATEGIES: Strategy[] = [
  {
    name: "visual_lab",
    match: (desc) =>
      /qr|analyze_visual|contrast|autocontrast|bitplane|alpha|rotat|invert|gif|hidden frame|red channel|visual/i.test(desc),
    async run(ctx, desc, rejected) {
      const flagFrom = (r: ToolResult) => firstFlag(JSON.stringify(r.data ?? r.summary ?? ""), rejected);
      const analyze = async (path: string) =>
        flagFrom(await tool(ctx, "analyze_visual", { path, mode: "LOCAL_ONLY" }));
      const list = await tool(ctx, "list_workspace", { path: "input" });
      const entries = (list.data as { entries: { name: string }[] })?.entries ?? [];
      for (const e of entries) {
        if (/\.gif$/i.test(e.name) || /gif|hidden frame/i.test(desc)) {
          if (!/\.gif$/i.test(e.name)) continue;
          await tool(ctx, "extract_keyframes", { path: `input/${e.name}`, maxFrames: 8 });
          const frames = await tool(ctx, "list_workspace", { path: "artifacts/visual/frames" });
          for (const f of (frames.data as { entries: { name: string }[] })?.entries ?? []) {
            if (!/\.png$/i.test(f.name)) continue;
            const hit = await analyze(`artifacts/visual/frames/${f.name}`);
            if (hit) return hit;
          }
          continue;
        }
        if (!/\.(png|jpg|jpeg)$/i.test(e.name)) continue;
        const src = `input/${e.name}`;
        const plane = /alpha/i.test(desc)
          ? ({ ch: "A" as const, bit: 7 })
          : /bitplane|bit plane/i.test(desc)
            ? ({ ch: "R" as const, bit: 0 })
            : /red channel|rgb channel/i.test(desc)
              ? ({ ch: "R" as const, bit: 7 })
              : null;
        if (plane) {
          const b = await tool(ctx, "extract_bitplane", { path: src, channel: plane.ch, bit: plane.bit });
          const dest = (b.data as { path?: string } | undefined)?.path;
          if (dest) {
            const hit = await analyze(dest);
            if (hit) return hit;
          }
          continue;
        }
        if (/contrast|autocontrast/i.test(desc)) {
          const t = await tool(ctx, "render_transform", { path: src, op: "autocontrast" });
          const dest = (t.data as { path?: string } | undefined)?.path;
          if (dest) {
            const hit = await analyze(dest);
            if (hit) return hit;
          }
        }
        const hit = await analyze(src);
        if (hit) return hit;
      }
      return null;
    },
  },
  {
    name: "wav_spectrogram",
    match: (desc) => /spectrogram|wav|tone|sample rate|sr_/i.test(desc),
    async run(ctx, _desc, rejected) {
      const list = await tool(ctx, "list_workspace", { path: "input" });
      const entries = (list.data as { entries: { name: string }[] })?.entries ?? [];
      for (const e of entries) {
        if (!/\.wav$/i.test(e.name)) continue;
        const r = await tool(ctx, "render_spectrogram", { path: `input/${e.name}`, mode: "AUTO" });
        const rate = (r.data as { sampleRate?: number } | undefined)?.sampleRate;
        if (rate) {
          const flag = `flag{sr_${rate}}`;
          if (!rejected.has(flag)) return flag;
        }
        const f = firstFlag(JSON.stringify(r.data ?? ""), rejected);
        if (f) return f;
      }
      return null;
    },
  },
  {
    name: "rsa_hastad",
    match: (desc) => /hastad|broadcast|n1\s*=/i.test(desc),
    async run(ctx, desc, rejected) {
      const grab = (k: string) => desc.match(new RegExp(`${k}\\s*=\\s*(\\d+)`))?.[1];
      const body = {
        e: grab("e") ?? "3",
        n1: grab("n1"),
        c1: grab("c1"),
        n2: grab("n2"),
        c2: grab("c2"),
        n3: grab("n3"),
        c3: grab("c3"),
      };
      if (!body.n1 || !body.c1 || !body.n2 || !body.c2 || !body.n3 || !body.c3) return null;
      const r = await tool(ctx, "rsa_hastad", body);
      const raw = (r.data as { m?: string } | undefined)?.m;
      if (!raw) return firstFlag(JSON.stringify(r.data ?? ""), rejected);
      let x = BigInt(raw);
      const bytes: number[] = [];
      while (x > 0n) {
        bytes.push(Number(x & 0xffn));
        x >>= 8n;
      }
      const text = Buffer.from(bytes.reverse()).toString("utf8");
      return firstFlag(text, rejected);
    },
  },
  {
    name: "base64",
    match: (desc) => /base64/i.test(desc) || /decode/i.test(desc),
    async run(ctx, _desc, rejected) {
      const text = await readTextFiles(ctx, "input");
      const b64Match = text.match(/[A-Za-z0-9+/=]{16,}/g);
      for (const blob of b64Match ?? []) {
        try {
          const decoded = Buffer.from(blob, "base64").toString("utf8");
          const f = firstFlag(decoded, rejected);
          if (f) return f;
        } catch {
          /* not valid base64 */
        }
      }
      return firstFlag(text, rejected) ?? null;
    },
  },
  {
    name: "archive",
    match: (desc) => /unpack|archive|unzip|extract|nested/i.test(desc),
    async run(ctx, _desc, rejected) {
      const list = await tool(ctx, "list_workspace", { path: "input" });
      const entries = (list.data as { entries: { name: string }[] })?.entries ?? [];
      let depth = 0;
      let dir = "input";
      const names = entries.map((e) => e.name);
      while (depth < 8) {
        const zipEntry = names.find((n) => /\.(zip|gz)$/i.test(n));
        if (!zipEntry) break;
        const dest = `artifacts/x-${depth}`;
        const r = await tool(ctx, "extract_archive", { path: `${dir}/${zipEntry}`, destPath: dest });
        if (!r.ok) return null;
        const inner = await readTextFiles(ctx, dest);
        const f = firstFlag(inner, rejected);
        if (f) return f;
        dir = dest;
        names.length = 0;
        const l2 = await tool(ctx, "list_workspace", { path: dir });
        for (const e of (l2.data as { entries: { name: string }[] })?.entries ?? []) names.push(e.name);
        depth++;
      }
      return null;
    },
  },
  {
    name: "png_trailing_zip",
    match: (desc) => /trailing|whole file|appended/i.test(desc),
    async run(ctx, _desc, rejected) {
      // python: find a zip after the PNG payload, extract it, read files
      const inputDir = JSON.stringify(ctx.workspace.input.replaceAll("\\", "/"));
      const code = `
import re, sys, zipfile, io, os
names = os.listdir(${inputDir})
for n in names:
    if not n.lower().endswith(('.png','.jpg','.gif','.bin')): continue
    data = open(os.path.join(${inputDir}, n),'rb').read()
    idx = data.find(b'PK\\x03\\x04')
    if idx == -1: continue
    z = zipfile.ZipFile(io.BytesIO(data[idx:]))
    out = []
    for m in z.namelist():
        try:
            t = z.read(m).decode('utf-8', 'ignore')
            out.append(f'[{m}] {t}')
        except Exception: pass
    print('\\n'.join(out))
`;
      const r = await python(ctx, code);
      if (r.ok) {
        const stdout = (r.data as { stdout?: string })?.stdout ?? "";
        const f = firstFlag(stdout, rejected);
        if (f) return f;
      }
      return null;
    },
  },
  {
    name: "lsb",
    match: (desc) => /lsb|stego|least significant|channel anomal/i.test(desc),
    async run(ctx, _desc, rejected) {
      const inputDir = JSON.stringify(ctx.workspace.input.replaceAll("\\", "/"));
      const code = `
import zlib, struct, os
def png_pixels(path):
    data = open(path,'rb').read()
    assert data[:8] == b'\\x89PNG\\r\\n\\x1a\\n'
    pos = 8; idat = b''; w = h = 0
    while pos < len(data):
        ln = struct.unpack('>I', data[pos:pos+4])[0]
        typ = data[pos+4:pos+8]
        if typ == b'IHDR':
            w,h = struct.unpack('>II', data[pos+8:pos+16])
        elif typ == b'IDAT':
            idat += data[pos+8:pos+8+ln]
        pos += 12 + ln
    raw = zlib.decompress(idat)
    stride = w*3 + 1
    bits = []
    for y in range(h):
        row = raw[y*stride+1:(y+1)*stride]
        for b in row:
            bits.append(b & 1)
    out = bytearray()
    for i in range(0, len(bits)-7, 8):
        v = 0
        for b in bits[i:i+8]: v = (v<<1)|b
        if v == 0: break
        out.append(v)
    return out.decode('utf-8','ignore')
for n in os.listdir(${inputDir}):
    if n.lower().endswith('.png'):
        print(png_pixels(os.path.join(${inputDir}, n)))
`;
      const r = await python(ctx, code);
      if (r.ok) {
        const stdout = (r.data as { stdout?: string })?.stdout ?? "";
        const f = firstFlag(stdout, rejected);
        if (f) return f;
      }
      return null;
    },
  },
  {
    name: "pcap_dns",
    match: (desc) => /dns/i.test(desc),
    async run(ctx, _desc, rejected) {
      const list = await tool(ctx, "list_workspace", { path: "input" });
      const entries = (list.data as { entries: { name: string }[] })?.entries ?? [];
      for (const e of entries) {
        if (!/\.(pcap|pcapng)$/i.test(e.name)) continue;
        const r = await tool(ctx, "extract_dns_activity", { path: `input/${e.name}` });
        const f = firstFlag(JSON.stringify(r.data ?? ""), rejected);
        if (f) return f;
      }
      return null;
    },
  },
  {
    name: "pcap_http",
    match: (desc) => /pcap|packet|capture|sniff|http/i.test(desc),
    async run(ctx, _desc, rejected) {
      const list = await tool(ctx, "list_workspace", { path: "input" });
      const entries = (list.data as { entries: { name: string }[] })?.entries ?? [];
      for (const e of entries) {
        if (!/\.(pcap|pcapng)$/i.test(e.name)) continue;
        const r = await tool(ctx, "inspect_file", { path: `input/${e.name}` });
        if (!r.ok) continue;
        const data = r.data as { hints?: string[]; pcapSample?: string };
        const text = JSON.stringify(data);
        const f = firstFlag(text, rejected);
        if (f) return f;
        const inputDir = JSON.stringify(ctx.workspace.input.replaceAll("\\", "/"));
        const code = `
import struct, os
def parse(path):
    data = open(path,'rb').read()
    lt = struct.unpack('<I', data[20:24])[0]
    pos = 24; out = []
    while pos + 16 <= len(data):
        incl = struct.unpack('<I', data[pos+8:pos+12])[0]
        pkt = data[pos+16:pos+16+incl]
        off = 14 if lt == 1 else 0
        if len(pkt) > off + 20 and pkt[off+9] == 6:
            payload = pkt[off+40:]
            out.append(payload.decode('latin1','ignore'))
        pos += 16 + incl
    return '\\n'.join(out)
for n in os.listdir(${inputDir}):
    if n.lower().endswith('.pcap'):
        print(parse(os.path.join(${inputDir}, n)))
`;
        const pr = await python(ctx, code);
        if (pr.ok) {
          const f2 = firstFlag((pr.data as { stdout?: string })?.stdout ?? "", rejected);
          if (f2) return f2;
        }
      }
      return null;
    },
  },
  {
    name: "xor",
    match: (desc) => /xor/i.test(desc),
    async run(ctx, desc, rejected) {
      const cipher = desc.match(/cipher\s*=\s*([0-9a-fA-F]+)/);
      const key = desc.match(/key\s*=\s*([^\s\n]+)/);
      if (!cipher || !key || !cipher[1] || !key[1]) return null;
      const code = `
cipher = bytes.fromhex('${cipher[1]}')
key = b'${key[1].replaceAll("'", "\\'")}'
plain = bytes(c ^ key[i % len(key)] for i, c in enumerate(cipher))
print(plain.decode('utf-8', 'ignore'))
`;
      const r = await python(ctx, code);
      return r.ok ? firstFlag((r.data as { stdout?: string })?.stdout ?? "", rejected) : null;
    },
  },
  {
    name: "rsa_fermat",
    match: (desc) => /n\s*=\s*\d+\s*\ne\s*=\s*\d+/.test(desc) && /close|fermat|factor/i.test(desc),
    async run(ctx, desc, rejected) {
      const n = BigInt(desc.match(/n\s*=\s*(\d+)/)?.[1] ?? "0");
      const e = BigInt(desc.match(/e\s*=\s*(\d+)/)?.[1] ?? "0");
      const c = BigInt(desc.match(/c\s*=\s*(\d+)/)?.[1] ?? "0");
      if (!n || !e) return null;
      const code = `
import math
n = ${n}; e = ${e}; c = ${c}
x = math.isqrt(n)
if x * x < n: x += 1
y2 = x * x - n
while math.isqrt(y2) ** 2 != y2:
    x += 1
    y2 = x * x - n
y = math.isqrt(y2)
p = x - y; q = x + y
d = pow(e, -1, (p - 1) * (q - 1))
m = pow(c, d, n)
print(m.to_bytes((m.bit_length() + 7) // 8, 'big').decode('utf-8', 'ignore'))
`;
      const r = await python(ctx, code);
      return r.ok ? firstFlag((r.data as { stdout?: string })?.stdout ?? "", rejected) : null;
    },
  },
  {
    name: "rsa_small_e",
    match: (desc) => (/e\s*=\s*3\b/.test(desc) || /small e/i.test(desc)) && !/n1\s*=/.test(desc),
    async run(ctx, desc, rejected) {
      const n = BigInt(desc.match(/n\s*=\s*(\d+)/)?.[1] ?? "0");
      const c = BigInt(desc.match(/c\s*=\s*(\d+)/)?.[1] ?? "0");
      if (!n || !c) return null;
      const code = `
c = ${c}; n = ${n}
lo, hi = 0, 1
while hi**3 < c: hi *= 2
while lo + 1 < hi:
    mid = (lo + hi) // 2
    if mid**3 <= c: lo = mid
    else: hi = mid
m = lo if lo**3 == c else hi
print(m.to_bytes((m.bit_length()+7)//8, 'big').decode('utf-8','ignore'))
`;
      const r = await python(ctx, code);
      return r.ok ? firstFlag((r.data as { stdout?: string })?.stdout ?? "", rejected) : null;
    },
  },
  {
    name: "rsa_common_modulus",
    match: (desc) => /common modulus|same message/i.test(desc),
    async run(ctx, desc, rejected) {
      const n = BigInt(desc.match(/n\s*=\s*(\d+)/)?.[1] ?? "0");
      const e1 = BigInt(desc.match(/e1\s*=\s*(\d+)/)?.[1] ?? "0");
      const c1 = BigInt(desc.match(/c1\s*=\s*(\d+)/)?.[1] ?? "0");
      const e2 = BigInt(desc.match(/e2\s*=\s*(\d+)/)?.[1] ?? "0");
      const c2 = BigInt(desc.match(/c2\s*=\s*(\d+)/)?.[1] ?? "0");
      if (!n || !e1 || !e2) return null;
      const code = `
def egcd(a, b):
    if b == 0: return (a, 1, 0)
    g, x, y = egcd(b, a % b)
    return (g, y, x - (a // b) * y)
n = ${n}; e1 = ${e1}; c1 = ${c1}; e2 = ${e2}; c2 = ${c2}
g, a, b = egcd(e1, e2)
if a < 0: a, c1 = -a, pow(c1, -1, n)
if b < 0: b, c2 = -b, pow(c2, -1, n)
m = (pow(c1, a, n) * pow(c2, b, n)) % n
print(m.to_bytes((m.bit_length()+7)//8, 'big').decode('utf-8','ignore'))
`;
      const r = await python(ctx, code);
      return r.ok ? firstFlag((r.data as { stdout?: string })?.stdout ?? "", rejected) : null;
    },
  },
  {
    name: "lcg",
    match: (desc) => /lcg|outputs\s*=\s*\[/i.test(desc),
    async run(ctx, desc, rejected) {
      const a = desc.match(/a\s*=\s*(\d+)/)?.[1];
      const c = desc.match(/c\s*=\s*(\d+)/)?.[1];
      const m = desc.match(/m\s*=\s*(\d+)/)?.[1];
      const outputs = desc.match(/outputs\s*=\s*\[([^\]]+)\]/)?.[1]?.split(",").map((s) => s.trim());
      if (!a || !c || !m || !outputs || outputs.length < 4) return null;
      const code = `
a = ${a}; c = ${c}; m = ${m}
s = ${outputs[outputs.length - 1]!}
next_val = (a * s + c) % m
print(f'flag{{{next_val}}}')
`;
      const r = await python(ctx, code);
      return r.ok ? firstFlag((r.data as { stdout?: string })?.stdout ?? "", rejected) : null;
    },
  },
];

// ---------------------------------------------------------------------------
// MockAgentRuntime
// ---------------------------------------------------------------------------

export class MockAgentRuntime implements AgentRuntimeAdapter {
  readonly kind = "mock";

  async createSolverSession(config: SolverSessionConfig): Promise<SolverSessionHandle> {
    return this.#start(config, false);
  }

  async resumeSolverSession(config: SolverSessionConfig): Promise<SolverSessionHandle> {
    return this.#start(config, true);
  }

  #start(config: SolverSessionConfig, _resume: boolean): MockHandle {
    let resolveIdle: () => void = () => {};
    const idlePromise = new Promise<void>((r) => {
      resolveIdle = r;
    });
    const handle: MockHandle = {
      sessionId: config.sessionId,
      rejected: new Set<string>(),
      idlePromise,
      resolveIdle,
      busy: false,
      inputTokens: 0,
      outputTokens: 0,
      toolCalls: 0,
      owner: config,
      waitForIdle: () => handle.idlePromise,
      usage: () => ({ inputTokens: handle.inputTokens, outputTokens: handle.outputTokens, toolCalls: handle.toolCalls }),
      persistence: () => {
        const file = join(config.sessionDir, `mock-${config.sessionId}.json`);
        try {
          mkdirSync(config.sessionDir, { recursive: true });
          writeFileSync(file, JSON.stringify({ mock: true, sessionId: config.sessionId }), "utf8");
        } catch {
          /* ignore */
        }
        return { externalSessionId: `mock_${config.sessionId}`, sessionFile: file };
      },
    };
    void this.#solveLoop(config, handle);
    return handle;
  }

  async #solveLoop(config: SolverSessionConfig, handle: MockHandle): Promise<void> {
    const ctx = config.toolContext;
    handle.busy = true;
    try {
      // 1. read challenge.txt (control plane writes it into the workspace root)
      const descRes = await runTool(ctx, "read_challenge_file", { path: "challenge.txt", maxChars: 20000 });
      handle.inputTokens += 400;
      handle.toolCalls += 1;
      const desc = descRes.ok && typeof descRes.data === "object" && descRes.data
        ? String((descRes.data as { text: string }).text)
        : "";

      // 2. inventory
      const inv = await runTool(ctx, "list_workspace", { path: "input" });
      handle.toolCalls += 1;
      const files: string[] = [];
      for (const e of ((inv.data as { entries: { name: string }[] })?.entries ?? [])) files.push(e.name);
      ctx.emit("progress", {
        challengeId: config.challengeId,
        sessionId: config.sessionId,
        summary: `Starting analysis. Category=${config.solverType}, files=${files.join(", ") || "(none)"}`,
        hypotheses: ["Determine the encoding/primitive used"],
        confirmedFacts: files.map((f) => `attachment present: ${f}`),
        rejectedHypotheses: [],
        nextActions: ["Apply candidate strategies in order"],
        confidence: 0.3,
        progress: "MINOR",
        stalled: false,
      });

      const tried = new Set<string>();
      for (const strategy of STRATEGIES) {
        if (handle.rejected.size > 0 && tried.has(strategy.name)) continue;
        if (!strategy.match(desc, files)) continue;
        tried.add(strategy.name);
        ctx.emit("progress", {
          challengeId: config.challengeId,
          sessionId: config.sessionId,
          summary: `Testing strategy: ${strategy.name}`,
          hypotheses: [strategy.name],
          confirmedFacts: [],
          rejectedHypotheses: [],
          nextActions: ["Evaluate result"],
          confidence: 0.5,
          progress: "MINOR",
          stalled: false,
        });
        handle.outputTokens += 500;
        const flag = await strategy.run(ctx, desc, handle.rejected);
        if (flag && !handle.rejected.has(flag)) {
          handle.outputTokens += 800;
          ctx.emit("candidate", {
            challengeId: config.challengeId,
            sessionId: config.sessionId,
            value: flag,
            confidence: 0.9,
            reason: `MockAgent strategy "${strategy.name}" produced a flag-format match`,
            evidence: [{ type: "tool_output", text: `strategy=${strategy.name}` }],
          });
          ctx.emit("progress", {
            challengeId: config.challengeId,
            sessionId: config.sessionId,
            summary: `Candidate found via ${strategy.name}`,
            hypotheses: [],
            confirmedFacts: [`candidate: ${flag}`],
            rejectedHypotheses: [],
            nextActions: ["await verification"],
            confidence: 0.9,
            progress: "SIGNIFICANT",
            stalled: false,
          });
          break;
        }
      }
      if (handle.rejected.size === 0 && [...tried].length === 0) {
        ctx.emit("progress", {
          challengeId: config.challengeId,
          sessionId: config.sessionId,
          summary: "No strategy matched; awaiting instructions",
          hypotheses: [],
          confirmedFacts: [],
          rejectedHypotheses: [],
          nextActions: [],
          confidence: 0.1,
          progress: "NONE",
          stalled: true,
        });
      }
    } catch (e) {
      ctx.emit("error", { challengeId: config.challengeId, sessionId: config.sessionId, message: String(e) });
    } finally {
      handle.busy = false;
      handle.resolveIdle();
    }
  }

  async inject(session: SolverSessionHandle, message: string): Promise<void> {
    const h = session as MockHandle;
    if (/SUBMISSION FEEDBACK/i.test(message)) {
      const m = message.match(/flag\{[^}]+\}/);
      if (m) h.rejected.add(m[0]);
    }
    if (h.busy) return; // rejected flags are checked by the running loop
    if (h.owner) {
      h.resolveIdle();
      void this.#solveLoop(h.owner, h);
    }
  }

  async switchModel(): Promise<void> {
    // mock ignores model switches
  }

  async abort(session: SolverSessionHandle): Promise<void> {
    (session as MockHandle).resolveIdle();
  }

  async compact(): Promise<void> {
    // mock has no context to compact
  }
}
