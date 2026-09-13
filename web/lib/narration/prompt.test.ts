import { describe, expect, it } from "vitest";
import { sampleContent } from "./fixtures";
import { jobLabel, jobOffer, jobRequest } from "./jobs";
import { buildNarrationPrompt, buildUserMessage, deterministicDocument, deterministicParagraphs, NARRATION_SYSTEM_PROMPT, textCarriesHedge } from "./prompt";

describe("the narration prompt", () => {
  it("carries every fact text and every hedge word into the user message", () => {
    const content = sampleContent();
    const { user } = buildNarrationPrompt(content);
    for (const section of content.sections) {
      expect(user).toContain(`## ${section.title}`);
      for (const fact of section.facts) {
        expect(user).toContain(fact.text);
        if (textCarriesHedge(fact)) expect(user).toContain(`[hedge: ${fact.hedge}]`);
        if (section.key !== "recipe") expect(user).toContain(`measured from ${fact.source}`);
      }
    }
    expect(user).toContain("[hedge: likely]");
    expect(user).toContain("[hedge: roughly]");
    expect(user).toContain("confidence 0.40");
  });

  it("marks what was not measured and names the job to run", () => {
    const user = buildUserMessage(sampleContent({ chords: false }));
    expect(user).toContain("NOT MEASURED: Chords weren't measured yet. Offer: Run chord analysis.");
    expect(user).toContain("Still waiting on: analyze:other");
    expect(user).not.toContain("Fm – Bbm – Db");
  });

  it("keeps the sections in producer order with the recipe last as steps", () => {
    const user = buildUserMessage(sampleContent());
    const titles = ["The vitals", "The structure", "The sample", "The drums", "The bass", "The harmony", "The melodic layer", "The arrangement", "The mix", "The context", "The recipe"];
    const positions = titles.map((t) => user.indexOf(`## ${t}`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(user).toContain("- STEP 1: Find a 4-bar loop around 92 in F minor.");
    expect(user).toContain("- STEP 7: Aim the mix at about -14 LUFS.");
  });

  it("hands world facts over with their citation title", () => {
    const user = buildUserMessage(sampleContent({ identified: true }));
    expect(user).toContain('Breakdown of "Test Track" by Test Artist.');
    expect(user).toContain("WORLD FACT [cite as: Interview with Test Producer] Produced by Test Producer in a home studio. (https://example.com/interview)");
  });

  it("states the grounding contract in the system prompt", () => {
    const s = NARRATION_SYSTEM_PROMPT;
    expect(s).toContain("only rephrase the facts");
    expect(s).toContain('"likely", "roughly", or "I can\'t tell"');
    expect(s).toContain("NOT MEASURED");
    expect(s).toContain("square brackets");
    expect(s).toContain("recipe comes last");
    expect(s).toContain("Do not add a number, a key, a chord, an instrument");
  });
});

describe("the deterministic document", () => {
  it("is the fact texts joined by section, the recipe numbered, the citation in brackets", () => {
    const content = sampleContent({ identified: true });
    const doc = deterministicDocument(content);
    const paragraphs = deterministicParagraphs(content);
    expect(paragraphs).toHaveLength(11);
    expect(paragraphs[0]).toBe(
      ["The vitals", "Likely it sits at 92 BPM, though it could be 46 or 184 depending on how you count it.", "The key is F minor.", "It's in 4/4.", "Roughly the feel is swung, about 58 percent."].join("\n"),
    );
    expect(doc).toContain("Produced by Test Producer in a home studio. [Interview with Test Producer]");
    expect(paragraphs[10]).toContain("The recipe\n1. Find a 4-bar loop around 92 in F minor.\n2. Chop it in 4");
    expect(doc.indexOf("The recipe")).toBeGreaterThan(doc.indexOf("The context"));
  });

  it("says a missing section was not measured and offers the job", () => {
    const doc = deterministicDocument(sampleContent({ chords: false }));
    expect(doc).toContain("The harmony\nChords weren't measured yet. I can run chord analysis for you.");
    expect(doc).not.toContain("Fm – Bbm – Db");
    expect(doc).toContain("Identify the track and I can add what's been documented about it.");
  });

  it("keeps 'roughly' on the low-confidence effects fact", () => {
    expect(deterministicDocument(sampleContent())).toContain("Roughly the reverb tail is around 1.2 s (rough).");
  });
});

describe("the jobs a missing entry names", () => {
  const fileId = "00000000-0000-4000-8000-000000000001";
  const stems = [{ stem: "drums", stem_file_id: "00000000-0000-4000-8000-000000000002" }];

  it("labels and offers", () => {
    expect(jobLabel("stems")).toBe("Separate stems");
    expect(jobLabel("analyze:chords")).toBe("Run chord analysis");
    expect(jobLabel("analyze:drums")).toBe("Analyze the drums stem");
    expect(jobLabel("analyze:phase4")).toBe("Run the breakdown stages");
    expect(jobLabel("identify_context")).toBeNull();
    expect(jobLabel(null)).toBeNull();
    expect(jobOffer("analyze:chords")).toBe("I can run chord analysis for you.");
  });

  it("maps to POST /api/jobs bodies, with force on partial analyze runs", () => {
    expect(jobRequest("stems", fileId)).toEqual({ kind: "stems", file_id: fileId, params: { model: "htdemucs_ft" } });
    expect(jobRequest("analyze:chords", fileId)).toEqual({ kind: "analyze", file_id: fileId, params: { stages: ["chords"], force: true } });
    expect(jobRequest("analyze:phase4", fileId)).toEqual({
      kind: "analyze",
      file_id: fileId,
      params: { stages: ["chords", "drums", "sample_use", "instrumentation", "effects_estimates"], force: true },
    });
    expect(jobRequest("analyze:drums", fileId, stems)).toEqual({ kind: "analyze", file_id: stems[0]!.stem_file_id, params: { force: true } });
    expect(jobRequest("analyze:drums", fileId, [])).toBeNull();
    expect(jobRequest("analyze", fileId)).toEqual({ kind: "analyze", file_id: fileId, params: { force: true } });
    expect(jobRequest("identify_context", fileId)).toBeNull();
    expect(jobRequest("analyze:nonsense", fileId)).toBeNull();
  });
});
