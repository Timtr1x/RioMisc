import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import type { RgbaImage } from "./types.js";

export function decodeImageBuffer(buf: Buffer): RgbaImage {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47) {
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: Uint8Array.from(png.data) };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const decoded = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true });
    return { width: decoded.width, height: decoded.height, data: Uint8Array.from(decoded.data) };
  }
  throw new Error("unsupported image (need PNG or JPEG)");
}

export function decodeImageFile(absPath: string): RgbaImage {
  return decodeImageBuffer(readFileSync(absPath));
}

export function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

export function cloneImage(image: RgbaImage): RgbaImage {
  return { width: image.width, height: image.height, data: Uint8Array.from(image.data) };
}

export function downscale(image: RgbaImage, maxWidth: number): RgbaImage {
  if (image.width <= maxWidth) return image;
  const width = maxWidth;
  const height = Math.max(1, Math.round((image.height * maxWidth) / image.width));
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.floor((y * image.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor((x * image.width) / width));
      const si = (sy * image.width + sx) * 4;
      const di = (y * width + x) * 4;
      data[di] = image.data[si]!;
      data[di + 1] = image.data[si + 1]!;
      data[di + 2] = image.data[si + 2]!;
      data[di + 3] = image.data[si + 3]!;
    }
  }
  return { width, height, data };
}
