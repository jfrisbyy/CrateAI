// The compatibility theory, and its agreement with the Python it mirrors.
//
// parity.json is generated from analysis/lockedgroove/analysis/compat.py and
// asserted from both sides (analysis/tests/test_compat.py does the same), so the
// panel and the pipeline can never drift into saying different things about the
// same pair of files.

import { describe as group, expect, it } from "vitest";
import parityData from "./parity.json";
import {
  CHARACTER_SHIFT,
  compareKey,
  compareTempo,
  compatibility,
  describe,
  directRelationship,
  foldTempo,
  keyRelationship,
  MAX_SHIFT,
  pitchClass,
  stretchDistance,
  TRANSPARENT_MAX,
  USABLE_MAX,
  type Compatibility,
  type Mode,
  type TrackVitals,
} from "./theory";

type RawVitals = {
  bpm: number | null;
  bpm_confidence: number | null;
  tonic: string | null;
  mode: string | null;
  key_confidence: number | null;
};

interface ParityCase {
  name: string;
  source: RawVitals;
  candidate: RawVitals;
  options: { stretch_tolerance?: number; max_semitones?: number; max_octaves?: number };
  expected: Compatibility;
}

const parity = parityData as unknown as { version: number; cases: ParityCase[] };

function vitals(raw: RawVitals): TrackVitals {
  return {
    bpm: raw.bpm,
    bpm_confidence: raw.bpm_confidence,
    tonic: raw.tonic,
    mode: (raw.mode as Mode | null) ?? null,
    key_confidence: raw.key_confidence,
  };
}

