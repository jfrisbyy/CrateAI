// The chain as data, and the limits that are where the scope line actually
// lives. A control that will not go past +12 dB is the difference between an
// EQ that rescues a horn and an EQ that is an instrument.

import { describe as group, expect, it } from "vitest";
import {
  activeBands,
  bandOf,
  clampFrequency,
  defaultBands,
  defaultMaster,
  defaultProcessing,
  defaultState,
  describeBand,
  describeProcessing,
  editTrack,
  hasProcessing,
  isEngaged,
  isNeutral,
  processingFor,
  pruneProcessing,
  removeProcessing,
  resetProcessing,
  setBand,
  setBypass,
  setLimiter,
  setMasterBypass,
  setTrackProcessing,
  setTrim,
  setTune,
  toggleBand,
} from "./chain";
import { BAND_IDS, HIGHPASS_CEILING_HZ, LOWPASS_FLOOR_HZ, MAX_BOOST_DB, MAX_CUT_DB, MAX_TRIM_DB, MAX_TUNE_CENTS } from "./types";

group("the chain a track starts with", () => {
  it("has all seven slots, every one of them switched off", () => {
    const processing = defaultProcessing();
    expect(processing.bands.map((b) => b.id)).toEqual([...BAND_IDS]);
    expect(processing.bands.every((b) => !b.enabled)).toBe(true);
    expect(processing.bands.every((b) => b.gainDb === 0)).toBe(true);
  });

  it("starts bypassed, so an untouched lane is the signal itself", () => {
    expect(defaultProcessing().bypassed).toBe(true);
    expect(isNeutral(defaultProcessing())).toBe(true);
    expect(isEngaged(defaultProcessing())).toBe(false);
  });

  it("gives each slot the shape its id says it is", () => {
    const kinds = Object.fromEntries(defaultBands().map((b) => [b.id, b.kind]));
    expect(kinds).toEqual({ hp: "highpass", ls: "lowshelf", lo: "peaking", mid: "peaking", hi: "peaking", hs: "highshelf", lp: "lowpass" });
  });
});

group("the limits", () => {
  it("will not boost past the corrective cap, and lets a cut go deeper", () => {
    const up = setBand(defaultProcessing(), "mid", { gainDb: 40, enabled: true });
    expect(bandOf(up, "mid").gainDb).toBe(MAX_BOOST_DB);
    const down = setBand(defaultProcessing(), "mid", { gainDb: -40, enabled: true });
    expect(bandOf(down, "mid").gainDb).toBe(-MAX_CUT_DB);
    expect(MAX_CUT_DB).toBeGreaterThan(MAX_BOOST_DB);
  });

  it("will not take a high-pass past 400 Hz or a low-pass under 800 Hz", () => {
    expect(clampFrequency("hp", 3000)).toBe(HIGHPASS_CEILING_HZ);
    expect(clampFrequency("lp", 200)).toBe(LOWPASS_FLOOR_HZ);
    expect(clampFrequency("mid", 3000)).toBe(3000);
  });

  it("keeps every band inside the audible range", () => {
    expect(clampFrequency("mid", 2)).toBe(20);
    expect(clampFrequency("mid", 90000)).toBe(20000);
  });

  it("gives the pass filters no gain at all, because they have none", () => {
    const processing = setBand(defaultProcessing(), "hp", { gainDb: 6, enabled: true });
    expect(bandOf(processing, "hp").gainDb).toBe(0);
  });

  it("caps the trim and the tune", () => {
    expect(setTrim(defaultProcessing(), 40).trimDb).toBe(MAX_TRIM_DB);
    expect(setTune(defaultProcessing(), -9000).tuneCents).toBe(-MAX_TUNE_CENTS);
  });
});

group("editing", () => {
  it("returns the chain it was given when nothing moved", () => {
    const processing = setBand(defaultProcessing(), "lo", { gainDb: -4, enabled: true });
    expect(setBand(processing, "lo", { gainDb: -4 })).toBe(processing);
    expect(setTrim(processing, 0)).toBe(processing);
    expect(setBypass(processing, processing.bypassed)).toBe(processing);
  });

  it("touches one slot and leaves the other six as they were", () => {
    const before = setBand(defaultProcessing(), "hs", { gainDb: 3, enabled: true });
    const after = setBand(before, "lo", { gainDb: -4, enabled: true });
    expect(bandOf(after, "hs")).toBe(bandOf(before, "hs"));
    expect(bandOf(after, "lo").gainDb).toBe(-4);
  });

  it("toggles a band without losing where it was set", () => {
    const on = setBand(defaultProcessing(), "mid", { frequency: 720, gainDb: -5, enabled: true });
    const off = toggleBand(on, "mid");
    expect(off.bands.find((b) => b.id === "mid")?.enabled).toBe(false);
    expect(off.bands.find((b) => b.id === "mid")?.frequency).toBe(720);
    expect(toggleBand(off, "mid")).toEqual(on);
  });

  it("counts a band as doing nothing when it is at 0 dB, even when it is switched on", () => {
    const flat = setBand(defaultProcessing(), "mid", { gainDb: 0, enabled: true });
    expect(activeBands(flat)).toHaveLength(0);
    expect(isNeutral(flat)).toBe(true);
    const passing = setBand(defaultProcessing(), "hp", { frequency: 80, enabled: true });
    expect(activeBands(passing)).toHaveLength(1);
  });

  it("counts a trim or a tune as something even with every band off", () => {
    expect(isNeutral(setTrim(defaultProcessing(), -3))).toBe(false);
    expect(isNeutral(setTune(defaultProcessing(), 20))).toBe(false);
  });

  it("resets back to nothing", () => {
    expect(resetProcessing()).toEqual(defaultProcessing());
  });
});

