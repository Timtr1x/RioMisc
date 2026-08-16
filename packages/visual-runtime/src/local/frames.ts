import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { downscale, encodePng, decodeImageFile } from "../decode.js";
import type { RgbaImage } from "../types.js";

export interface KeyframeInfo {
  index: number;
  timestampMs: number | null;
  absPath: string;
}

export function composeContactSheet(frames: RgbaImage[], destAbs: string, cols = 4): RgbaImage {
  if (frames.length === 0) throw new Error("no frames");
  const scaled = frames.map((f) => downscale(f, 200));
  const cellW = Math.max(...scaled.map((i) => i.width));
  const cellH = Math.max(...scaled.map((i) => i.height)) + 12;
  const columns = Math.min(cols, scaled.length);
  const rows = Math.ceil(scaled.length / columns);
  const width = cellW * columns;
  const height = cellH * rows;
  const data = new Uint8Array(width * height * 4);
  data.fill(20);
  scaled.forEach((img, idx) => {
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    const ox = col * cellW;
    const oy = row * cellH;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const si = (y * img.width + x) * 4;
        const di = ((oy + y) * width + (ox + x)) * 4;
        data[di] = img.data[si]!;
        data[di + 1] = img.data[si + 1]!;
        data[di + 2] = img.data[si + 2]!;
        data[di + 3] = 255;
      }
    }
  });
  const sheet = { width, height, data };
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, encodePng(sheet));
  return sheet;
}

export function extractKeyframesWithFfmpeg(
  srcAbs: string,
  destDir: string,
  opts: { maxFrames: number; strategy: "UNIFORM" | "SCENE_CHANGE" | "ALL_IF_SMALL" },
): KeyframeInfo[] | null {
  mkdirSync(destDir, { recursive: true });
  const pattern = join(destDir, "frame-%03d.png");
  const vf = opts.strategy === "SCENE_CHANGE" ? "select='gt(scene,0.25)',showinfo" : `fps=${Math.max(1, Math.min(8, opts.maxFrames))}`;
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", srcAbs, "-vf", vf, "-frames:v", String(opts.maxFrames), pattern], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (r.status !== 0) return null;
  const out: KeyframeInfo[] = [];
  for (let i = 1; i <= opts.maxFrames; i++) {
    const p = join(destDir, `frame-${String(i).padStart(3, "0")}.png`);
    if (!existsSync(p)) break;
    out.push({ index: i - 1, timestampMs: null, absPath: p });
  }
  return out.length ? out : null;
}

export function loadFrameImages(infos: KeyframeInfo[]): RgbaImage[] {
  return infos.map((f) => decodeImageFile(f.absPath));
}
