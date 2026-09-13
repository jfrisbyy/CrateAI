// The master bus. Every assertion here is really one assertion: this is a
// safety net, not a mastering chain. No makeup gain, a ratio that leaves the
// music intact, and an attack that lets a transient through.

import { describe as group, expect, it } from "vitest";
import { describeLimiter, limiterSettings, OPEN_COMPRESSOR } from "./master";

group("the limiter", () => {
  it("uses the ceiling as its threshold, straight through", () => {
    expect(limiterSettings({ enabled: true, ceilingDb: -1, releaseMs: 120 }).thresholdDb).toBe(-1);
    expect(limiterSettings({ enabled: true, ceilingDb: -6, releaseMs: 120 }).thresholdDb).toBe(-6);
  });

  it("is gentle on purpose: a soft knee and a ratio that is not a brick wall", () => {
    const settings = limiterSettings({ enabled: true, ceilingDb: -1, releaseMs: 120 });
    expect(settings.ratio).toBe(8);
    expect(settings.ratio).toBeLessThan(20);
    expect(settings.kneeDb).toBeGreaterThan(0);
  });

  it("lets the transient through and catches what is behind it", () => {
    const settings = limiterSettings({ enabled: true, ceilingDb: -1, releaseMs: 120 });
    expect(settings.attackS).toBeCloseTo(0.003, 6);
    expect(settings.releaseS).toBeCloseTo(0.12, 6);
  });

  it("clamps a ceiling above zero and a release out of range", () => {
    expect(limiterSettings({ enabled: true, ceilingDb: 6, releaseMs: 5 }).thresholdDb).toBe(0);
    expect(limiterSettings({ enabled: true, ceilingDb: -60, releaseMs: 9000 }).thresholdDb).toBe(-24);
    expect(limiterSettings({ enabled: true, ceilingDb: -1, releaseMs: 5 }).releaseS).toBeCloseTo(0.02, 6);
  });

  it("has no makeup gain anywhere in it, which is the whole line", () => {
    const settings = limiterSettings({ enabled: true, ceilingDb: -1, releaseMs: 120 });
    expect(Object.keys(settings).sort()).toEqual(["attackS", "kneeDb", "ratio", "releaseS", "thresholdDb"]);
  });

  it("is transparent when it is off", () => {
    expect(OPEN_COMPRESSOR.ratio).toBe(1);
    expect(OPEN_COMPRESSOR.thresholdDb).toBe(0);
  });

  it("says what it is doing without claiming a loudness it did not measure", () => {
    expect(describeLimiter({ enabled: false, ceilingDb: -1, releaseMs: 120 })).toBe("off");
    const line = describeLimiter({ enabled: true, ceilingDb: -2, releaseMs: 200 });
    expect(line).toBe("holding peaks at -2 dB, 8:1, 200 ms release");
    expect(line).not.toMatch(/lufs|loud/i);
  });
});
