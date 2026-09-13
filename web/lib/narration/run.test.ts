import { describe, expect, it } from "vitest";
import { FAITHFUL_NARRATION, sampleContent } from "./fixtures";
import { DeterministicNarrator, scriptedNarrator, type Narrator } from "./narrator";
import { deterministicDocument } from "./prompt";
import { NOTES, runNarration, type NarrationEvent, type NarrationOutcome } from "./run";
import { validateNarration } from "./validate";

async function collect(narrator: Narrator | null, content = sampleContent()): Promise<{ events: NarrationEvent[]; outcome: NarrationOutcome }> {
  const events: NarrationEvent[] = [];
  const it = runNarration(narrator, content);
  while (true) {
    const next = await it.next();
    if (next.done) return { events, outcome: next.value };
    events.push(next.value);
  }
}

const paragraphs = (events: NarrationEvent[]) => events.filter((e) => e.type === "paragraph").map((e) => (e as { text: string }).text);
const notes = (events: NarrationEvent[]) => events.filter((e) => e.type === "note").map((e) => (e as { text: string }).text);

/** Split text into deltas of a few characters so paragraph boundaries fall inside chunks. */
function chunked(text: string, size = 7): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

describe("runNarration", () => {
  it("streams a faithful narration paragraph by paragraph and keeps all of it", async () => {
    const { events, outcome } = await collect(scriptedNarrator(chunked(FAITHFUL_NARRATION)));
    expect(paragraphs(events)).toEqual(FAITHFUL_NARRATION.split("\n\n"));
    expect(notes(events)).toEqual([]);
    expect(outcome).toMatchObject({ source: "model", removed: 0, problems: [], stop: "end_turn", error: null });
    expect(outcome.text).toBe(FAITHFUL_NARRATION);
    expect(validateNarration(outcome.text, sampleContent()).ok).toBe(true);
  });

  it("removes a paragraph that says something unmeasured, says so, and saves only the rest", async () => {
    const good = FAITHFUL_NARRATION.split("\n\n");
    const invented = "The melodic layer. A Rhodes plays the hook at 96 BPM.";
    const text = [...good.slice(0, 6), invented, ...good.slice(7)].join("\n\n");
    const { events, outcome } = await collect(scriptedNarrator(chunked(text, 11)));
    expect(paragraphs(events)).not.toContain(invented);
    expect(paragraphs(events)).toHaveLength(good.length - 1);
    expect(notes(events)).toEqual([NOTES.removed(1)]);
    expect(outcome.source).toBe("model");
    expect(outcome.removed).toBe(1);
    expect(outcome.problems).toEqual(expect.arrayContaining(['the instrument "rhodes" is not in the facts', "the number 96 is not in the facts"]));
    expect(outcome.text).not.toContain("Rhodes");
    expect(outcome.text.split("\n\n")).toHaveLength(good.length - 1);
  });

  it("with chords not measured, the narration says so and offers the job, never a progression (section 14)", async () => {
    const content = sampleContent({ chords: false });
    const { outcome } = await collect(new DeterministicNarrator(), content);
    expect(outcome.source).toBe("model");
    expect(outcome.removed).toBe(0);
    expect(outcome.text).toContain("Chords weren't measured yet. I can run chord analysis for you.");
    expect(outcome.text).not.toMatch(/Fm|Bbm|Db/);
    expect(validateNarration(outcome.text, content).ok).toBe(true);

    const inventing = FAITHFUL_NARRATION.replace(
      "The harmony. Likely the verse runs Fm – Bbm – Db, and the sample and the song share a key.",
      "The harmony. The verse runs Fm – Bbm – Db, a classic minor turnaround.",
    );
    const bad = await collect(scriptedNarrator(chunked(inventing)), content);
    expect(bad.outcome.removed).toBe(1);
    expect(bad.outcome.text).not.toContain("Fm – Bbm – Db");
    expect(bad.outcome.problems).toContain("the chord Fm is not in the facts");
    expect(notes(bad.events)).toEqual([NOTES.removed(1)]);
  });

  it("keeps 'roughly' on the 0.4-confidence effects fact and drops a line that loses it", async () => {
    const content = sampleContent();
    const reverb = content.sections.find((s) => s.key === "mix")!.facts.find((f) => f.source === "effects_estimates.reverb_tail_s")!;
    expect(reverb.confidence).toBe(0.4);
    expect(reverb.hedge).toBe("roughly");
    const { outcome } = await collect(new DeterministicNarrator(), content);
    expect(outcome.text).toContain("Roughly the reverb tail is around 1.2 s (rough).");

    const certain = FAITHFUL_NARRATION.replace(", and roughly a 1.2 s reverb tail (rough).", ". The reverb tail is 1.2 s.");
    const { outcome: dropped } = await collect(scriptedNarrator(chunked(certain)), content);
    expect(dropped.removed).toBe(1);
    expect(dropped.text).not.toContain("1.2 s");
    expect(dropped.problems.some((p) => p.includes("states 1.2 without its hedge"))).toBe(true);
  });

  it("reports a refusal and falls back to the measured document", async () => {
    const { events, outcome } = await collect(scriptedNarrator(["The vitals. Likely it sits at 92 BPM.\n\n"], "refusal"));
    expect(events.some((e) => e.type === "reset")).toBe(true);
    expect(notes(events)).toEqual([NOTES.refusal]);
    expect(outcome.source).toBe("deterministic");
    expect(outcome.stop).toBe("refusal");
    expect(outcome.text).toBe(deterministicDocument(sampleContent()));
  });

  it("reports max_tokens without inventing an ending", async () => {
    const partial = FAITHFUL_NARRATION.split("\n\n").slice(0, 3).join("\n\n");
    const { events, outcome } = await collect(scriptedNarrator(chunked(partial), "max_tokens"));
    expect(paragraphs(events)).toHaveLength(3);
    expect(notes(events)).toEqual([NOTES.maxTokens]);
    expect(outcome).toMatchObject({ source: "model", stop: "max_tokens", removed: 0 });
    expect(outcome.text).toBe(partial);
  });

  it("falls back to the measured document when nothing survives validation", async () => {
    const { events, outcome } = await collect(scriptedNarrator(["The vitals. It sits at 120 BPM in E major.\n\nThe drums. Programmed 808s."]));
    expect(notes(events)).toEqual([NOTES.nothingKept]);
    expect(outcome.source).toBe("deterministic");
    expect(outcome.removed).toBe(2);
    expect(outcome.text).toBe(deterministicDocument(sampleContent()));
  });

  it("uses the measured document with a note when no model is configured", async () => {
    const { events, outcome } = await collect(null);
    expect(notes(events)).toEqual([NOTES.noModel]);
    expect(outcome.source).toBe("deterministic");
    expect(paragraphs(events).join("\n\n")).toBe(deterministicDocument(sampleContent()));
    expect(outcome.text).toBe(deterministicDocument(sampleContent()));
  });

  it("turns a failing narrator into a note and the measured document", async () => {
    const failing: Narrator = {
      async *narrate() {
        yield "The vitals. Likely it sits at 92 BPM.\n\n";
        throw new Error("401 authentication_error: invalid x-api-key");
      },
    };
    const { events, outcome } = await collect(failing);
    expect(paragraphs(events)[0]).toBe("The vitals. Likely it sits at 92 BPM.");
    expect(events.some((e) => e.type === "reset")).toBe(true);
    expect(notes(events)).toEqual([NOTES.error("401 authentication_error: invalid x-api-key")]);
    expect(outcome).toMatchObject({ source: "deterministic", error: "401 authentication_error: invalid x-api-key" });
  });
});
