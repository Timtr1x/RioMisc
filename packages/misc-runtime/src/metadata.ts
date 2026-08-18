export interface FileMetadata {
  pathHint?: string;
  size: number;
  magic: string;
  format: string;
  fields: { key: string; value: string }[];
  notes: string[];
}

function magicOf(buf: Buffer): string {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "PNG";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "JPEG";
  if (buf.length >= 6 && (buf.subarray(0, 6).toString("ascii") === "GIF87a" || buf.subarray(0, 6).toString("ascii") === "GIF89a")) return "GIF";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "PK\u0003\u0004") return "ZIP";
  if (buf.length >= 4 && (buf.readUInt32LE(0) === 0xa1b2c3d4 || buf.readUInt32LE(0) === 0xd4c3b2a1)) return "PCAP";
  if (buf.length >= 5 && buf.subarray(0, 5).toString("ascii") === "%PDF-") return "PDF";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "RIFF") return "RIFF";
  return "UNKNOWN";
}

function readPngChunks(buf: Buffer): { key: string; value: string }[] {
  const fields: { key: string; value: string }[] = [];
  if (buf.length < 33) return fields;
  let p = 8;
  while (p + 12 <= buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString("ascii");
    const dataStart = p + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) break;
    const data = buf.subarray(dataStart, dataEnd);
    if (type === "IHDR" && data.length >= 13) {
      fields.push({ key: "width", value: String(data.readUInt32BE(0)) });
      fields.push({ key: "height", value: String(data.readUInt32BE(4)) });
      fields.push({ key: "bitDepth", value: String(data[8]) });
      fields.push({ key: "colorType", value: String(data[9]) });
    } else if (type === "tEXt") {
      const nul = data.indexOf(0);
      if (nul > 0) {
        fields.push({
          key: `tEXt.${data.subarray(0, nul).toString("latin1")}`,
          value: data.subarray(nul + 1).toString("latin1").slice(0, 500),
        });
      }
    } else if (type === "iTXt") {
      const nul = data.indexOf(0);
      if (nul > 0) {
        fields.push({
          key: `iTXt.${data.subarray(0, nul).toString("utf8")}`,
          value: data.subarray(nul + 1).toString("utf8").slice(0, 500),
        });
      }
    } else if (type === "tIME" && data.length >= 7) {
      fields.push({
        key: "tIME",
        value: `${data.readUInt16BE(0)}-${data[2]}-${data[3]} ${data[4]}:${data[5]}:${data[6]}`,
      });
    } else if (type === "IEND") {
      break;
    }
    p = dataEnd + 4;
    if (type === "IEND") break;
  }
  return fields;
}

function readJpegNotes(buf: Buffer): { fields: { key: string; value: string }[]; notes: string[] } {
  const fields: { key: string; value: string }[] = [];
  const notes: string[] = [];
  let p = 2;
  while (p + 4 <= buf.length && buf[p] === 0xff) {
    const marker = buf[p + 1]!;
    if (marker === 0xd9 || marker === 0xda) break;
    const len = buf.readUInt16BE(p + 2);
    if (len < 2 || p + 2 + len > buf.length) break;
    if (marker === 0xe1) {
      const seg = buf.subarray(p + 4, p + 2 + len);
      if (seg.toString("ascii", 0, 6) === "Exif\u0000\u0000") {
        fields.push({ key: "APP1", value: "Exif present" });
        notes.push("JPEG has an Exif APP1 segment; parse further offline if needed.");
      } else {
        fields.push({ key: "APP1", value: `len=${len}` });
      }
    } else if (marker === 0xe0) {
      fields.push({ key: "JFIF", value: "present" });
    } else if (marker === 0xfe) {
      fields.push({ key: "COM", value: buf.subarray(p + 4, p + 2 + len).toString("latin1").slice(0, 300) });
    }
    p += 2 + len;
  }
  return { fields, notes };
}

function readPdfInfo(buf: Buffer): { key: string; value: string }[] {
  const head = buf.subarray(0, Math.min(buf.length, 64 * 1024)).toString("latin1");
  const fields: { key: string; value: string }[] = [];
  for (const key of ["Title", "Author", "Subject", "Creator", "Producer", "Keywords"]) {
    const m = head.match(new RegExp(`/${key}\\s*\\(([^)]{0,200})\\)`));
    if (m?.[1]) fields.push({ key, value: m[1] });
  }
  const ver = head.match(/%PDF-([0-9.]+)/);
  if (ver?.[1]) fields.push({ key: "version", value: ver[1] });
  return fields;
}

function readZipComment(buf: Buffer): { key: string; value: string }[] {
  const fields: { key: string; value: string }[] = [];
  for (let i = Math.max(0, buf.length - 66_000); i + 22 <= buf.length; i++) {
    if (buf.readUInt32LE(i) !== 0x06054b50) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (commentLen > 0 && i + 22 + commentLen <= buf.length) {
      fields.push({ key: "zipComment", value: buf.subarray(i + 22, i + 22 + commentLen).toString("utf8").slice(0, 500) });
    }
    break;
  }
  return fields;
}

export function inspectMetadata(buf: Buffer, pathHint?: string): FileMetadata {
  const magic = magicOf(buf);
  const fields: { key: string; value: string }[] = [];
  const notes: string[] = [];
  let format = magic;
  if (magic === "PNG") {
    fields.push(...readPngChunks(buf));
  } else if (magic === "JPEG") {
    const j = readJpegNotes(buf);
    fields.push(...j.fields);
    notes.push(...j.notes);
  } else if (magic === "PDF") {
    fields.push(...readPdfInfo(buf));
  } else if (magic === "ZIP") {
    fields.push(...readZipComment(buf));
  } else if (magic === "GIF" && buf.length >= 10) {
    fields.push({ key: "width", value: String(buf.readUInt16LE(6)) });
    fields.push({ key: "height", value: String(buf.readUInt16LE(8)) });
  } else {
    notes.push("No specialized metadata parser for this magic; only size/magic returned.");
  }
  return {
    pathHint,
    size: buf.length,
    magic,
    format,
    fields,
    notes,
  };
}
