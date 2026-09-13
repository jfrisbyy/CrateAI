import { describe, expect, it } from "vitest";
import {
  applyOperations,
  isRearrangementOf,
  patternRequest,
  patternsFromAdvisor,
  suggestPatterns,
  type PatternAdvisor,
  type PatternResponse,
} from "./patterns";
import { finalizeTake, type RecordedHit, type RecordingSettings, type TakeHit } from "./recording";

const SETTINGS: RecordingSettings = { bpm: 120, beatsPerBar: 4, bars: 2 }; // a bar is 2 s, a 16th 0.125 s

const hit = (time_s: number, pad: number, velocity = 1): TakeHit => ({ time_s, pad, chop_file_id: `f${pad}`, velocity });

/** Two bars: kick on the ones, snare on the threes, four hats a bar. */
function playedTake() {
  const hits: TakeHit[] = [
    hit(0, 0),
    hit(1, 1),
    hit(2, 0),
    hit(3, 1),
    ...[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5].map((t) => hit(t, 2)),
  ];
  return finalizeTake(hits, SETTINGS, 4);
}

describe("the guard: a variation is the producer's own take", () => {
  it("passes a rearrangement of their own hits", () => {
    const take = playedTake();
    const { hits } = applyOperations(take, SETTINGS, [{ op: "swap-bars", a: 0, b: 1 }]);
    expect(isRearrangementOf(take, hits, SETTINGS)).toMatchObject({ ok: true });
  });

  it("refuses a pad the take never played", () => {
    const take = playedTake();
    const invented: RecordedHit[] = [{ ...take.hits[0]!, pad: 9, chop_file_id: "f9" }];
    const check = isRearrangementOf(take, invented, SETTINGS);
    expect(check.ok).toBe(false);
    expect(check.reason).toContain("not in the take");
  });

  it("refuses a pad playing a slice the take did not", () => {
    const take = playedTake();
    const swapped: RecordedHit[] = [{ ...take.hits[0]!, chop_file_id: "somewhere-else" }];
    expect(isRearrangementOf(take, swapped, SETTINGS).ok).toBe(false);
  });

  it("refuses hits outside the take's own bars", () => {
    const take = playedTake();
    const late: RecordedHit[] = [{ ...take.hits[0]!, time_s: 99 }];
    expect(isRearrangementOf(take, late, SETTINGS).reason).toContain("outside the 2-bar take");
  });

  it("refuses a pattern with far more hits than were played", () => {
    const take = playedTake();
    const stuffed = Array.from({ length: take.hits.length * 3 }, (_, i) => ({ ...take.hits[i % take.hits.length]! }));
    expect(isRearrangementOf(take, stuffed, SETTINGS).ok).toBe(false);
  });
});

describe("the operations", () => {
  it("swaps two bars, moving every hit in them and nothing else", () => {
    const take = playedTake();
    const { hits, applied } = applyOperations(take, SETTINGS, [{ op: "swap-bars", a: 0, b: 1 }]);
    expect(applied[0]).toBe("Bars 1 and 2 swapped.");
    expect(hits.filter((h) => h.pad === 0).map((h) => h.time_s).sort((a, b) => a - b)).toEqual([0, 2]);
    expect(hits).toHaveLength(take.hits.length);
  });

  it("repeats a bar in place of another", () => {
    const take = playedTake();
    const { hits } = applyOperations(take, SETTINGS, [{ op: "repeat-bar", from: 0, to: 1 }]);
    const barTwo = hits.filter((h) => h.time_s >= 2).map((h) => Math.round((h.time_s - 2) * 1000));
    const barOne = hits.filter((h) => h.time_s < 2).map((h) => Math.round(h.time_s * 1000));
    expect(barTwo.sort((a, b) => a - b)).toEqual(barOne.sort((a, b) => a - b));
  });

  it("drops one pad from one bar", () => {
    const take = playedTake();
    const { hits } = applyOperations(take, SETTINGS, [{ op: "drop-pad-in-bar", pad: 2, bar: 1 }]);
    expect(hits.filter((h) => h.pad === 2 && h.time_s >= 2)).toHaveLength(0);
    expect(hits.filter((h) => h.pad === 2 && h.time_s < 2)).toHaveLength(4);
  });

  it("pushes one pad by 16ths, wrapping inside the take", () => {
    const take = playedTake();
    const { hits } = applyOperations(take, SETTINGS, [{ op: "shift-pad", pad: 0, steps: 1 }]);
    expect(hits.filter((h) => h.pad === 0).map((h) => h.time_s).sort((a, b) => a - b)).toEqual([0.125, 2.125]);
    const back = applyOperations(take, SETTINGS, [{ op: "shift-pad", pad: 0, steps: -1 }]);
    expect(back.hits.filter((h) => h.pad === 0).map((h) => h.time_s).sort((a, b) => a - b)).toEqual([1.875, 3.875]);
  });

  it("thins a roll and reverses the bars", () => {
    const take = playedTake();
    const thinned = applyOperations(take, SETTINGS, [{ op: "thin-pad", pad: 2, keep: 2 }]);
    expect(thinned.hits.filter((h) => h.pad === 2)).toHaveLength(4);
    const reversed = applyOperations(take, SETTINGS, [{ op: "reverse-bars" }]);
    expect(reversed.hits).toHaveLength(take.hits.length);
  });

  it("rejects an operation that does not fit the take instead of doing something else", () => {
    const take = playedTake();
    const { applied, rejected } = applyOperations(take, SETTINGS, [
      { op: "swap-bars", a: 0, b: 7 },
      { op: "drop-pad-in-bar", pad: 11, bar: 0 },
    ]);
    expect(applied).toEqual([]);
    expect(rejected).toHaveLength(2);
    expect(rejected[0]).toContain("the take has 2");
  });
});