group("the state across lanes", () => {
  it("gives a lane that has never been touched the default chain without storing one", () => {
    const state = defaultState();
    expect(processingFor(state, "t1")).toEqual(defaultProcessing());
    expect(hasProcessing(state, "t1")).toBe(false);
  });

  it("keeps one lane's chain off another's", () => {
    let state = editTrack(defaultState(), "t1", (p) => setBand(setBypass(p, false), "lo", { gainDb: -4, enabled: true }));
    state = editTrack(state, "t2", (p) => setTrim(p, 3));
    expect(bandOf(processingFor(state, "t1"), "lo").gainDb).toBe(-4);
    expect(bandOf(processingFor(state, "t2"), "lo").gainDb).toBe(0);
    expect(processingFor(state, "t2").trimDb).toBe(3);
  });

  it("takes a chain off entirely, because processing was never destructive", () => {
    const state = setTrackProcessing(defaultState(), "t1", setTrim(defaultProcessing(), 4));
    const without = removeProcessing(state, "t1");
    expect(hasProcessing(without, "t1")).toBe(false);
    expect(processingFor(without, "t1")).toEqual(defaultProcessing());
    expect(removeProcessing(without, "t1")).toBe(without);
  });

  it("drops chains for lanes that have left the session", () => {
    let state = setTrackProcessing(defaultState(), "t1", setTrim(defaultProcessing(), 4));
    state = setTrackProcessing(state, "t2", setTrim(defaultProcessing(), 2));
    const pruned = pruneProcessing(state, ["t2"]);
    expect(Object.keys(pruned.tracks)).toEqual(["t2"]);
    expect(pruneProcessing(pruned, ["t2"])).toBe(pruned);
  });
});

group("the master bus", () => {
  it("starts with nothing on it", () => {
    expect(defaultMaster()).toEqual({ bypassed: true, limiter: { enabled: false, ceilingDb: -1, releaseMs: 120 } });
  });

  it("takes the bus out of bypass when the limiter goes on, because there is nothing else on it", () => {
    const on = setLimiter(defaultMaster(), { enabled: true });
    expect(on.limiter.enabled).toBe(true);
    expect(on.bypassed).toBe(false);
  });

  it("clamps the ceiling and the release", () => {
    const settings = setLimiter(defaultMaster(), { enabled: true, ceilingDb: 12, releaseMs: 9000 });
    expect(settings.limiter.ceilingDb).toBe(0);
    expect(settings.limiter.releaseMs).toBe(1000);
  });

  it("can be bypassed without forgetting its settings", () => {
    const on = setLimiter(defaultMaster(), { enabled: true, ceilingDb: -3 });
    const off = setMasterBypass(on, true);
    expect(off.limiter.ceilingDb).toBe(-3);
    expect(off.bypassed).toBe(true);
  });
});

group("saying what is on a lane", () => {
  it("says nothing is on it when nothing is", () => {
    expect(describeProcessing(defaultProcessing())).toBe("nothing on it");
  });

  it("names every move, in the units on the controls", () => {
    let processing = setBypass(defaultProcessing(), false);
    processing = setTrim(processing, -3);
    processing = setBand(processing, "hp", { frequency: 80, enabled: true });
    processing = setBand(processing, "lo", { frequency: 250, gainDb: -4, q: 1.2, enabled: true });
    processing = setBand(processing, "hs", { frequency: 8000, gainDb: 3, enabled: true });
    const line = describeProcessing(processing);
    expect(line).toContain("trim -3 dB");
    expect(line).toContain("high-pass at 80 Hz");
    expect(line).toContain("250 Hz -4 dB, Q 1.2");
    expect(line).toContain("8 kHz +3 dB shelf");
  });

  it("says so when the chain is bypassed rather than reading as if it is being heard", () => {
    const processing = setBand(defaultProcessing(), "lo", { gainDb: -4, enabled: true });
    expect(describeProcessing(processing)).toContain("(bypassed)");
    expect(describeProcessing(setBypass(processing, false))).not.toContain("bypassed");
  });

  it("names one band on its own", () => {
    expect(describeBand({ id: "hp", kind: "highpass", frequency: 80, gainDb: 0, q: 0.707, enabled: true })).toBe("high-pass at 80 Hz");
  });
});
