import { describe, expect, it } from "vitest";
import { FAITHFUL_NARRATION, sampleContent } from "./fixtures";
import { deterministicDocument } from "./prompt";
import { normalizeChordLabel, validateNarration } from "./validate";

describe("validateNarration", () => {
  const content = sampleContent();

  it("accepts a faithful narration and the measured document itself", () => {
    expect(validateNarration(FAITHFUL_NARRATION, content)).toEqual({ ok: true, problems: [] });
    expect(validateNarration(deterministicDocument(content), content).ok).toBe(true);
    expect(validateNarration(deterministicDocument(sampleContent({ chords: false })), sampleContent({ chords: false })).ok).toBe(true);
    expect(validateNarration(deterministicDocument(sampleContent({ identified: true })), sampleContent({ identified: true })).ok).toBe(true);
  });

  it("rejects an invented BPM", () => {
    const r = validateNarration("The vitals. It sits at 93 BPM in F minor.", content);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain("the number 93 is not in the facts");
  });

  it("rejects an invented key, and accepts the measured key in either spelling", () => {
    expect(validateNarration("The vitals. The key is G minor.", content).problems).toContain("the key G minor is not in the facts");
    expect(validateNarration("The harmony. It leans on Db major before the verse.", content).problems).toContain("the key Db major is not in the facts");
    expect(validateNarration("The vitals. Likely it sits at 92 BPM in F minor.", content).ok).toBe(true);
    const flatKey = sampleContent();
    flatKey.sections[0]!.facts[1] = { ...flatKey.sections[0]!.facts[1]!, text: "The key is Bb major.", value: { tonic: "A#", mode: "major" } };
    expect(validateNarration("The vitals. The key is A# major.", flatKey).ok).toBe(true);
  });

  it("does not read English 'A minor' as a key claim", () => {
    expect(validateNarration("The drums. A minor detail: the hats sit on 8ths.", content).ok).toBe(true);
    expect(validateNarration("The vitals. The key is A minor.", content).ok).toBe(false);
  });

  it("rejects an invented instrument", () => {
    const r = validateNarration("The melodic layer. A Rhodes chord stab sits under the loop, with strings in the hook.", content);
    expect(r.ok).toBe(false);
    expect(r.problems).toContain('the instrument "rhodes" is not in the facts');
    expect(r.problems).toContain('the instrument "strings" is not in the facts');
    expect(validateNarration("The bass. There's a bass part, and it likely follows the sample's roots.", content).ok).toBe(true);
    expect(validateNarration("The drums. Layered 808s under the break.", content).ok).toBe(false);
  });

  it("never lets a progression through when chords were not measured (section 14)", () => {
    const missing = sampleContent({ chords: false });
    const bad = "The harmony. The progression runs Fm – Bbm – Db, a classic minor turnaround.";
    const r = validateNarration(bad, missing);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual(expect.arrayContaining(["the chord Fm is not in the facts", "the chord Bbm is not in the facts", "the chord Db is not in the facts"]));
    const spelled = validateNarration("The harmony. It moves from F minor to Bb minor to Db major.", missing);
    expect(spelled.ok).toBe(false);
    expect(spelled.problems).toContain("the key Bb minor is not in the facts");
    expect(validateNarration("The harmony. Chords weren't measured yet; I can run chord analysis for you.", missing).ok).toBe(true);
  });

  it("accepts the measured progression and rejects an extension the facts don't carry", () => {
    expect(validateNarration("The harmony. Likely the verse runs Fm – Bbm – Db.", content).ok).toBe(true);
    expect(validateNarration("The harmony. Likely the verse runs Fm7 – Bbm – Db.", content).problems).toContain("the chord Fm7 is not in the facts");
    expect(validateNarration("The structure. It alternates A, B, A, B.", content).ok).toBe(true);
  });

  it("keeps the hedge on a value the facts only state hedged", () => {
    expect(validateNarration("The mix. The reverb tail is 1.2 s.", content).problems).toContain('"The reverb tail is 1.2 s." states 1.2 without its hedge');
    expect(validateNarration("The mix. The reverb tail is roughly 1.2 s.", content).ok).toBe(true);
    expect(validateNarration("The vitals. It could be 46 or 184 depending on how you count it.", content).ok).toBe(false);
    expect(validateNarration("The vitals. Likely 92 BPM, though it could be 46 or 184 depending on how you count it.", content).ok).toBe(true);
  });

  it("ignores list numbering and accepts numbers from fact values", () => {
    expect(validateNarration("The recipe.\n1. Find a 4-bar loop around 92 in F minor.\n2. Chop it in 4 and play them 1-2-1-3.", content).ok).toBe(true);
    expect(validateNarration("The melodic layer. The harmonic layer centers around 1450.3 Hz.", content).ok).toBe(true);
    expect(validateNarration("The mix. It's -14.2 LUFS with 6.1 LU of range and 0.22 stereo width.", content).ok).toBe(true);
  });

  it("reports each problem once", () => {
    const r = validateNarration("The vitals. 93 BPM. Again, 93 BPM.", content);
    expect(r.problems).toEqual(["the number 93 is not in the facts"]);
  });
});

describe("normalizeChordLabel", () => {
  it("brings the composer's labels and the narrator's spellings to one form", () => {
    expect(normalizeChordLabel("Fm")).toBe("F:min");
    expect(normalizeChordLabel("F:min")).toBe("F:min");
    expect(normalizeChordLabel("Bbm")).toBe("A#:min");
    expect(normalizeChordLabel("Bb:maj")).toBe("A#:maj");
    expect(normalizeChordLabel("Db")).toBe("C#:maj");
    expect(normalizeChordLabel("C#m7")).toBe("C#:min7");
    expect(normalizeChordLabel("N")).toBeNull();
    expect(normalizeChordLabel("verse")).toBeNull();
  });
});