/** Numbers within a float hair, everything else exactly. */
function expectSame(actual: unknown, expected: unknown, path: string): void {
  if (typeof expected === "number") {
    expect(typeof actual, path).toBe("number");
    expect(actual as number, path).toBeCloseTo(expected, 9);
    return;
  }
  if (expected !== null && typeof expected === "object") {
    expect(actual, path).not.toBeNull();
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      expectSame((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toEqual(expected);
}

function vit(partial: Partial<TrackVitals>): TrackVitals {
  return { bpm: null, bpm_confidence: null, tonic: null, mode: null, key_confidence: null, ...partial };
}

group("parity with the Python", () => {
  it("has the generated cases", () => {
    expect(parity.version).toBe(1);
    expect(parity.cases.length).toBeGreaterThanOrEqual(20);
  });

  for (const testCase of parity.cases) {
    it(`matches compat.py: ${testCase.name}`, () => {
      const result = compatibility(vitals(testCase.source), vitals(testCase.candidate), {
        stretchTolerance: testCase.options.stretch_tolerance,
        maxSemitones: testCase.options.max_semitones,
        maxOctaves: testCase.options.max_octaves,
      });
      expectSame(result, testCase.expected, testCase.name);
    });
  }
});

group("key relationships", () => {
  it("names the relative from the candidate's side and needs no shift", () => {
    expect(keyRelationship("C", "major", "A", "minor")).toEqual({ relationship: "relative", shift: 0 });
    expect(keyRelationship("A", "minor", "C", "major")).toEqual({ relationship: "relative", shift: 0 });
    const match = compatibility(
      vit({ bpm: 90, bpm_confidence: 0.9, tonic: "C", mode: "major", key_confidence: 0.8 }),
      vit({ bpm: 90, bpm_confidence: 0.9, tonic: "A", mode: "minor", key_confidence: 0.8 }),
    );
    expect(describe(match)).toBe("relative minor, same tempo");
  });

  it("calls the fifths the dominant and the subdominant, and ranks them together", () => {
    const source = vit({ bpm: 88, bpm_confidence: 0.9, tonic: "C", mode: "minor", key_confidence: 0.9 });
    const up = compareKey(source, vit({ tonic: "G", mode: "minor", key_confidence: 0.9 }));
    const down = compareKey(source, vit({ tonic: "F", mode: "minor", key_confidence: 0.9 }));
    expect([up.relationship, up.semitone_shift]).toEqual(["dominant", 0]);
    expect([down.relationship, down.semitone_shift]).toEqual(["subdominant", 0]);
    expect(up.score).toBe(down.score);
  });

  it("does not call a fifth in the other mode a fifth", () => {
    expect(keyRelationship("C", "minor", "G", "major").shift).not.toBe(0);
  });

  it("prefers leaving a pair alone over pitching it into the same key", () => {
    expect(keyRelationship("C", "minor", "C", "major")).toEqual({ relationship: "parallel", shift: 0 });
  });

  it("takes the smallest shift that lands on a relationship", () => {
    expect(keyRelationship("C", "minor", "D", "minor")).toEqual({ relationship: "same", shift: -2 });
  });

  it("flags a shift that changes the character of the material", () => {
    const wide = compareKey(
      vit({ tonic: "C", mode: "major", key_confidence: 0.9 }),
      vit({ tonic: "F", mode: "minor", key_confidence: 0.9 }),
    );
    expect(wide.semitone_shift).toBe(4);
    expect(Math.abs(wide.semitone_shift)).toBeGreaterThan(CHARACTER_SHIFT);
    expect(wide.shifts_character).toBe(true);
  });

  it("refuses a shift past the caller's limit", () => {
    const tight = compareKey(
      vit({ tonic: "C", mode: "major", key_confidence: 0.9 }),
      vit({ tonic: "F", mode: "minor", key_confidence: 0.9 }),
      { maxSemitones: CHARACTER_SHIFT },
    );
    expect(tight.compatible).toBe(false);
    expect(tight.note).toContain("past the 2 allowed");
  });

  it("never needs more than four semitones, whatever the pair", () => {
    let worst = 0;
    for (const sourceTonic of ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]) {
      for (const sourceMode of ["major", "minor"] as Mode[]) {
        for (const tonic of ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]) {
          for (const mode of ["major", "minor"] as Mode[]) {
            const { relationship, shift } = keyRelationship(sourceTonic, sourceMode, tonic, mode);
            expect(relationship).not.toBeNull();
            expect(Math.abs(shift)).toBeLessThanOrEqual(MAX_SHIFT);
            worst = Math.max(worst, Math.abs(shift));
          }
        }
      }
    }
    expect(worst).toBe(4);
  });

  it("reads flats and sharps", () => {
    expect(pitchClass("Bb")).toBe(pitchClass("A#"));
    expect(pitchClass("D♭")).toBe(pitchClass("C#"));
    expect(pitchClass("h")).toBeNull();
    expect(pitchClass("")).toBeNull();
  });

  it("has the five direct relationships as its primitive", () => {
    expect(directRelationship(0, "major", 0, "major")).toBe("same");
    expect(directRelationship(0, "major", 9, "minor")).toBe("relative");
    expect(directRelationship(0, "minor", 7, "minor")).toBe("dominant");
    expect(directRelationship(0, "minor", 5, "minor")).toBe("subdominant");
    expect(directRelationship(0, "minor", 0, "major")).toBe("parallel");
    expect(directRelationship(0, "minor", 2, "minor")).toBeNull();
  });
});

group("tempo", () => {
  it("folds half-time and double-time onto the same grid", () => {
    expect(foldTempo(170, 85)).toEqual([2, 1]);
    expect(foldTempo(85, 170)).toEqual([0.5, 1]);
    const fast = compareTempo(vit({ bpm: 170, bpm_confidence: 0.9 }), vit({ bpm: 85, bpm_confidence: 0.9 }));
    expect(fast.fold).toBe("double");
    expect(fast.folded_bpm).toBe(170);
    expect(fast.ratio).toBe(1);
    expect(fast.quality).toBe("transparent");
  });

  it("picks the nearest octave, then stretches what is left", () => {
    const [factor, ratio] = foldTempo(92, 180);
    expect(factor).toBe(0.5);
    expect(ratio).toBeCloseTo(92 / 90, 12);
  });

  it("bounds the fold so a quarter-time pairing is not claimed", () => {
    expect(foldTempo(160, 40)[0]).toBe(2);
    expect(foldTempo(160, 40, 2)[0]).toBe(4);
  });

  it("reports the ratio as what the candidate is multiplied by", () => {
    const match = compareTempo(vit({ bpm: 92, bpm_confidence: 0.9 }), vit({ bpm: 88, bpm_confidence: 0.9 }));
    expect(match.ratio).toBeCloseTo(92 / 88, 12);
    expect(match.percent as number).toBeGreaterThan(0);
    const back = compareTempo(vit({ bpm: 88, bpm_confidence: 0.9 }), vit({ bpm: 92, bpm_confidence: 0.9 }));
    expect(back.percent as number).toBeLessThan(0);
  });

  it("has bands that are symmetric in ratio space", () => {
    expect(stretchDistance(1)).toBe(0);
    expect(stretchDistance(1.06)).toBeCloseTo(0.06, 12);
    expect(stretchDistance(1 / 1.06)).toBeCloseTo(0.06, 12);
    const band = (ratio: number) =>
      compareTempo(vit({ bpm: 100, bpm_confidence: 0.9 }), vit({ bpm: 100 / ratio, bpm_confidence: 0.9 })).quality;
    expect(band(1.05)).toBe("transparent");
    expect(band(1.12)).toBe("usable");
    expect(band(1.2)).toBe("out_of_range");
  });

  it("lets the caller ask for transparent stretches only", () => {
    const source = vit({ bpm: 100, bpm_confidence: 0.9 });
    const candidate = vit({ bpm: 90, bpm_confidence: 0.9 });
    expect(compareTempo(source, candidate).quality).toBe("usable");
    expect(compareTempo(source, candidate, { tolerance: TRANSPARENT_MAX }).quality).toBe("out_of_range");
  });

  it("scores a closer tempo higher and charges a little for a fold", () => {
    const exact = compareTempo(vit({ bpm: 90, bpm_confidence: 0.9 }), vit({ bpm: 90, bpm_confidence: 0.9 }));
    const near = compareTempo(vit({ bpm: 90, bpm_confidence: 0.9 }), vit({ bpm: 88, bpm_confidence: 0.9 }));
    const edge = compareTempo(
      vit({ bpm: 90, bpm_confidence: 0.9 }),
      vit({ bpm: 90 / (1 + USABLE_MAX), bpm_confidence: 0.9 }),
    );
    const folded = compareTempo(vit({ bpm: 90, bpm_confidence: 0.9 }), vit({ bpm: 45, bpm_confidence: 0.9 }));
    expect(exact.score).toBe(1);
    expect(near.score).toBeLessThan(exact.score);
    expect(edge.score).toBeCloseTo(0.5, 6);
    expect(folded.score).toBeLessThan(exact.score);
  });
});

group("the missing values", () => {
  it("lets a keyless drum break fit anything and says the claim is tempo only", () => {
    const match = compatibility(
      vit({ bpm: 90, bpm_confidence: 0.9, tonic: "F", mode: "minor", key_confidence: 0.85 }),
      vit({ bpm: 90, bpm_confidence: 0.9 }),
    );
    expect(match.compatible).toBe(true);
    expect(match.key.relationship).toBe("unknown");
    expect(match.score).toBe(match.tempo.score);
    expect(match.method).toContain("tempo alone");
    expect(describe(match)).toBe("no key detected, tempo only");
    expect(match.confidence).toBe(0.9);
  });

  it("leans on the key when there is no tempo", () => {
    const match = compatibility(
      vit({ bpm: 90, bpm_confidence: 0.9, tonic: "F", mode: "minor", key_confidence: 0.8 }),
      vit({ tonic: "G#", mode: "major", key_confidence: 0.8 }),
    );
    expect(match.tempo.quality).toBe("unknown");
    expect(match.method).toContain("key alone");
    expect(describe(match)).toBe("relative major, no tempo detected");
  });
});

group("confidence", () => {
  it("is capped by the weakest measurement the claim uses", () => {
    const match = compatibility(
      vit({ bpm: 90, bpm_confidence: 0.95, tonic: "C", mode: "major", key_confidence: 0.42 }),
      vit({ bpm: 90, bpm_confidence: 0.93, tonic: "A", mode: "minor", key_confidence: 0.88 }),
    );
    expect(match.confidence).toBe(0.42);
    expect(match.confidence_bound_by).toBe("source_key");
    expect(match.confidence_reason).toContain("0.42");
    expect(match.confidence_reason).toContain("this file's key");
  });

  it("names the other file when the other file is the weak one", () => {
    const match = compatibility(
      vit({ bpm: 90, bpm_confidence: 0.95, tonic: "C", mode: "major", key_confidence: 0.9 }),
      vit({ bpm: 90, bpm_confidence: 0.93, tonic: "A", mode: "minor", key_confidence: 0.3 }),
    );
    expect(match.confidence).toBe(0.3);
    expect(match.confidence_bound_by).toBe("candidate_key");
  });

  it("treats a value with no recorded confidence as a zero", () => {
    const match = compatibility(
      vit({ bpm: 90, tonic: "C", mode: "major", key_confidence: 0.9 }),
      vit({ bpm: 90, bpm_confidence: 0.9, tonic: "C", mode: "major", key_confidence: 0.9 }),
    );
    expect(match.confidence).toBe(0);
    expect(match.confidence_bound_by).toBe("source_tempo");
  });

  it("offers nothing when nothing was measured", () => {
    const match = compatibility(vit({}), vit({}));
    expect(match.confidence).toBe(0);
    expect(match.confidence_bound_by).toBe("");
    expect(match.confidence_reason).toContain("nothing was measured");
  });
});

group("ranking", () => {
  it("puts the obvious answer first", () => {
    const source = vit({ bpm: 90, bpm_confidence: 0.9, tonic: "C", mode: "minor", key_confidence: 0.9 });
    const at = (tonic: string, mode: Mode, bpm = 90) =>
      compatibility(source, vit({ bpm, bpm_confidence: 0.9, tonic, mode, key_confidence: 0.9 })).score;
    expect(at("C", "minor")).toBeGreaterThan(at("D#", "major"));
    expect(at("D#", "major")).toBeGreaterThan(at("G", "minor"));
    expect(at("G", "minor")).toBeGreaterThan(at("C", "major"));
    expect(at("C", "minor")).toBeGreaterThan(at("C", "minor", 96));
  });
});
