export interface PcapOverview {
  packetCount: number;
  tcp: number;
  udp: number;
  icmp: number;
  other: number;
  tcpStreams: number;
  httpRequests: { method: string; host: string; path: string }[];
  dnsNames: string[];
  endpoints: string[];
  conversations: { a: string; b: string; packets: number }[];
}

export function analyzePcapOverview(buf: Buffer): PcapOverview {
  const out: PcapOverview = {
    packetCount: 0, tcp: 0, udp: 0, icmp: 0, other: 0, tcpStreams: 0,
    httpRequests: [], dnsNames: [], endpoints: [], conversations: [],
  };
  if (buf.length < 24) return out;
  const magic = buf.readUInt32LE(0);
  const swap = magic === 0xd4c3b2a1;
  const ru32 = (o: number) => (swap ? buf.readUInt32BE(o) : buf.readUInt32LE(o));
  const linkType = ru32(20);
  const conv = new Map<string, number>();
  const streams = new Set<string>();
  let p = 24;
  while (p + 16 <= buf.length) {
    const inclLen = ru32(p + 8);
    const dataStart = p + 16;
    const dataEnd = Math.min(dataStart + inclLen, buf.length);
    out.packetCount += 1;
    let ipStart = dataStart;
    if (linkType === 1 && dataEnd - dataStart >= 14) ipStart = dataStart + 14;
    if (dataEnd - ipStart >= 20 && ((buf[ipStart]! >> 4) === 4)) {
      const ihl = (buf[ipStart]! & 0x0f) * 4;
      const proto = buf[ipStart + 9]!;
      const src = `${buf[ipStart + 12]}.${buf[ipStart + 13]}.${buf[ipStart + 14]}.${buf[ipStart + 15]}`;
      const dst = `${buf[ipStart + 16]}.${buf[ipStart + 17]}.${buf[ipStart + 18]}.${buf[ipStart + 19]}`;
      out.endpoints.push(src, dst);
      const pair = [src, dst].sort().join("↔");
      conv.set(pair, (conv.get(pair) ?? 0) + 1);
      const l4 = ipStart + ihl;
      if (proto === 6) {
        out.tcp += 1;
        if (l4 + 4 <= dataEnd) {
          const sp = buf.readUInt16BE(l4);
          const dp = buf.readUInt16BE(l4 + 2);
          streams.add(`${src}:${sp}-${dst}:${dp}`);
          const doff = ((buf[l4 + 12]! >> 4) & 0xf) * 4;
          const payload = buf.subarray(l4 + doff, dataEnd).toString("latin1");
          const m = payload.match(/^(GET|POST|PUT|HEAD|DELETE) ([^\s]+) HTTP\/1\.[01]/);
          const host = payload.match(/Host:\s*([^\r\n]+)/i)?.[1]?.trim() ?? "";
          if (m) out.httpRequests.push({ method: m[1]!, host, path: m[2]! });
        }
      } else if (proto === 17) {
        out.udp += 1;
        if (l4 + 8 <= dataEnd) {
          const dp = buf.readUInt16BE(l4 + 2);
          if (dp === 53 || buf.readUInt16BE(l4) === 53) {
            const name = parseDnsName(buf.subarray(l4 + 8, dataEnd));
            if (name) out.dnsNames.push(name);
          }
        }
      } else if (proto === 1) out.icmp += 1;
      else out.other += 1;
    }
    p = dataStart + inclLen;
  }
  out.tcpStreams = streams.size;
  out.endpoints = [...new Set(out.endpoints)].slice(0, 32);
  out.dnsNames = [...new Set(out.dnsNames)].slice(0, 32);
  out.conversations = [...conv.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([k, packets]) => {
      const [a, b] = k.split("↔");
      return { a: a ?? "", b: b ?? "", packets };
    });
  return out;
}

export function extractHttpObjects(buf: Buffer): { method: string; host: string; path: string; bodyPreview: string }[] {
  const ov = analyzePcapOverview(buf);
  return ov.httpRequests.map((r) => ({ ...r, bodyPreview: "" }));
}

export interface TcpStreamSegment {
  dir: "A_TO_B" | "B_TO_A";
  seq: number;
  length: number;
  asciiPreview: string;
  hexPreview: string;
}

export interface TcpStreamFollow {
  streamKey: string;
  streamIndex: number;
  availableStreams: string[];
  packetCount: number;
  totalPayloadBytes: number;
  segments: TcpStreamSegment[];
  reassembledAscii: string;
  reassembledHex: string;
}

