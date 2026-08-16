export interface PcmAudio {
  sampleRate: number;
  channels: number;
  samples: Float32Array;
  durationSec: number;
  peak: number;
  rms: number;
}

export function decodeWav(buf: Buffer): PcmAudio {
  if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bits = 16;
  let data: Buffer | null = null;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(start + 2);
      sampleRate = buf.readUInt32LE(start + 4);
      bits = buf.readUInt16LE(start + 14);
    } else if (id === "data") {
      data = buf.subarray(start, start + size);
    }
    offset = start + size + (size % 2);
  }
  if (!data || !sampleRate || !channels) throw new Error("WAVE missing fmt/data");
  const samples = pcmToMono(data, channels, bits);
  let peak = 0;
  let acc = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
    acc += s * s;
  }
  return {
    sampleRate,
    channels,
    samples,
    durationSec: samples.length / sampleRate,
    peak,
    rms: Math.sqrt(acc / Math.max(1, samples.length)),
  };
}

export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function pcmToMono(data: Buffer, channels: number, bits: number): Float32Array {
  const width = bits === 8 ? 1 : 2;
  const frames = Math.floor(data.length / (width * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * width;
      acc += bits === 8 ? (data[o]! - 128) / 128 : data.readInt16LE(o) / 32768;
    }
    out[i] = acc / channels;
  }
  return out;
}
