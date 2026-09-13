// The narrow half of the seam: a producer's words, straight to a curve, with
// no round trip. Two properties matter equally, and they are the same two the
// command line already lives by — the words a producer actually uses land on
// the right frequency, and words that name no problem are handed on rather
// than guessed at.

import { describe as group, expect, it } from "vitest";
import { bandForFrequency, COMPLAINT_WORDS, genericClean, intensityOf, proposeForComplaint, proposeForPhrase } from "./complaints";
import { applyProposal } from "./moves";
import { bandOf, defaultProcessing } from "./chain";
import type { EqPhrase } from "./types";

function curveFor(complaint: string, ceilingHz: number | null = null) {
  const proposal = proposeForComplaint(complaint, { sourceCeilingHz: ceilingHz });
  if (!proposal) return null;
  return { proposal, out: applyProposal(defaultProcessing(), proposal, { sourceCeilingHz: ceilingHz }) };
}

group("the words a producer uses", () => {
  it("puts muddy where mud is, and clears the sub under it", () => {
    const result = curveFor("the horns are muddy");
    const lo = bandOf(result!.out.processing, "lo");
    expect(lo.gainDb).toBeLessThan(0);
    expect(lo.frequency).toBeGreaterThanOrEqual(200);
    expect(lo.frequency).toBeLessThanOrEqual(320);
    expect(bandOf(result!.out.processing, "hp").enabled).toBe(true);
  });

  it("answers the trumpet that came back dull by opening the top, not by turning it up", () => {
    const result = curveFor("this trumpet is dull and muffled");
    const hs = bandOf(result!.out.processing, "hs");
    expect(hs.gainDb).toBeGreaterThan(0);
    expect(hs.frequency).toBeGreaterThanOrEqual(6000);
    expect(result!.out.processing.trimDb).toBe(0);
  });

  it("takes the bottom off something boomy and the top off something harsh", () => {
    expect(bandOf(curveFor("way too boomy")!.out.processing, "ls").gainDb).toBeLessThan(0);
    const harsh = bandOf(curveFor("it's harsh")!.out.processing, "hi");
    expect(harsh.gainDb).toBeLessThan(0);
    expect(harsh.frequency).toBeGreaterThan(2000);
    expect(harsh.frequency).toBeLessThan(5000);
  });

  it("uses a narrow dip for sibilance and a wide one for mud, because they are different shapes", () => {
    const sibilant = bandOf(curveFor("it's really sibilant")!.out.processing, "hi");
    const muddy = bandOf(curveFor("muddy")!.out.processing, "lo");
    expect(sibilant.q).toBeGreaterThan(muddy.q * 2);
  });

  it("high-passes rather than dipping when the complaint is rumble", () => {
    const out = curveFor("there's rumble under it")!.out;
    expect(bandOf(out.processing, "hp").enabled).toBe(true);
    expect(out.processing.bands.filter((b) => b.enabled && b.gainDb !== 0)).toHaveLength(0);
  });

  it("moves the trim, not a band, when the complaint is about level", () => {
    expect(curveFor("it's too loud")!.out.processing.trimDb).toBeLessThan(0);
    expect(curveFor("it's too quiet")!.out.processing.trimDb).toBeGreaterThan(0);
  });

  it("handles the quality words as well as the problem words", () => {
    expect(bandOf(curveFor("make it brighter")!.out.processing, "hs").gainDb).toBeGreaterThan(0);
    expect(bandOf(curveFor("make it darker")!.out.processing, "hs").gainDb).toBeLessThan(0);
    expect(bandOf(curveFor("make it fuller")!.out.processing, "ls").gainDb).toBeGreaterThan(0);
  });
});

group("how hard", () => {
  it("takes 'a bit' and 'way too' at face value", () => {
    expect(intensityOf("a bit muddy")).toBe(0.6);
    expect(intensityOf("way too muddy")).toBe(1.5);
    expect(intensityOf("muddy")).toBe(1);
  });

  it("makes a smaller move for a smaller complaint", () => {
    const slight = bandOf(curveFor("a bit muddy")!.out.processing, "lo").gainDb;
    const plain = bandOf(curveFor("muddy")!.out.processing, "lo").gainDb;
    const lots = bandOf(curveFor("way too muddy")!.out.processing, "lo").gainDb;
    expect(slight).toBeGreaterThan(plain);
    expect(plain).toBeGreaterThan(lots);
  });

  it("turns 'more' round, and drops the moves that cannot be turned round", () => {
    const more = curveFor("give me more mud");
    expect(bandOf(more!.out.processing, "lo").gainDb).toBeGreaterThan(0);
    expect(bandOf(more!.out.processing, "hp").enabled).toBe(false);
  });
});

