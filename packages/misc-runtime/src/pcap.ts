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