describe("suggestions from the take itself", () => {
  it("offers variations, every one of them the producer's own hits", () => {
    const take = playedTake();
    const variations = suggestPatterns(take, SETTINGS, { max: 4 });
    expect(variations.length).toBeGreaterThan(0);
    expect(variations.length).toBeLessThanOrEqual(4);
    for (const v of variations) {
      expect(isRearrangementOf(take, v.hits, SETTINGS).ok).toBe(true);
      expect(v.derivation.length).toBeGreaterThan(0);
      expect(v.source).toBe("rules");
    }
  });

  it("offers nothing for an empty take, and nothing that changes nothing", () => {
    const empty = finalizeTake([], SETTINGS, 4);
    expect(suggestPatterns(empty, SETTINGS)).toEqual([]);
    const one = finalizeTake([hit(0, 0)], { ...SETTINGS, bars: 1 }, 2);
    for (const v of suggestPatterns(one, { ...SETTINGS, bars: 1 })) {
      expect(v.hits.length).toBeGreaterThan(0);
    }
  });
});

describe("the model seam", () => {
  it("sends symbolic material only: pads, steps, offsets, and the operations it may answer in", () => {
    const take = playedTake();
    const request = patternRequest(take, SETTINGS, { labels: new Map([[0, "kick"]]), instruction: "make it breathe" });
    expect(request).toMatchObject({ bpm: 120, beats_per_bar: 4, bars: 2, instruction: "make it breathe" });
    expect(request.pads[0]).toMatchObject({ pad: 0, label: "kick", hits: 2 });
    expect(request.hits[0]).toMatchObject({ pad: 0, bar: 0, step: 0 });
    expect(request.operations).toContain("swap-bars");
    expect(JSON.stringify(request)).not.toContain("f0"); // no file ids, no audio, nothing to download
  });

  it("runs what the model chose over the producer's own take", async () => {
    const take = playedTake();
    const advisor: PatternAdvisor = {
      propose: async (): Promise<PatternResponse> => ({
        variations: [{ name: "Second bar first", why: "your bars, swapped", operations: [{ op: "swap-bars", a: 0, b: 1 }] }],
      }),
    };
    const { variations, refused } = await patternsFromAdvisor(advisor, take, SETTINGS);
    expect(refused).toEqual([]);
    expect(variations).toHaveLength(1);
    expect(variations[0]?.source).toBe("model");
    expect(isRearrangementOf(take, variations[0]!.hits, SETTINGS).ok).toBe(true);
  });

  it("refuses a model that tries to invent a rhythm instead of rearranging one", async () => {
    const take = playedTake();
    const advisor: PatternAdvisor = {
      propose: async () =>
        ({
          variations: [
            { name: "A boom bap beat", why: "from your description", operations: [{ op: "add-hit", pad: 4, step: 3 }] },
            { name: "Nothing at all", why: "", operations: [] },
          ],
        }) as unknown as PatternResponse,
    };
    const { variations, refused } = await patternsFromAdvisor(advisor, take, SETTINGS);
    expect(variations).toEqual([]);
    expect(refused).toHaveLength(2);
    expect(refused[0]).toContain("not a rearrangement of your take");
  });

  it("refuses a model whose operations do not apply to this take", async () => {
    const take = playedTake();
    const advisor: PatternAdvisor = {
      propose: async () => ({ variations: [{ name: "Bar 9", why: "", operations: [{ op: "swap-bars", a: 8, b: 9 }] }] }),
    };
    const { variations, refused } = await patternsFromAdvisor(advisor, take, SETTINGS);
    expect(variations).toEqual([]);
    expect(refused[0]).toContain("did not come out as your own hits");
  });
});
