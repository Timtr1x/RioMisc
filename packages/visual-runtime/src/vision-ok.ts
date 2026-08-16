// Deterministic test glyph: the string the vision capability probe must read.
import { encodePng } from "./decode.js";
import type { RgbaImage } from "./types.js";

export const VISION_OK_TEXT = "RIO VISION OK";

// 5x7 capitals we need. 1 = ink.
const GLYPHS: Record<string, string[]> = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "01010", "01010", "00100"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
};

export function renderVisionOkImage(): RgbaImage {
  const text = VISION_OK_TEXT;
  const scale = 4;
  const pad = 8;
  const gw = 5;
  const gh = 7;
  const width = pad * 2 + text.length * (gw + 1) * scale;
  const height = pad * 2 + gh * scale;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  for (let i = 0; i < text.length; i++) {
    const glyph = GLYPHS[text[i]!] ?? GLYPHS[" "]!;
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        if (glyph[y]![x] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = pad + i * (gw + 1) * scale + x * scale + dx;
            const py = pad + y * scale + dy;
            const o = (py * width + px) * 4;
            data[o] = 0;
            data[o + 1] = 0;
            data[o + 2] = 0;
          }
        }
      }
    }
  }
  return { width, height, data };
}

export function visionOkPng(): Buffer {
  return encodePng(renderVisionOkImage());
}

export function visionTestPassed(reply: string): boolean {
  return /RIO\s*VISION\s*OK/i.test(reply);
}
