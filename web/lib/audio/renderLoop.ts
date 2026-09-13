/**
 * Loop preview renderer: zero-crossing snap plus equal-power tail crossfade.
 *
 * Sample-exact port of `analysis/lockedgroove/loops/render.py` (the canonical
 * export). Both are asserted against the same vector,
 * `analysis/tests/fixtures/loop_render_vector.json`, built by
 * `scripts/gen_loop_vector.py` from the Python side. No dependencies; runs in
 * the browser (feed it `AudioBuffer.getChannelData(c)` per channel) and in Node.
 *
 * Rules shared with the Python implementation (keep them in step):
 *
 * - Seconds -> samples: `floor(x * sampleRate + 0.5)` (round half up).
 * - Zero-crossing decisions use the **mono sum** of the channels (summed in
 *   channel order, in doubles) so every channel moves together. Index `j` is a
 *   crossing when `m[j-1]` and `m[j]` have opposite signs or either is zero;
 *   the file boundaries `0` and `n` always count. The search runs
 *   `d = 0, 1, ..., maxSamples` trying `j - d` before `j + d` (ties resolve
 *   earlier), with `maxSamples = floor(maxMs * sampleRate / 1000)` so the snap
 *   can never exceed `maxMs`. No crossing in range -> the edge stays.
 * - Crossfade length `cf = floor(crossfadeMs * sampleRate / 1000 + 0.5)`,
 *   capped at half the loop length.
 * - Equal-power curve over `n` samples (`equalPowerCurve`):
 *
 *       theta_k   = (PI / 2) * k / (n - 1)     k = 0 .. n-1, n >= 2
 *       fadeIn_k  = sin(theta_k)               (n == 1: theta = PI / 4)
 *       fadeOut_k = cos(theta_k)
 *       fadeIn^2 + fadeOut^2 == 1
 *
 *   Sample 0 of the crossfade is entirely the outgoing material, sample n-1
 *   entirely the incoming one.
 * - `mode = "tail"` when `end + cf <= n`: the audio *after* `end` wraps into
 *   the head, `out[k] = y[start+k] * fadeIn[k] + y[end+k] * fadeOut[k]` for
 *   `k < cf`, so the wrap `out[L-1] -> out[0]` is `y[end-1] -> y[end]`, the
 *   recording's own continuity.
 * - `mode = "self"` otherwise (the loop ends at the end of the file): the
 *   crossfade moves to the loop's tail and blends in the audio that *precedes*
 *   `start` (`nPre = min(cf, start)` samples),
 *   `out[L-nPre+k] = y[end-nPre+k] * fadeOut[k] + y[start-nPre+k] * fadeIn[k]`,
 *   so the wrap is `y[start-1] -> y[start]`. With no audio before `start`
 *   either (the loop is the whole file) the cut is raw and `crossfadeSamples`
 *   is 0.
 * - Output length is exactly `end - start` samples after snapping, one
 *   `Float32Array` per input channel.
 * - Arithmetic in doubles, stored to `Float32Array` (numpy: float64 -> float32),
 *   same operation order, so results agree to float32 rounding.
 */

/** OPEN_QUESTIONS D.20: 12 ms equal-power crossfade. */
export const DEFAULT_CROSSFADE_MS = 12;
/** OPEN_QUESTIONS D.20: snap within ±2 ms, never further. */
export const ZERO_CROSSING_MAX_MS = 2;

export type LoopRenderMode = "tail" | "self";

export interface RenderLoopOptions {
  /** Crossfade length in ms; default 12. 0 gives a raw cut. */
  crossfadeMs?: number;
  /** Snap both edges to the nearest zero crossing of the mono sum within ±2 ms; default true. */
  snapZeroCrossing?: boolean;
}

/** Mirrors the Python `meta` dict (snake_case there, camelCase here). */
export interface RenderLoopMeta {
  startS: number;
  endS: number;
  startSample: number;
  endSample: number;
  /** Requested crossfade in ms. */
  crossfadeMs: number;
  /** Effective crossfade in samples (may be shorter than requested near the file edges). */
  crossfadeSamples: number;
  mode: LoopRenderMode;
  /** Signed shift the start edge moved, in ms. */
  snappedStartMs: number;
  /** Signed shift the end edge moved, in ms. */
  snappedEndMs: number;
  sampleRate: number;
  channels: number;
  lengthSamples: number;
}

export interface RenderLoopResult {
  channels: Float32Array[];
  /** Start after snapping, seconds. */
  startS: number;
  /** End after snapping, seconds. */
  endS: number;
  meta: RenderLoopMeta;
}

/** `floor(x + 0.5)`: the one rounding rule used for seconds -> samples. */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/** Sum of the channels in channel order, as doubles (the zero-crossing signal). */
export function monoSum(channels: Float32Array[]): Float64Array {
  const n = channels.length > 0 ? channels[0].length : 0;
  const m = new Float64Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) {
      m[i] += ch[i];
    }
  }
  return m;
}

function isZeroCrossing(m: Float64Array, j: number): boolean {
  const n = m.length;
  if (j <= 0 || j >= n) {
    return true;
  }
  const a = m[j - 1];
  const b = m[j];
  return (a <= 0 && b >= 0) || (a >= 0 && b <= 0);
}

/**
 * Nearest zero crossing of an already-summed mono signal within ±maxMs of
 * `sampleIndex`; the index itself when none is in range.
 */
