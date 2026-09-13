import { describe, expect, it } from "vitest";
import { blobToWav, decodeWav16, encodeWav16, mixToMono, wavDurationS, type PcmLike } from "./wav";

function sine(n: number, freq: number, sr: number, amp = 0.5): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return out;
}

describe("encodeWav16", () => {
  it("writes a canonical 44-byte header with the right sizes", () => {
    const sr = 48000;
    const buf = encodeWav16([sine(480, 440, sr)], sr);
    const v = new DataView(buf);
    const tag = (o: number) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    expect(buf.byteLength).toBe(44 + 480 * 2);
    expect(tag(0)).toBe("RIFF");
    expect(v.getUint32(4, true)).toBe(36 + 960);
    expect(tag(8)).toBe("WAVE");
    expect(tag(12)).toBe("fmt ");
    expect(v.getUint32(16, true)).toBe(16);
    expect(v.getUint16(20, true)).toBe(1);
    expect(v.getUint16(22, true)).toBe(1);
    expect(v.getUint32(24, true)).toBe(48000);
    expect(v.getUint32(28, true)).toBe(96000);
    expect(v.getUint16(32, true)).toBe(2);
    expect(v.getUint16(34, true)).toBe(16);
    expect(tag(36)).toBe("data");
    expect(v.getUint32(40, true)).toBe(960);
  });

  it("round-trips samples within one LSB and clips out-of-range values", () => {
    const sr = 44100;
    const left = sine(1000, 220, sr, 0.9);
    const right = sine(1000, 330, sr, 0.3);
    left[10] = 1.7;
    left[11] = -2.0;
    const decoded = decodeWav16(encodeWav16([left, right], sr));
    expect(decoded.sampleRate).toBe(sr);
    expect(decoded.channels).toHaveLength(2);
    expect(decoded.channels[0]).toHaveLength(1000);
    for (let i = 0; i < 1000; i++) {
      if (i === 10 || i === 11) continue;
      expect(Math.abs(decoded.channels[0]![i]! - left[i]!)).toBeLessThan(1 / 32767 + 1e-6);
      expect(Math.abs(decoded.channels[1]![i]! - right[i]!)).toBeLessThan(1 / 32767 + 1e-6);
    }
    expect(decoded.channels[0]![10]).toBeCloseTo(1.0, 4);
    expect(decoded.channels[0]![11]).toBeCloseTo(-1.0, 4);
  });

  it("truncates to the shortest channel and refuses nonsense", () => {
    const decoded = decodeWav16(encodeWav16([new Float32Array(10), new Float32Array(7)], 8000));
    expect(decoded.channels[0]).toHaveLength(7);
    expect(() => encodeWav16([], 8000)).toThrow();
    expect(() => encodeWav16([new Float32Array(1)], 0)).toThrow();
    expect(() => decodeWav16(new ArrayBuffer(12))).toThrow();
  });
});

describe("mixToMono / wavDurationS", () => {
  it("averages channels", () => {
    const mono = mixToMono([Float32Array.from([1, 0.5]), Float32Array.from([0, -0.5])]);
    expect(Array.from(mono)).toEqual([0.5, 0]);
    const one = Float32Array.from([0.25]);
    expect(mixToMono([one])).toBe(one);
    expect(mixToMono([])).toHaveLength(0);
  });
  it("computes the duration from the byte length", () => {
    expect(wavDurationS(44 + 48000 * 2, 48000)).toBeCloseTo(1, 9);
    expect(wavDurationS(10, 48000)).toBe(0);
  });
});

describe("blobToWav", () => {
  it("decodes with the given decoder, mixes to mono and returns a WAV blob", async () => {
    const sr = 16000;
    const pcm: PcmLike = {
      numberOfChannels: 2,
      sampleRate: sr,
      length: 160,
      getChannelData: (c) => (c === 0 ? sine(160, 100, sr, 0.5) : sine(160, 100, sr, 0.5)),
    };
    const input = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" });
    let seen = 0;
    const out = await blobToWav(input, async (bytes) => {
      seen = bytes.byteLength;
      return pcm;
    });
    expect(seen).toBe(3);
    expect(out.type).toBe("audio/wav");
    const decoded = decodeWav16(await out.arrayBuffer());
    expect(decoded.sampleRate).toBe(sr);
    expect(decoded.channels).toHaveLength(1);
    expect(decoded.channels[0]).toHaveLength(160);
    expect(decoded.channels[0]![40]).toBeCloseTo(0.5 * Math.sin((2 * Math.PI * 100 * 40) / sr), 3);
  });
});
