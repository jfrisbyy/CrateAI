// Tuning, and the honesty about what it costs. This resamples: the lane eats
// its source faster or slower, exactly the way a region's own rate already
// does. The test that matters most is the last one — the interface has to be
// able to say how much time moved, because a producer who thinks this is a
// pitch shifter will be surprised four bars later.

import { describe as group, expect, it } from "vitest";
import { centsForRate, describeTune, effectiveRate, rateForCents, timeCostPercent } from "./tune";
import { MAX_TUNE_CENTS } from "./types";

group("cents and rates", () => {
  it("makes an octave a doubling", () => {
    expect(rateForCents(1200)).toBeCloseTo(2, 9);
    expect(rateForCents(-1200)).toBeCloseTo(0.5, 9);
    expect(rateForCents(0)).toBe(1);
  });

  it("makes a semitone the twelfth root of two", () => {
    expect(rateForCents(100)).toBeCloseTo(2 ** (1 / 12), 9);
  });

  it("round-trips", () => {
    for (const cents of [-700, -50, -7, 0, 12, 240, 900]) expect(centsForRate(rateForCents(cents))).toBeCloseTo(cents, 6);
  });

  it("stops at an octave either way, because past that a producer wants a render", () => {
    expect(rateForCents(9000)).toBe(rateForCents(MAX_TUNE_CENTS));
    expect(rateForCents(-9000)).toBe(rateForCents(-MAX_TUNE_CENTS));
  });

  it("survives nonsense rather than producing one", () => {
    expect(rateForCents(Number.NaN)).toBe(1);
    expect(centsForRate(0)).toBe(0);
    expect(centsForRate(-1)).toBe(0);
  });
});

group("on top of a region that is already resampled", () => {
  it("multiplies, because fitting a break and tuning it are the same kind of move", () => {
    expect(effectiveRate(0.964, 0)).toBeCloseTo(0.964, 9);
    expect(effectiveRate(0.964, 1200)).toBeCloseTo(1.928, 9);
    expect(effectiveRate(1, 100)).toBeCloseTo(2 ** (1 / 12), 9);
  });

  it("treats a missing or impossible region rate as unity", () => {
    expect(effectiveRate(0, 0)).toBe(1);
    expect(effectiveRate(Number.NaN, 0)).toBe(1);
  });
});

group("what it says out loud", () => {
  it("names whole semitones as semitones and the rest as cents", () => {
    expect(describeTune(0)).toBe("in tune");
    expect(describeTune(100)).toBe("+1 semitone");
    expect(describeTune(-200)).toBe("-2 semitones");
    expect(describeTune(30)).toBe("+30 cents");
    expect(describeTune(-45)).toBe("-45 cents");
  });

  it("says how much time moved, because tuning here is resampling", () => {
    expect(timeCostPercent(0)).toBeCloseTo(0, 9);
    // up a semitone and the same stretch of record goes by about 5.6% faster
    expect(timeCostPercent(100)).toBeCloseTo(-5.6, 1);
    expect(timeCostPercent(-100)).toBeCloseTo(5.9, 1);
  });
});
