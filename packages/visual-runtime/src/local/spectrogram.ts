import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { encodePng } from "../decode.js";
import { decodeWav, type PcmAudio } from "./wav.js";
import type { RgbaImage } from "../types.js";

export interface SpectrogramResult {
  image: RgbaImage;
  audio: PcmAudio;
  width: number;
  height: number;
}

export function renderSpectrogramPng(wavBuf: Buffer, destAbs: string, opts: { mode?: "AUTO" | "WIDE" | "DETAIL"; maxDurationSeconds?: number } = {}): SpectrogramResult {
  const audio = decodeWav(wavBuf);
  const maxSec = opts.maxDurationSeconds ?? (opts.mode === "DETAIL" ? 8 : 30);
  const samples = audio.samples.subarray(0, Math.min(audio.samples.length, Math.floor(maxSec * audio.sampleRate)));
  const win = opts.mode === "DETAIL" ? 512 : 1024;
  const hop = opts.mode === "WIDE" ? 512 : 256;
  const bins = win / 2;
  const cols = Math.max(1, Math.floor((samples.length - win) / hop) + 1);
  const width = Math.min(900, Math.max(120, cols));
  const height = Math.min(360, bins);
  const data = new Uint8Array(width * height * 4);
  const colMag = new Float32Array(bins);
  for (let x = 0; x < width; x++) {
    const srcCol = Math.min(cols - 1, Math.floor((x * cols) / width));
    const start = srcCol * hop;
    fillSpectrum(samples, start, win, colMag);
    for (let y = 0; y < height; y++) {
      const bin = Math.min(bins - 1, Math.floor(((height - 1 - y) * bins) / height));
      const v = Math.max(0, Math.min(255, Math.round(colMag[bin]! * 255)));
      const o = (y * width + x) * 4;
      data[o] = v;
      data[o + 1] = Math.round(v * 0.85);
      data[o + 2] = 40;
      data[o + 3] = 255;
    }
  }
  const image = { width, height, data };
  mkdirSync(dirname(destAbs), { recursive: true });
  writeFileSync(destAbs, encodePng(image));
  return { image, audio, width, height };
}

function fillSpectrum(samples: Float32Array, start: number, win: number, out: Float32Array): void {
  let max = 1e-9;
  const half = win / 2;
  for (let k = 0; k < half; k++) {
    let re = 0;
    let im = 0;
    for (let n = 0; n < win; n++) {
      const s = samples[start + n] ?? 0;
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * n) / (win - 1)));
      const ang = (-2 * Math.PI * k * n) / win;
      re += s * w * Math.cos(ang);
      im += s * w * Math.sin(ang);
    }
    const mag = Math.log10(1 + Math.hypot(re, im));
    out[k] = mag;
    if (mag > max) max = mag;
  }
  for (let k = 0; k < half; k++) out[k] = (out[k] ?? 0) / max;
}
