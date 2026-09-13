// The EQ's arithmetic. These are the assertions that make the drawn curve
// trustworthy: if a peaking filter does not give exactly its stated gain at
// its own frequency, the line on screen is decoration and the whole premise —
// "a real, visible, editable EQ curve" — is gone.

import { describe as group, expect, it } from "vitest";
import { bandDbAt, biquad, formatDb, formatHz, freqToRatio, magnitude, ratioToDb, ratioToFreq, responseCurve, responseDbAt, toDb, UNITY } from "./eq";
import { defaultBands, setBand } from "./chain";
import { BAND_KINDS, type EqBand } from "./types";

const RATE = 48000;

function band(overrides: Partial<EqBand> & Pick<EqBand, "id">): EqBand {
  return { kind: BAND_KINDS[overrides.id], frequency: 1000, gainDb: 0, q: 1, enabled: true, ...overrides };
}

function dbAt(b: EqBand, hz: number): number {
  return bandDbAt(b, hz, RATE);
}

group("what a filter actually does", () => {
  it("gives a peaking band exactly its stated gain at its own frequency", () => {
    for (const gainDb of [-12, -6, -3, 3, 6, 9]) {
      const b = band({ id: "mid", frequency: 1000, gainDb, q: 1.2 });
      expect(dbAt(b, 1000)).toBeCloseTo(gainDb, 6);
    }
  });

  it("leaves the rest of the spectrum alone when a peak is narrow", () => {
    const b = band({ id: "mid", frequency: 1000, gainDb: 6, q: 4 });
    expect(Math.abs(dbAt(b, 100))).toBeLessThan(0.3);
    expect(Math.abs(dbAt(b, 10000))).toBeLessThan(0.3);
  });

  it("spreads a wide peak further than a narrow one, which is what Q means", () => {
    const wide = band({ id: "mid", frequency: 1000, gainDb: 6, q: 0.5 });
    const narrow = band({ id: "mid", frequency: 1000, gainDb: 6, q: 6 });
    expect(dbAt(wide, 400)).toBeGreaterThan(dbAt(narrow, 400));
    expect(dbAt(wide, 1000)).toBeCloseTo(dbAt(narrow, 1000), 6);
  });

  it("puts a Butterworth high-pass 3 dB down at its own corner and lets the top through", () => {
    const b = band({ id: "hp", frequency: 100, q: Math.SQRT1_2 });
    expect(dbAt(b, 100)).toBeCloseTo(-3.0103, 3);
    expect(dbAt(b, 1000)).toBeGreaterThan(-0.1);
    expect(dbAt(b, 25)).toBeLessThan(-20);
  });

  it("does the same from the other end for a low-pass", () => {
    const b = band({ id: "lp", frequency: 4000, q: Math.SQRT1_2 });
    expect(dbAt(b, 4000)).toBeCloseTo(-3.0103, 3);
    expect(dbAt(b, 400)).toBeGreaterThan(-0.1);
    expect(dbAt(b, 16000)).toBeLessThan(-20);
  });

  it("gives a low shelf its full gain underneath and nothing at the top", () => {
    const b = band({ id: "ls", frequency: 200, gainDb: 6 });
    expect(dbAt(b, 20)).toBeCloseTo(6, 1);
    expect(dbAt(b, 200)).toBeCloseTo(3, 1);
    expect(Math.abs(dbAt(b, 10000))).toBeLessThan(0.2);
  });

  it("gives a high shelf its full gain on top and nothing underneath", () => {
    const b = band({ id: "hs", frequency: 6000, gainDb: -6 });
    expect(dbAt(b, 20000)).toBeCloseTo(-6, 0);
    expect(dbAt(b, 6000)).toBeCloseTo(-3, 1);
    expect(Math.abs(dbAt(b, 100))).toBeLessThan(0.2);
  });

  it("is exactly unity at 0 dB, which is what lets a disabled slot cost nothing", () => {
    for (const kind of ["peaking", "lowshelf", "highshelf"] as const) {
      const c = biquad(kind, 1000, 1, 0, RATE);
      // b == a is the whole claim: numerator and denominator cancel, so H(z) = 1.
      expect(c.b0).toBeCloseTo(1, 12);
      expect(c.b1).toBeCloseTo(c.a1, 12);
      expect(c.b2).toBeCloseTo(c.a2, 12);
      for (const hz of [20, 200, 2000, 20000]) expect(toDb(magnitude(c, hz, RATE))).toBeCloseTo(0, 10);
    }
  });

  it("reads the same filter differently at 44.1 kHz and at 48 kHz near the top, as the browser does", () => {
    const b = band({ id: "hs", frequency: 12000, gainDb: 6 });
    const at48 = bandDbAt(b, 19000, 48000);
    const at441 = bandDbAt(b, 19000, 44100);
    expect(at48).not.toBeCloseTo(at441, 3);
  });
});

