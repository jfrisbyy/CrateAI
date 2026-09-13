// Applying a proposal. Whoever decided — the narrow command line or a model —
// the answer lands here, and here it is clamped and accounted for. The
// assertions that matter: nothing is applied silently larger than the control
// allows, nothing is boosted above what the record actually contains, and a
// refusal is always visible.

import { describe as group, expect, it } from "vitest";
import { bandOf, defaultProcessing, setBand, setBypass } from "./chain";
import { applyProposal, describeMove, summarise, type ProcessingProposal } from "./moves";
import { MAX_BOOST_DB } from "./types";

function proposal(moves: ProcessingProposal["moves"], confidence: number | null = 0.6): ProcessingProposal {
  return { moves, summary: "a test", confidence, notes: [] };
}

group("applying moves", () => {
  it("moves the same controls a drag moves", () => {
    const out = applyProposal(defaultProcessing(), proposal([{ op: "band", band: "lo", frequency: 250, gainDb: -4, q: 1.2, why: "mud" }]));
    const band = bandOf(out.processing, "lo");
    expect(band).toMatchObject({ frequency: 250, gainDb: -4, q: 1.2, enabled: true });
    expect(out.applied).toHaveLength(1);
    expect(out.empty).toBe(false);
  });

  it("switches a band on unless it is told not to", () => {
    const on = applyProposal(defaultProcessing(), proposal([{ op: "band", band: "hs", gainDb: 3, why: "air" }]));
    expect(bandOf(on.processing, "hs").enabled).toBe(true);
    const off = applyProposal(on.processing, proposal([{ op: "band", band: "hs", enabled: false, gainDb: 3, why: "off again" }]));
    expect(bandOf(off.processing, "hs").enabled).toBe(false);
  });

  it("applies a trim and a tune", () => {
    const out = applyProposal(defaultProcessing(), proposal([{ op: "trim", db: -3, why: "hot" }, { op: "tune", cents: -18, why: "flat against the loop" }]));
    expect(out.processing.trimDb).toBe(-3);
    expect(out.processing.tuneCents).toBe(-18);
  });

  it("reports nothing changed rather than pretending it did", () => {
    const flat = defaultProcessing();
    const out = applyProposal(flat, proposal([{ op: "band", band: "mid", gainDb: 0, enabled: false, why: "nothing" }]));
    expect(out.empty).toBe(true);
    expect(out.processing).toBe(flat);
    expect(out.applied).toHaveLength(0);
  });
});

group("clamping, out loud", () => {
  it("cuts an over-sized boost down and says so", () => {
    const out = applyProposal(defaultProcessing(), proposal([{ op: "band", band: "hs", gainDb: 30, why: "brighter" }]));
    expect(bandOf(out.processing, "hs").gainDb).toBe(MAX_BOOST_DB);
    expect(out.notes.join(" ")).toContain("asked for +30 dB");
    expect(out.applied[0]?.note).toContain("+12 dB");
  });

  it("refuses to take a high-pass past where it stops being a correction", () => {
    const out = applyProposal(defaultProcessing(), proposal([{ op: "band", band: "hp", frequency: 2000, why: "thin it out" }]));
    expect(bandOf(out.processing, "hp").frequency).toBe(400);
    expect(out.notes.join(" ")).toContain("effect, not a correction");
  });

  it("skips a move that names a band that does not exist, and says which", () => {
    const out = applyProposal(defaultProcessing(), proposal([{ op: "band", band: "air" as never, gainDb: 3, why: "nope" }]));
    expect(out.empty).toBe(true);
    expect(out.notes.join(" ")).toContain("there is no band called air");
  });

  it("stops a tune at an octave and says it did", () => {
    const out = applyProposal(defaultProcessing(), proposal([{ op: "tune", cents: 4000, why: "up" }]));
    expect(out.processing.tuneCents).toBe(1200);
    expect(out.notes.join(" ")).toContain("tuning stops at an octave");
  });
});

group("the bandwidth rule", () => {
  it("will not lift above what the record actually contains", () => {
    const out = applyProposal(defaultProcessing(), proposal([{ op: "band", band: "hs", frequency: 16000, gainDb: 4, why: "air" }]), { sourceCeilingHz: 13500 });
    expect(bandOf(out.processing, "hs").frequency).toBe(13500);
    expect(out.notes.join(" ")).toContain("the record stops at 13.5 kHz");
  });

  it("leaves a cut up there alone, because taking something out is always allowed", () => {
    const out = applyProposal(defaultProcessing(), proposal([{ op: "band", band: "hs", frequency: 16000, gainDb: -4, why: "hiss" }]), { sourceCeilingHz: 13500 });
    expect(bandOf(out.processing, "hs").frequency).toBe(16000);
    expect(out.notes.join(" ")).not.toContain("stops at");
  });

  it("assumes nothing when nothing measured the bandwidth", () => {
    const out = applyProposal(defaultProcessing(), proposal([{ op: "band", band: "hs", frequency: 16000, gainDb: 4, why: "air" }]), { sourceCeilingHz: null });
    expect(bandOf(out.processing, "hs").frequency).toBe(16000);
  });
});

group("bypass and reset as moves", () => {
  it("can engage a chain it has just built", () => {
    const out = applyProposal(defaultProcessing(), proposal([{ op: "band", band: "lo", gainDb: -4, why: "mud" }, { op: "bypass", on: false, why: "so you can hear it" }]));
    expect(out.processing.bypassed).toBe(false);
  });

  it("can put the whole thing back to nothing", () => {
    const dirty = setBypass(setBand(defaultProcessing(), "lo", { gainDb: -6, enabled: true }), false);
    const out = applyProposal(dirty, proposal([{ op: "reset", why: "start again" }]));
    expect(out.processing).toEqual(defaultProcessing());
  });
});

group("what it says", () => {
  it("names each move in the units on the control", () => {
    const out = applyProposal(defaultProcessing(), proposal([{ op: "band", band: "lo", frequency: 250, gainDb: -4, q: 1.2, why: "mud" }]));
    expect(out.applied[0]?.line).toBe("250 Hz down +4 dB, Q 1.2");
    expect(describeMove({ op: "band", band: "hp", frequency: 80, why: "rumble" }, out.processing)).toContain("high-pass");
  });

  it("hedges the summary by its own confidence, in the product's words", () => {
    const moves: ProcessingProposal["moves"] = [{ op: "band", band: "lo", frequency: 250, gainDb: -4, q: 1.2, why: "mud" }];
    const out = applyProposal(defaultProcessing(), proposal(moves, 0.65));
    expect(summarise(proposal(moves, 0.65), out.processing).startsWith("likely:")).toBe(true);
    expect(summarise(proposal(moves, 0.9), out.processing).startsWith("a test —")).toBe(true);
    expect(summarise(proposal(moves, 0.3), out.processing)).toContain("I can't tell");
  });
});
