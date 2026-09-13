import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  DEFAULT_CROSSFADE_MS,
  ZERO_CROSSING_MAX_MS,
  equalPowerCurve,
  monoSum,
  renderLoopPreview,
  snapToZeroCrossing,
} from "./renderLoop";

/** Shape of analysis/tests/fixtures/loop_render_vector.json (scripts/gen_loop_vector.py). */
interface ExpectedCase {
  start_sample: number;
  end_sample: number;
  start_s: number;
  end_s: number;
  crossfade_samples: number;
  mode: "tail" | "self";
  snapped_start_ms: number;
  snapped_end_ms: number;
  length: number;
  channels: number;
  indices: number[];
  values: number[][];
}

interface CaseParams {
  start_s: number;
  end_s: number;
  crossfade_ms: number;
  snap_zero_crossing: boolean;
}

interface Vector extends CaseParams {
  version: number;
  tolerance: number;
  sample_rate: number;
  channels: number[][];
  expected: ExpectedCase;
  extra_cases: Array<CaseParams & { name: string; channel_indices: number[]; expected: ExpectedCase }>;
}

const vectorUrl = new URL("../../../analysis/tests/fixtures/loop_render_vector.json", import.meta.url);
const vector = JSON.parse(readFileSync(vectorUrl, "utf8")) as Vector;

function inputChannels(indices: number[]): Float32Array[] {
  return indices.map((i) => Float32Array.from(vector.channels[i]));
}

function checkCase(params: CaseParams, channelIndices: number[], expected: ExpectedCase): void {
  const result = renderLoopPreview(inputChannels(channelIndices), vector.sample_rate, params.start_s, params.end_s, {
    crossfadeMs: params.crossfade_ms,
    snapZeroCrossing: params.snap_zero_crossing,
  });
  expect(result.meta.startSample).toBe(expected.start_sample);
  expect(result.meta.endSample).toBe(expected.end_sample);
  expect(result.startS).toBe(expected.start_s);
  expect(result.endS).toBe(expected.end_s);
  expect(result.meta.mode).toBe(expected.mode);
  expect(result.meta.crossfadeSamples).toBe(expected.crossfade_samples);
  expect(result.meta.snappedStartMs).toBe(expected.snapped_start_ms);
  expect(result.meta.snappedEndMs).toBe(expected.snapped_end_ms);
  expect(result.channels.length).toBe(expected.channels);
  for (const ch of result.channels) {
    expect(ch.length).toBe(expected.length);
  }
  let worst = 0;
  for (let c = 0; c < expected.channels; c++) {
    expected.indices.forEach((idx, k) => {
      worst = Math.max(worst, Math.abs(result.channels[c][idx] - expected.values[c][k]));
    });
  }
  expect(worst).toBeLessThan(vector.tolerance);
}

describe("renderLoopPreview against the shared Python vector", () => {
  it("has the vector the Python tests use", () => {
    expect(vector.version).toBe(1);
    expect(vector.sample_rate).toBe(8000);
    expect(vector.channels.length).toBe(2);
    expect(vector.expected.indices.length).toBeGreaterThanOrEqual(250);
    expect(vector.tolerance).toBe(1e-4);
  });

  it("matches the primary tail-mode case at every listed index and on the snapped edges", () => {
    expect(vector.expected.mode).toBe("tail");
    checkCase(vector, [0, 1], vector.expected);
  });

  it("matches the extra cases (self mode at end of file, no snap, mono, whole file)", () => {
    const names = vector.extra_cases.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["self_mode_end_of_file", "no_snap", "mono_short_crossfade", "whole_file_raw"]),
    );
    for (const c of vector.extra_cases) {
      checkCase(c, c.channel_indices, c.expected);
    }
    expect(vector.extra_cases.find((c) => c.name === "self_mode_end_of_file")?.expected.mode).toBe("self");
    expect(vector.extra_cases.find((c) => c.name === "whole_file_raw")?.expected.crossfade_samples).toBe(0);
  });
});

function stereoTone(sampleRate = 44100, seconds = 2, hz = 110, amp = 0.6): Float32Array[] {
  const n = Math.round(seconds * sampleRate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    left[i] = amp * Math.sin(2 * Math.PI * hz * t);
    right[i] = 0.8 * amp * Math.sin(2 * Math.PI * hz * t + 0.5);
  }
  return [left, right];
}

function maxStep(chs: Float32Array[]): number {
  let worst = 0;
  for (const ch of chs) {
    for (let i = 1; i < ch.length; i++) {
      worst = Math.max(worst, Math.abs(ch[i] - ch[i - 1]));
    }
    worst = Math.max(worst, Math.abs(ch[0] - ch[ch.length - 1])); // the wrap
  }
  return worst;
}

