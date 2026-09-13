// What the graph is told to do. The node layer makes no decisions, so this is
// where every decision the node layer would otherwise have made is asserted:
// what bypass means, what a switched-off band settles to, and where a pass
// filter comes in from.

import { describe as group, expect, it } from "vitest";
import { defaultProcessing, setBand, setBypass, setLimiter, setTrim, setTune, defaultMaster, setMasterBypass } from "./chain";
import { initialBands, masterPlan, neutralPlan, NEUTRAL_HIGHPASS_HZ, samePlan, trackPlan } from "./plan";
import { OPEN_COMPRESSOR } from "./master";

const RATE = 48000;

function planOf(edit: (p: ReturnType<typeof defaultProcessing>) => ReturnType<typeof defaultProcessing>) {
  return trackPlan(edit(setBypass(defaultProcessing(), false)), RATE);
}

group("bypass", () => {
  it("is a real crossfade between two paths, not a chain set flat", () => {
    const engaged = planOf((p) => setBand(p, "lo", { gainDb: -6, enabled: true }));
    expect(engaged.dryGain).toBe(0);
    expect(engaged.wetGain).toBe(1);
    const bypassed = trackPlan(setBand(defaultProcessing(), "lo", { gainDb: -6, enabled: true }), RATE);
    expect(bypassed.dryGain).toBe(1);
    expect(bypassed.wetGain).toBe(0);
  });

  it("takes the trim out with the rest of the chain", () => {
    const bypassed = trackPlan(setTrim(defaultProcessing(), 6), RATE);
    expect(bypassed.trimGain).toBe(1);
    expect(planOf((p) => setTrim(p, 6)).trimGain).toBeCloseTo(10 ** (6 / 20), 9);
  });

  it("leaves the tune alone, because A/Bing a curve must not also retune the lane", () => {
    const bypassed = trackPlan(setTune(defaultProcessing(), 1200), RATE);
    expect(bypassed.rate).toBeCloseTo(2, 9);
    expect(planOf((p) => setTune(p, -1200)).rate).toBeCloseTo(0.5, 9);
  });
});

group("a band that is switched off", () => {
  it("is asked for exactly 0 dB, so a peaking slot is a mathematical pass-through", () => {
    const plan = trackPlan(defaultProcessing(), RATE);
    for (const band of plan.bands) {
      expect(band.enabled).toBe(false);
      expect(band.gainDb).toBe(0);
    }
  });

  it("parks a high-pass below hearing and a low-pass at Nyquist, so it can ramp in", () => {
    const plan = trackPlan(defaultProcessing(), RATE);
    const hp = plan.bands.find((b) => b.id === "hp");
    const lp = plan.bands.find((b) => b.id === "lp");
    expect(hp?.frequency).toBe(NEUTRAL_HIGHPASS_HZ);
    expect(hp?.neutralFrequency).toBe(NEUTRAL_HIGHPASS_HZ);
    expect(lp?.neutralFrequency).toBe(RATE / 2);
  });

  it("names the exactly-unity shape a neutralised slot settles to", () => {
    for (const band of trackPlan(defaultProcessing(), RATE).bands) expect(band.neutralKind).toBe("peaking");
  });

  it("counts a band at 0 dB as off even when the producer switched it on", () => {
    const plan = planOf((p) => setBand(p, "mid", { gainDb: 0, enabled: true }));
    expect(plan.bands.find((b) => b.id === "mid")?.enabled).toBe(false);
  });
});

group("a band that is doing something", () => {
  it("carries its own numbers straight through", () => {
    const plan = planOf((p) => setBand(p, "hi", { frequency: 3200, gainDb: -3.5, q: 1.4, enabled: true }));
    const band = plan.bands.find((b) => b.id === "hi");
    expect(band).toMatchObject({ enabled: true, kind: "peaking", frequency: 3200, gainDb: -3.5, q: 1.4 });
  });

  it("keeps a pass filter's way in even while it is working", () => {
    const plan = planOf((p) => setBand(p, "hp", { frequency: 80, enabled: true }));
    const hp = plan.bands.find((b) => b.id === "hp");
    expect(hp?.frequency).toBe(80);
    expect(hp?.neutralFrequency).toBe(NEUTRAL_HIGHPASS_HZ);
  });
});

group("the master bus", () => {
  it("is out of circuit until the limiter is on", () => {
    const off = masterPlan(defaultMaster());
    expect(off.dryGain).toBe(1);
    expect(off.wetGain).toBe(0);
    expect(off.compressor).toEqual(OPEN_COMPRESSOR);
  });

  it("crossfades the limiter in, with the ceiling as its threshold", () => {
    const on = masterPlan(setLimiter(defaultMaster(), { enabled: true, ceilingDb: -2 }));
    expect(on.dryGain).toBe(0);
    expect(on.wetGain).toBe(1);
    expect(on.compressor.thresholdDb).toBe(-2);
    expect(on.compressor.ratio).toBe(8);
  });

  it("comes straight back out when the bus is bypassed", () => {
    const bypassed = masterPlan(setMasterBypass(setLimiter(defaultMaster(), { enabled: true }), true));
    expect(bypassed.wetGain).toBe(0);
    expect(bypassed.compressor).toEqual(OPEN_COMPRESSOR);
  });
});

group("leaving the graph alone", () => {
  it("says two identical plans are the same, so nothing is re-ramped for nothing", () => {
    const a = planOf((p) => setBand(p, "lo", { gainDb: -4, enabled: true }));
    const b = planOf((p) => setBand(p, "lo", { gainDb: -4, enabled: true }));
    expect(samePlan(a, b)).toBe(true);
    expect(samePlan(a, planOf((p) => setBand(p, "lo", { gainDb: -4.5, enabled: true })))).toBe(false);
  });

  it("has a plan for a lane with no chain at all", () => {
    const plan = neutralPlan();
    expect(plan.dryGain).toBe(1);
    expect(plan.wetGain).toBe(0);
    expect(plan.rate).toBe(1);
    expect(plan.bands.every((b) => !b.enabled && b.gainDb === 0)).toBe(true);
  });

  it("builds a strip's slots in the order the chain has them", () => {
    expect(initialBands(RATE).map((b) => b.id)).toEqual(["hp", "ls", "lo", "mid", "hi", "hs", "lp"]);
  });
});