group("what it refuses to guess", () => {
  it("hands on a sentence that names no problem it knows", () => {
    for (const text of ["it sounds like a trumpet", "what's wrong with this", "put it in the chorus", ""]) {
      expect(proposeForComplaint(text), text).toBeNull();
    }
  });

  it("offers the words that do work, so a refusal teaches the vocabulary", () => {
    expect(COMPLAINT_WORDS).toContain("muddy");
    expect(COMPLAINT_WORDS).toContain("dull");
  });
});

group("clean it up, with nothing named", () => {
  it("does something, because that is the sentence the owner actually types", () => {
    const result = curveFor("clean it up");
    expect(result).not.toBeNull();
    expect(result!.out.applied.length).toBeGreaterThan(1);
  });

  it("hedges itself into the band that reads 'roughly', and says it is not a diagnosis", () => {
    const proposal = genericClean();
    expect(proposal.confidence).toBeLessThan(0.6);
    expect(proposal.confidence).toBeGreaterThanOrEqual(0.4);
    expect(proposal.notes.join(" ")).toContain("not a diagnosis");
    expect(proposal.notes.join(" ")).toContain("muddy");
  });

  it("does not put air back on a record that has none, and says why", () => {
    const lossy = genericClean({ sourceCeilingHz: 8000 });
    expect(lossy.moves.some((m) => m.op === "band" && m.band === "hs")).toBe(false);
    expect(lossy.notes.join(" ")).toContain("no air up there");
    const full = genericClean({ sourceCeilingHz: 19000 });
    expect(full.moves.some((m) => m.op === "band" && m.band === "hs")).toBe(true);
  });

  it("is caught by the way a producer actually says it", () => {
    for (const text of ["clean this up", "sort it out", "it sounds awful", "clean up the trumpet"]) {
      expect(proposeForComplaint(text), text).not.toBeNull();
    }
  });
});

group("an EQ move said out loud", () => {
  function phrase(overrides: Partial<EqPhrase>): EqPhrase {
    return { move: "cut", atHz: null, region: null, db: null, ...overrides };
  }

  it("puts a named frequency on the slot a producer would reach for", () => {
    expect(bandForFrequency(80)).toBe("ls");
    expect(bandForFrequency(300)).toBe("lo");
    expect(bandForFrequency(1000)).toBe("mid");
    expect(bandForFrequency(3000)).toBe("hi");
    expect(bandForFrequency(9000)).toBe("hs");
  });

  it("cuts and boosts at the frequency named, by a default step when none is given", () => {
    const cut = applyProposal(defaultProcessing(), proposeForPhrase(phrase({ move: "cut", atHz: 300 })));
    expect(bandOf(cut.processing, "lo")).toMatchObject({ frequency: 300, gainDb: -4, enabled: true });
    const boost = applyProposal(defaultProcessing(), proposeForPhrase(phrase({ move: "boost", atHz: 8000, db: 2 })));
    expect(bandOf(boost.processing, "hs")).toMatchObject({ frequency: 8000, gainDb: 2, enabled: true });
  });

  it("understands a region of the spectrum instead of a number", () => {
    const out = applyProposal(defaultProcessing(), proposeForPhrase(phrase({ move: "boost", region: "highs" })));
    expect(bandOf(out.processing, "hs").gainDb).toBeGreaterThan(0);
  });

  it("puts a high-pass and a low-pass on their own slots", () => {
    const hp = applyProposal(defaultProcessing(), proposeForPhrase(phrase({ move: "highpass", atHz: 80 })));
    expect(bandOf(hp.processing, "hp")).toMatchObject({ frequency: 80, enabled: true });
    const lp = applyProposal(defaultProcessing(), proposeForPhrase(phrase({ move: "lowpass", atHz: 9000 })));
    expect(bandOf(lp.processing, "lp")).toMatchObject({ frequency: 9000, enabled: true });
  });
});