export function snapMonoToZeroCrossing(
  mono: Float64Array,
  sampleRate: number,
  sampleIndex: number,
  maxMs: number = ZERO_CROSSING_MAX_MS,
): number {
  const n = mono.length;
  const idx = Math.min(Math.max(Math.trunc(sampleIndex), 0), n);
  let maxSamples = Math.floor((maxMs * sampleRate) / 1000);
  if (!(maxSamples >= 0)) {
    maxSamples = 0;
  }
  for (let d = 0; d <= maxSamples; d++) {
    if (d === 0) {
      if (isZeroCrossing(mono, idx)) {
        return idx;
      }
      continue;
    }
    const lo = idx - d;
    if (lo >= 0 && isZeroCrossing(mono, lo)) {
      return lo;
    }
    const hi = idx + d;
    if (hi <= n && isZeroCrossing(mono, hi)) {
      return hi;
    }
  }
  return idx;
}

/**
 * Nearest zero crossing of the channels' mono sum within ±maxMs of
 * `sampleIndex`. Never moves more than `maxMs`; returns `sampleIndex` when no
 * crossing is in range.
 */
export function snapToZeroCrossing(
  channels: Float32Array[],
  sampleRate: number,
  sampleIndex: number,
  maxMs: number = ZERO_CROSSING_MAX_MS,
): number {
  return snapMonoToZeroCrossing(monoSum(channels), sampleRate, sampleIndex, maxMs);
}

/** `{ fadeIn, fadeOut }` of length `n`; see the module comment for the formula. */
export function equalPowerCurve(n: number): { fadeIn: Float64Array; fadeOut: Float64Array } {
  const len = Math.max(0, Math.trunc(n));
  const fadeIn = new Float64Array(len);
  const fadeOut = new Float64Array(len);
  if (len === 1) {
    fadeIn[0] = Math.sin(Math.PI / 4);
    fadeOut[0] = Math.cos(Math.PI / 4);
    return { fadeIn, fadeOut };
  }
  for (let k = 0; k < len; k++) {
    const theta = ((Math.PI / 2) * k) / (len - 1);
    fadeIn[k] = Math.sin(theta);
    fadeOut[k] = Math.cos(theta);
  }
  return { fadeIn, fadeOut };
}

/**
 * Render `[startS, endS)` of `channels` as a seamless loop for preview.
 *
 * Throws on an empty or non-rectangular input, a non-positive sample rate, or
 * `endS <= startS`.
 */
export function renderLoopPreview(
  channels: Float32Array[],
  sampleRate: number,
  startS: number,
  endS: number,
  opts: RenderLoopOptions = {},
): RenderLoopResult {
  const snap = opts.snapZeroCrossing ?? true;
  const requested = opts.crossfadeMs ?? DEFAULT_CROSSFADE_MS;
  const crossfadeMs = Number.isFinite(requested) && requested >= 0 ? requested : 0;

  if (!(sampleRate > 0)) {
    throw new Error("renderLoopPreview: sample rate must be positive");
  }
  if (!Number.isFinite(startS) || !Number.isFinite(endS) || endS <= startS) {
    throw new Error("renderLoopPreview: endS must be greater than startS");
  }
  const nCh = channels.length;
  if (nCh === 0) {
    throw new Error("renderLoopPreview: no channels");
  }
  const n = channels[0].length;
  if (n === 0) {
    throw new Error("renderLoopPreview: empty audio");
  }
  for (const ch of channels) {
    if (ch.length !== n) {
      throw new Error("renderLoopPreview: channels must have the same length");
    }
  }

  const start0 = Math.min(Math.max(roundHalfUp(startS * sampleRate), 0), n);
  const end0 = Math.min(Math.max(roundHalfUp(endS * sampleRate), 0), n);
  if (end0 <= start0) {
    throw new Error("renderLoopPreview: loop is empty after rounding to samples");
  }

  let start = start0;
  let end = end0;
  if (snap) {
    const m = monoSum(channels);
    start = snapMonoToZeroCrossing(m, sampleRate, start0, ZERO_CROSSING_MAX_MS);
    end = snapMonoToZeroCrossing(m, sampleRate, end0, ZERO_CROSSING_MAX_MS);
    if (end <= start) {
      start = start0;
      end = end0;
    }
  }
  const length = end - start;

  let cf = roundHalfUp((crossfadeMs * sampleRate) / 1000);
  cf = Math.max(0, Math.min(cf, Math.floor(length / 2)));

  const out = channels.map((ch) => ch.slice(start, end));
  let mode: LoopRenderMode;
  let nCf: number;
  if (end + cf <= n) {
    mode = "tail";
    nCf = cf;
    if (nCf > 0) {
      const { fadeIn, fadeOut } = equalPowerCurve(nCf);
      for (let c = 0; c < nCh; c++) {
        const ch = channels[c];
        const o = out[c];
        for (let k = 0; k < nCf; k++) {
          o[k] = ch[start + k] * fadeIn[k] + ch[end + k] * fadeOut[k];
        }
      }
    }
  } else {
    mode = "self";
    nCf = Math.min(cf, start);
    if (nCf > 0) {
      const { fadeIn, fadeOut } = equalPowerCurve(nCf);
      for (let c = 0; c < nCh; c++) {
        const ch = channels[c];
        const o = out[c];
        for (let k = 0; k < nCf; k++) {
          o[length - nCf + k] = ch[end - nCf + k] * fadeOut[k] + ch[start - nCf + k] * fadeIn[k];
        }
      }
    }
  }

  const meta: RenderLoopMeta = {
    startS: start / sampleRate,
    endS: end / sampleRate,
    startSample: start,
    endSample: end,
    crossfadeMs,
    crossfadeSamples: nCf,
    mode,
    snappedStartMs: ((start - start0) * 1000) / sampleRate,
    snappedEndMs: ((end - end0) * 1000) / sampleRate,
    sampleRate,
    channels: nCh,
    lengthSamples: length,
  };
  return { channels: out, startS: meta.startS, endS: meta.endS, meta };
}
