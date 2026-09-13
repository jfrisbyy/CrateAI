import { describe, expect, it } from "vitest";
import { fakeFile } from "./fakes";
import { buildContextBlock, GROUNDING_CONTRACT, HEDGE_TABLE, LINK_REFUSAL, SYSTEM_PROMPT } from "./system";

describe("system prompt", () => {
  it("embeds the nine principles in the model's voice", () => {
    for (const phrase of ["Nothing from nothing", "Measure, don't guess", "Read the internet, never download audio from it", "Every output is editable", "The library is the product", "private", "Corrections are ground truth"]) {
      expect(SYSTEM_PROMPT).toContain(phrase);
    }
    expect(SYSTEM_PROMPT).toContain("I will not generate a beat");
  });

  it("carries the grounding contract verbatim and the hedge bands", () => {
    expect(SYSTEM_PROMPT).toContain(GROUNDING_CONTRACT);
    expect(GROUNDING_CONTRACT).toContain("get_report or explain");
    expect(GROUNDING_CONTRACT).toContain("web_search, fetch_page or identify_context");
    expect(GROUNDING_CONTRACT).toContain('0.6 to 0.8, say "likely"');
    expect(GROUNDING_CONTRACT).toContain('0.4 to 0.6, say "roughly"');
    expect(GROUNDING_CONTRACT).toContain('below 0.4, say "I can\'t tell"');
    expect(SYSTEM_PROMPT).toContain(HEDGE_TABLE);
  });

  it("refuses audio from links with the one standard sentence", () => {
    expect(LINK_REFUSAL).toBe("I can't pull audio from links; upload the file and I'll take it from there.");
    expect(SYSTEM_PROMPT).toContain(`"${LINK_REFUSAL}"`);
    expect(SYSTEM_PROMPT).toContain("do not call any tool for it");
  });

  it("teaches the producer vocabulary", () => {
    expect(SYSTEM_PROMPT).toContain('"the and of three"');
    expect(SYSTEM_PROMPT).toContain("Bb major");
    expect(SYSTEM_PROMPT).toContain("A# minor is said as Bb minor");
  });

  it("is stable across calls (so the cache prefix holds) and has no date in it", () => {
    expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT);
    expect(SYSTEM_PROMPT).not.toMatch(/20\d\d-\d\d-\d\d/);
  });
});

describe("context block", () => {
  it("lists the attached files with ids, vitals and hedges, and the open file's summary", () => {
    const open = fakeFile({ original_filename: "open.wav" });
    const other = fakeFile({ original_filename: "other.wav", status: "queued" }, null);
    const block = buildContextBlock([open, other], open.id, new Date("2026-09-13T12:00:00Z"));
    expect(block).toContain("Today is 2026-09-13");
    expect(block).toContain(`[open] open.wav | id ${open.id}`);
    expect(block).toContain("92 BPM (0.91)");
    expect(block).toContain("likely F minor (0.70)");
    expect(block).toContain(`other.wav | id ${other.id} | original | queued`);
    expect(block).toContain("tempo not analyzed");
    expect(block).toContain(`Effective report summary of the open file (${open.id})`);
    expect(block).toContain('"not_analyzed"');
  });

  it("says when nothing is attached, or the open file has no report", () => {
    expect(buildContextBlock([], null)).toContain("No files are attached");
    const raw = fakeFile({ status: "analyzing" }, null);
    expect(buildContextBlock([raw], raw.id)).toContain("has no report yet (status analyzing)");
  });
});