group("the chain as a whole", () => {
  it("adds bands in dB, because filters in series multiply", () => {
    const boost = band({ id: "lo", frequency: 300, gainDb: 4, q: 1 });
    const cut = band({ id: "mid", frequency: 300, gainDb: -4, q: 1, kind: "peaking" });
    expect(responseDbAt([boost, cut], 300, RATE)).toBeCloseTo(0, 6);
    expect(responseDbAt([boost], 300, RATE)).toBeCloseTo(4, 6);
  });

  it("ignores a disabled band entirely rather than nearly", () => {
    const b = band({ id: "hp", frequency: 400, enabled: false });
    for (const hz of [20, 50, 100, 1000]) expect(dbAt(b, hz)).toBe(0);
  });

  it("is flat when nothing is switched on", () => {
    const bands = defaultBands();
    for (const hz of [20, 60, 250, 1000, 8000, 20000]) expect(responseDbAt(bands, hz, RATE)).toBe(0);
  });

  it("draws a curve on a log axis, at the rate that is sounding", () => {
    const bands = setBand({ bypassed: false, trimDb: 0, tuneCents: 0, bands: defaultBands() }, "lo", { frequency: 250, gainDb: -6, q: 1.2, enabled: true }).bands;
    const curve = responseCurve(bands, { sampleRate: RATE, points: 200 });
    expect(curve).toHaveLength(200);
    expect(curve[0]?.hz).toBeCloseTo(20, 6);
    expect(curve[199]?.hz).toBeCloseTo(20000, 6);
    // evenly spaced in ratio, not in Hz
    const first = (curve[1]?.hz ?? 0) / (curve[0]?.hz ?? 1);
    const last = (curve[199]?.hz ?? 0) / (curve[198]?.hz ?? 1);
    expect(first).toBeCloseTo(last, 6);
    const deepest = curve.reduce((low, point) => (point.db < low.db ? point : low), curve[0]!);
    expect(deepest.hz).toBeGreaterThan(200);
    expect(deepest.hz).toBeLessThan(320);
    expect(deepest.db).toBeCloseTo(-6, 1);
  });

  it("has a unity biquad to fall back on rather than producing NaN", () => {
    expect(magnitude(UNITY, 1000, RATE)).toBe(1);
    expect(toDb(0)).toBe(-120);
  });
});

group("the axes the drawing and the pointer share", () => {
  it("round-trips a frequency through its place on screen", () => {
    for (const hz of [20, 55, 240, 1000, 7300, 20000]) expect(ratioToFreq(freqToRatio(hz))).toBeCloseTo(hz, 6);
  });

  it("puts 1 kHz where the eye expects it on a 20 Hz to 20 kHz log axis", () => {
    expect(freqToRatio(20)).toBeCloseTo(0, 9);
    expect(freqToRatio(20000)).toBeCloseTo(1, 9);
    expect(freqToRatio(632.45)).toBeCloseTo(0.5, 3);
  });

  it("round-trips dB through its place on screen, with 0 dB in the middle", () => {
    expect(ratioToDb(0.5, 18)).toBeCloseTo(0, 9);
    expect(ratioToDb(0, 18)).toBeCloseTo(18, 9);
    expect(ratioToDb(1, 18)).toBeCloseTo(-18, 9);
  });

  it("says frequencies and gains the way a producer does", () => {
    expect(formatHz(240)).toBe("240 Hz");
    expect(formatHz(1200)).toBe("1.2 kHz");
    expect(formatHz(12000)).toBe("12 kHz");
    expect(formatDb(-3.25)).toBe("-3.2 dB");
    expect(formatDb(4)).toBe("+4 dB");
  });
});
