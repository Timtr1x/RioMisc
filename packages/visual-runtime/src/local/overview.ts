import type { ChannelStats, RgbaImage, VisualOverview } from "../types.js";

function stats(values: number[]): ChannelStats {
  let min = 255;
  let max = 0;
  let sum = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const mean = values.length ? sum / values.length : 0;
  let acc = 0;
  for (const v of values) acc += (v - mean) * (v - mean);
  return { min, max, mean, variance: values.length ? acc / values.length : 0 };
}

export function computeVisualOverview(image: RgbaImage): VisualOverview {
  const n = image.width * image.height;
  const r: number[] = new Array(n);
  const g: number[] = new Array(n);
  const b: number[] = new Array(n);
  const a: number[] = new Array(n);
  let transparent = 0;
  let dark = 0;
  let edges = 0;
  const colorSet = new Set<number>();
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const rv = image.data[o] ?? 0;
    const gv = image.data[o + 1] ?? 0;
    const bv = image.data[o + 2] ?? 0;
    const av = image.data[o + 3] ?? 255;
    r[i] = rv;
    g[i] = gv;
    b[i] = bv;
    a[i] = av;
    if (av < 250) transparent += 1;
    if ((rv + gv + bv) / 3 < 48) dark += 1;
    // cheap unique-color estimate (quantize to 4 bits/channel)
    colorSet.add(((rv >> 4) << 8) | ((gv >> 4) << 4) | (bv >> 4));
    const x = i % image.width;
    if (x + 1 < image.width) {
      const no = o + 4;
      const d =
        Math.abs(rv - (image.data[no] ?? 0)) +
        Math.abs(gv - (image.data[no + 1] ?? 0)) +
        Math.abs(bv - (image.data[no + 2] ?? 0));
      if (d > 80) edges += 1;
    }
  }
  const rs = stats(r);
  const gs = stats(g);
  const bs = stats(b);
  const as = stats(a);
  const lumaVar = (rs.variance + gs.variance + bs.variance) / 3;
  const chroma =
    Math.abs(rs.mean - gs.mean) + Math.abs(gs.mean - bs.mean) + Math.abs(rs.mean - bs.mean);
  return {
    width: image.width,
    height: image.height,
    mode: "RGBA",
    hasAlpha: as.min < 255,
    alphaUsed: transparent / Math.max(1, n) > 0.01,
    meanRgb: [rs.mean, gs.mean, bs.mean],
    channelVariance: [rs.variance, gs.variance, bs.variance, as.variance],
    channels: { r: rs, g: gs, b: bs, a: as },
    uniqueColorsEstimate: colorSet.size,
    lowContrast: lumaVar < 80,
    mostlyMonochrome: chroma < 12,
    transparentPixelRatio: transparent / Math.max(1, n),
    darkRatio: dark / Math.max(1, n),
    edgeDensity: edges / Math.max(1, n),
  };
}
