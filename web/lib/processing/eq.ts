// The EQ, as arithmetic.
//
// Two jobs, and they have to be the same arithmetic or the product lies: work
// out what a filter does to a signal, and draw the curve the producer sees.
// The formulas are the ones the Web Audio specification prescribes for
// BiquadFilterNode (the RBJ audio cookbook), so the line on screen is the
// response of the filter that is actually running, not an artist's impression
// of it. That matters more here than in a normal EQ: the whole point of the
// feature is that when the AI moves something, the producer can see exactly
// what it did.
//
// Two details the spec fixes and this file therefore fixes too:
//
//   The shelves ignore Q. BiquadFilterNode computes lowshelf and highshelf
//   with S = 1, so a Q on a shelf would move the drawing and not the sound.
//
//   A peaking filter at 0 dB and a shelf at 0 dB are exactly unity (b == a),
//   which is what lets a disabled band sit in the graph costing nothing.
//
// No Web Audio here, and no React: every claim below is asserted in node.

import { BAND_KINDS, clamp, MAX_FREQ_HZ, MIN_FREQ_HZ, type BandKind, type EqBand } from "./types";

/** The five coefficients, already normalised by a0. */
export interface Biquad {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export const UNITY: Biquad = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };

/**
 * The coefficients BiquadFilterNode will use for these settings.
 *
 * `sampleRate` is the running context's, not a constant: at 44.1 kHz and at
 * 48 kHz the same filter has slightly different coefficients near the top of
 * the band, and the curve should show the one the producer is hearing.
 */
export function biquad(kind: BandKind, frequencyHz: number, q: number, gainDb: number, sampleRate: number): Biquad {
  const nyquist = sampleRate / 2;
  const f0 = clamp(frequencyHz, 0.0001, nyquist * 0.9999);
  const w0 = (2 * Math.PI * f0) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const safeQ = Math.max(1e-4, q);

  switch (kind) {
    case "lowpass": {
      const alpha = sinw / (2 * safeQ);
      const b1 = 1 - cosw;
      return norm(b1 / 2, b1, b1 / 2, 1 + alpha, -2 * cosw, 1 - alpha);
    }
    case "highpass": {
      const alpha = sinw / (2 * safeQ);
      const b0 = (1 + cosw) / 2;
      return norm(b0, -(1 + cosw), b0, 1 + alpha, -2 * cosw, 1 - alpha);
    }
    case "peaking": {
      const A = 10 ** (gainDb / 40);
      const alpha = sinw / (2 * safeQ);
      return norm(1 + alpha * A, -2 * cosw, 1 - alpha * A, 1 + alpha / A, -2 * cosw, 1 - alpha / A);
    }
    case "lowshelf": {
      // S = 1, per the specification; Q is deliberately not read.
      const A = 10 ** (gainDb / 40);
      const alpha = (sinw / 2) * Math.SQRT2;
      const shape = 2 * alpha * Math.sqrt(A);
      return norm(
        A * (A + 1 - (A - 1) * cosw + shape),
        2 * A * (A - 1 - (A + 1) * cosw),
        A * (A + 1 - (A - 1) * cosw - shape),
        A + 1 + (A - 1) * cosw + shape,
        -2 * (A - 1 + (A + 1) * cosw),
        A + 1 + (A - 1) * cosw - shape,
      );
    }
    case "highshelf": {
      const A = 10 ** (gainDb / 40);
      const alpha = (sinw / 2) * Math.SQRT2;
      const shape = 2 * alpha * Math.sqrt(A);
      return norm(
        A * (A + 1 + (A - 1) * cosw + shape),
        -2 * A * (A - 1 + (A + 1) * cosw),
        A * (A + 1 + (A - 1) * cosw - shape),
        A + 1 - (A - 1) * cosw + shape,
        2 * (A - 1 - (A + 1) * cosw),
        A + 1 - (A - 1) * cosw - shape,
      );
    }
  }
}

function norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad {
  if (!Number.isFinite(a0) || a0 === 0) return UNITY;
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/** |H(e^jw)| for one biquad at one frequency. Linear, not dB. */
export function magnitude(c: Biquad, frequencyHz: number, sampleRate: number): number {
  const w = (2 * Math.PI * frequencyHz) / sampleRate;
  const cos1 = Math.cos(w);
  const sin1 = Math.sin(w);
  const cos2 = Math.cos(2 * w);
  const sin2 = Math.sin(2 * w);
  const numRe = c.b0 + c.b1 * cos1 + c.b2 * cos2;
  const numIm = -(c.b1 * sin1 + c.b2 * sin2);
  const denRe = 1 + c.a1 * cos1 + c.a2 * cos2;
  const denIm = -(c.a1 * sin1 + c.a2 * sin2);
  const den = denRe * denRe + denIm * denIm;
  if (den <= 0) return 0;
  return Math.sqrt((numRe * numRe + numIm * numIm) / den);
}

export function toDb(linear: number): number {
  if (!(linear > 0)) return -120;
  return Math.max(-120, 20 * Math.log10(linear));
}

/** What one band does at one frequency, in dB. A disabled band does nothing at all. */
export function bandDbAt(band: EqBand, frequencyHz: number, sampleRate: number): number {
  if (!band.enabled) return 0;
  return toDb(magnitude(biquad(band.kind, band.frequency, band.q, band.gainDb, sampleRate), frequencyHz, sampleRate));
}

/**
 * The whole chain at one frequency. Filters in series multiply their
 * magnitudes, so in dB they add — which is why the drawn curve is a sum and
 * why a 3 dB cut under a 3 dB boost at the same spot really is flat.
 */
export function responseDbAt(bands: readonly EqBand[], frequencyHz: number, sampleRate: number): number {
  let db = 0;
  for (const band of bands) db += bandDbAt(band, frequencyHz, sampleRate);
  return db;
}

export interface CurvePoint {
  hz: number;
  db: number;
}

export interface CurveOptions {
  sampleRate: number;
  points?: number;
  fromHz?: number;
  toHz?: number;
}

/**
 * The drawn curve: `points` samples, spaced evenly on a log frequency axis,
 * because that is how hearing is spaced and how the eye reads an EQ.
 */
export function responseCurve(bands: readonly EqBand[], options: CurveOptions): CurvePoint[] {
  const points = Math.max(2, Math.round(options.points ?? 160));
  const fromHz = Math.max(1, options.fromHz ?? MIN_FREQ_HZ);
  const toHz = Math.max(fromHz * 1.0001, options.toHz ?? MAX_FREQ_HZ);
  const out: CurvePoint[] = [];
  for (let i = 0; i < points; i++) {
    const hz = fromHz * (toHz / fromHz) ** (i / (points - 1));
    out.push({ hz, db: responseDbAt(bands, hz, options.sampleRate) });
  }
  return out;
}

// --- the axes ---------------------------------------------------------------
// Shared by the drawing and by the pointer arithmetic, so a handle dragged to
// a place on screen reports the frequency the curve is drawn at there.

export function freqToRatio(hz: number, fromHz = MIN_FREQ_HZ, toHz = MAX_FREQ_HZ): number {
  const safe = Math.max(1e-6, hz);
  return Math.log(safe / fromHz) / Math.log(toHz / fromHz);
}

export function ratioToFreq(ratio: number, fromHz = MIN_FREQ_HZ, toHz = MAX_FREQ_HZ): number {
  return fromHz * (toHz / fromHz) ** ratio;
}

/** dB to a 0..1 ratio measured from the top of the display, which is how SVG counts y. */
export function dbToRatio(db: number, spanDb: number): number {
  return 0.5 - db / (2 * spanDb);
}

export function ratioToDb(ratio: number, spanDb: number): number {
  return (0.5 - ratio) * 2 * spanDb;
}

/** The gridlines an EQ display has always had, so the eye can find 1 kHz without reading. */
export const AXIS_HZ: readonly number[] = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

/** "240 Hz", "1.2 kHz" — the way a producer says it. */
export function formatHz(hz: number): string {
  if (hz >= 1000) return `${Math.round(hz / 100) / 10} kHz`;
  return `${Math.round(hz)} Hz`;
}

export function formatDb(db: number): string {
  const rounded = Math.round(db * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded} dB`;
}

/** The kind a slot uses. Kept next to the arithmetic so a band built by hand cannot be the wrong shape. */
export function kindFor(id: EqBand["id"]): BandKind {
  return BAND_KINDS[id];
}