describe("renderLoopPreview behaviour", () => {
  const sr = 44100;
  const naturalStep = (0.6 * 2 * Math.PI * 110) / sr;

  it("removes the seam click with the tail crossfade", () => {
    const y = stereoTone(sr);
    const s0 = Math.floor(0.1 * sr + 0.5);
    const e0 = Math.floor(0.5023 * sr + 0.5);
    expect(Math.abs(y[0][s0] - y[0][e0 - 1])).toBeGreaterThan(0.3);
    const { channels, meta } = renderLoopPreview(y, sr, 0.1, 0.5023);
    expect(meta.mode).toBe("tail");
    expect(meta.crossfadeSamples).toBe(Math.floor((DEFAULT_CROSSFADE_MS * sr) / 1000 + 0.5));
    expect(channels[0].length).toBe(meta.endSample - meta.startSample);
    expect(Math.abs(channels[0][0] - channels[0][channels[0].length - 1])).toBeLessThan(0.05);
    expect(maxStep(channels)).toBeLessThan(3 * naturalStep);
  });

  it("falls back to the self crossfade at the end of the file", () => {
    const y = stereoTone(sr, 2);
    const { channels, meta } = renderLoopPreview(y, sr, 0.1, 1.995);
    expect(meta.mode).toBe("self");
    expect(meta.crossfadeSamples).toBeGreaterThan(0);
    expect(maxStep(channels)).toBeLessThan(3 * naturalStep);
    const whole = renderLoopPreview(y, sr, 0, 2);
    expect(whole.meta.mode).toBe("self");
    expect(whole.meta.crossfadeSamples).toBe(0);
    expect(whole.channels[1]).toEqual(y[1]);
  });

  it("keeps exact edges with snapping off and preserves the channel count", () => {
    const y = stereoTone(sr);
    const r = renderLoopPreview(y, sr, 0.1, 0.5015, { snapZeroCrossing: false, crossfadeMs: 0 });
    expect(r.meta.startSample).toBe(Math.floor(0.1 * sr + 0.5));
    expect(r.meta.endSample).toBe(Math.floor(0.5015 * sr + 0.5));
    expect(r.meta.snappedStartMs).toBe(0);
    expect(r.channels.length).toBe(2);
    expect(r.channels[0]).toEqual(y[0].slice(r.meta.startSample, r.meta.endSample));
    const mono = renderLoopPreview([y[0]], sr, 0.1, 0.5);
    expect(mono.channels.length).toBe(1);
  });

  it("throws on bad input", () => {
    const y = stereoTone(sr, 0.5);
    expect(() => renderLoopPreview(y, sr, 0.2, 0.2)).toThrow();
    expect(() => renderLoopPreview(y, sr, 0.3, 0.2)).toThrow();
    expect(() => renderLoopPreview(y, 0, 0, 0.1)).toThrow();
    expect(() => renderLoopPreview([], sr, 0, 0.1)).toThrow();
    expect(() => renderLoopPreview([y[0], y[1].slice(0, 10)], sr, 0, 0.1)).toThrow();
  });
});

describe("snapToZeroCrossing", () => {
  it("never moves more than maxMs and lands on a crossing of the mono sum", () => {
    const sr = 22050;
    const n = 6000;
    let seed = 12345;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648 - 0.5;
    };
    const chs = [new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      chs[0][i] = rand();
      chs[1][i] = rand();
    }
    const m = monoSum(chs);
    for (let idx = 0; idx <= n; idx += 37) {
      const j = snapToZeroCrossing(chs, sr, idx, ZERO_CROSSING_MAX_MS);
      expect(Math.abs(j - idx) * 1000 / sr).toBeLessThanOrEqual(ZERO_CROSSING_MAX_MS);
      if (j > 0 && j < n) {
        const a = m[j - 1];
        const b = m[j];
        expect((a <= 0 && b >= 0) || (a >= 0 && b <= 0)).toBe(true);
      }
    }
    expect(snapToZeroCrossing(chs, sr, 0)).toBe(0);
    expect(snapToZeroCrossing(chs, sr, n)).toBe(n);
  });

  it("keeps the edge when no crossing is within range", () => {
    const n = 8000;
    const dc = new Float32Array(n).fill(0.4);
    expect(snapToZeroCrossing([dc, dc], 8000, 1234)).toBe(1234);
    const one = new Float32Array(n).fill(0.2);
    one.fill(-0.2, 4000);
    const other = new Float32Array(n).fill(-0.1);
    expect(snapToZeroCrossing([one, other], 8000, 3990)).toBe(4000); // 10 samples = 1.25 ms away
    expect(snapToZeroCrossing([one, other], 8000, 3983)).toBe(3983); // 17 samples > 16 allowed
  });
});

describe("equalPowerCurve", () => {
  it("is sin/cos over the crossfade with unit power and exact endpoints", () => {
    const { fadeIn, fadeOut } = equalPowerCurve(529);
    expect(fadeIn[0]).toBe(0);
    expect(fadeOut[0]).toBe(1);
    expect(fadeIn[528]).toBeCloseTo(1, 12);
    expect(Math.abs(fadeOut[528])).toBeLessThan(1e-12);
    for (let k = 0; k < 529; k++) {
      expect(Math.abs(fadeIn[k] * fadeIn[k] + fadeOut[k] * fadeOut[k] - 1)).toBeLessThan(1e-12);
      if (k > 0) {
        expect(fadeIn[k]).toBeGreaterThan(fadeIn[k - 1]);
      }
    }
    const single = equalPowerCurve(1);
    expect(single.fadeIn[0]).toBeCloseTo(Math.SQRT1_2, 12);
    expect(equalPowerCurve(0).fadeIn.length).toBe(0);
  });
});