function listTcpStreams(buf: Buffer): Map<string, { src: string; dst: string; sport: number; dport: number; payloads: { dir: "A_TO_B" | "B_TO_A"; seq: number; data: Buffer }[] }> {
  const streams = new Map<string, { src: string; dst: string; sport: number; dport: number; payloads: { dir: "A_TO_B" | "B_TO_A"; seq: number; data: Buffer }[] }>();
  if (buf.length < 24) return streams;
  const magic = buf.readUInt32LE(0);
  const swap = magic === 0xd4c3b2a1;
  const ru32 = (o: number) => (swap ? buf.readUInt32BE(o) : buf.readUInt32LE(o));
  const linkType = ru32(20);
  let p = 24;
  while (p + 16 <= buf.length) {
    const inclLen = ru32(p + 8);
    const dataStart = p + 16;
    const dataEnd = Math.min(dataStart + inclLen, buf.length);
    let ipStart = dataStart;
    if (linkType === 1 && dataEnd - dataStart >= 14) ipStart = dataStart + 14;
    if (dataEnd - ipStart >= 20 && ((buf[ipStart]! >> 4) === 4)) {
      const ihl = (buf[ipStart]! & 0x0f) * 4;
      const proto = buf[ipStart + 9]!;
      const src = `${buf[ipStart + 12]}.${buf[ipStart + 13]}.${buf[ipStart + 14]}.${buf[ipStart + 15]}`;
      const dst = `${buf[ipStart + 16]}.${buf[ipStart + 17]}.${buf[ipStart + 18]}.${buf[ipStart + 19]}`;
      const l4 = ipStart + ihl;
      if (proto === 6 && l4 + 14 <= dataEnd) {
        const sport = buf.readUInt16BE(l4);
        const dport = buf.readUInt16BE(l4 + 2);
        const seq = buf.readUInt32BE(l4 + 4);
        const doff = ((buf[l4 + 12]! >> 4) & 0xf) * 4;
        const payload = buf.subarray(l4 + doff, dataEnd);
        const forward = `${src}:${sport}-${dst}:${dport}`;
        const reverse = `${dst}:${dport}-${src}:${sport}`;
        const key = streams.has(forward) ? forward : streams.has(reverse) ? reverse : forward;
        const dir: "A_TO_B" | "B_TO_A" = key === forward ? "A_TO_B" : "B_TO_A";
        let entry = streams.get(key);
        if (!entry) {
          entry = { src, dst, sport, dport, payloads: [] };
          streams.set(key, entry);
        }
        if (payload.length > 0) entry.payloads.push({ dir, seq, data: Buffer.from(payload) });
      }
    }
    p = dataStart + inclLen;
  }
  return streams;
}

export function followTcpStream(
  buf: Buffer,
  opts: { streamIndex?: number; src?: string; dst?: string; sport?: number; dport?: number; maxBytes?: number } = {},
): TcpStreamFollow {
  const streams = listTcpStreams(buf);
  const keys = [...streams.keys()];
  let key = keys[opts.streamIndex ?? 0] ?? keys[0] ?? "";
  if (opts.src || opts.dst || opts.sport != null || opts.dport != null) {
    const hit = keys.find((k) => {
      const e = streams.get(k)!;
      if (opts.src && e.src !== opts.src && e.dst !== opts.src) return false;
      if (opts.dst && e.dst !== opts.dst && e.src !== opts.dst) return false;
      if (opts.sport != null && e.sport !== opts.sport && e.dport !== opts.sport) return false;
      if (opts.dport != null && e.dport !== opts.dport && e.sport !== opts.dport) return false;
      return true;
    });
    if (hit) key = hit;
  }
  const entry = streams.get(key);
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const segments: TcpStreamSegment[] = [];
  const chunks: Buffer[] = [];
  let total = 0;
  for (const pl of entry?.payloads ?? []) {
    if (total >= maxBytes) break;
    const slice = pl.data.subarray(0, Math.min(pl.data.length, maxBytes - total));
    total += slice.length;
    chunks.push(slice);
    segments.push({
      dir: pl.dir,
      seq: pl.seq,
      length: slice.length,
      asciiPreview: slice.toString("latin1").slice(0, 240),
      hexPreview: slice.subarray(0, 64).toString("hex"),
    });
  }
  const reassembled = Buffer.concat(chunks);
  return {
    streamKey: key,
    streamIndex: Math.max(0, keys.indexOf(key)),
    availableStreams: keys.slice(0, 32),
    packetCount: entry?.payloads.length ?? 0,
    totalPayloadBytes: total,
    segments: segments.slice(0, 64),
    reassembledAscii: reassembled.toString("latin1").slice(0, maxBytes),
    reassembledHex: reassembled.toString("hex").slice(0, maxBytes * 2),
  };
}

function parseDnsName(payload: Buffer): string | null {
  if (payload.length < 13) return null;
  let i = 12;
  const labels: string[] = [];
  while (i < payload.length) {
    const len = payload[i]!;
    if (len === 0) break;
    if (len > 63) break;
    i += 1;
    if (i + len > payload.length) break;
    labels.push(payload.subarray(i, i + len).toString("ascii"));
    i += len;
  }
  return labels.length ? labels.join(".") : null;
}
