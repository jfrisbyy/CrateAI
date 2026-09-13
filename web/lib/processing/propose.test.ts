// The model half of the seam, against a fake. Nothing here opens a connection;
// `requestProposal` takes the call as an argument precisely so the whole path —
// brief, schema, validation, clamping, application — is asserted in node.

import { describe as group, expect, it } from "vitest";
import { bandOf, defaultProcessing, setBand, setBypass } from "./chain";
import { briefLines, buildBrief, guardsFor, parseProposal, PROPOSE_PROCESSING_TOOL, requestProposal, type ProcessingBrief } from "./propose";
import { BAND_IDS } from "./types";

function brief(overrides: Partial<ProcessingBrief> = {}): ProcessingBrief {
  return {
    ...buildBrief({
      complaint: "this trumpet sounds awful, clean it up",
      track: { id: "t1", name: "Moonlight Highlife horns", provenance: "Moonlight Highlife, other, 1:12–1:20", stem: "other", separationModel: "bs_roformer", sourceName: "Moonlight Highlife", rate: 0.964 },
      current: defaultProcessing(),
      bandwidth: { value: 13500, confidence: 0.9, method: "rolloff_99" },
      tempoBpm: 92,
    }),
    ...overrides,
  };
}

function answer(moves: unknown[], extra: Record<string, unknown> = {}) {
  return { track_id: "t1", summary: "the build-up in the low mids", confidence: 0.62, moves, ...extra };
}

group("what a model is told", () => {
  it("carries the complaint verbatim and the controls as they read now", () => {
    const payload = brief();
    expect(payload.complaint).toBe("this trumpet sounds awful, clean it up");
    expect(payload.current).toEqual(defaultProcessing());
    expect(payload.limits.maxBoostDb).toBe(12);
  });

  it("says where the record's bandwidth ends, with what measured it", () => {
    const lines = briefLines(brief()).join("\n");
    expect(lines).toContain("13.5 kHz");
    expect(lines).toContain("rolloff_99");
    expect(lines).toContain("do not lift above it");
  });

  it("says plainly when nothing measured the bandwidth rather than leaving it out", () => {
    const lines = briefLines(brief({ bandwidth: null })).join("\n");
    expect(lines).toContain("not measured");
    expect(lines).toContain("do not assume there is air to lift");
  });

  it("names the separator and the resampling, because both change what is there to fix", () => {
    const lines = briefLines(brief()).join("\n");
    expect(lines).toContain("bs_roformer");
    expect(lines).toContain("0.964x");
  });

  it("hands the same ceiling to the guard, so the brief and the clamp cannot disagree", () => {
    expect(guardsFor(brief()).sourceCeilingHz).toBe(13500);
    expect(guardsFor(brief({ bandwidth: null })).sourceCeilingHz).toBeNull();
  });
});

group("the tool a model answers with", () => {
  it("is strict, and its fields are the controls themselves", () => {
    expect(PROPOSE_PROCESSING_TOOL.name).toBe("propose_processing");
    expect(PROPOSE_PROCESSING_TOOL.strict).toBe(true);
    expect(PROPOSE_PROCESSING_TOOL.input_schema.additionalProperties).toBe(false);
    const move = PROPOSE_PROCESSING_TOOL.input_schema.properties.moves.items;
    expect(move.additionalProperties).toBe(false);
    expect(Object.keys(move.properties)).toEqual(["op", "band", "frequency_hz", "gain_db", "q", "trim_db", "tune_cents", "why"]);
    expect(move.required).toContain("why");
  });

  it("offers exactly the seven slots that exist", () => {
    expect(PROPOSE_PROCESSING_TOOL.input_schema.properties.moves.items.properties.band.enum).toEqual([...BAND_IDS]);
  });

  it("tells the model the limits rather than letting it discover them", () => {
    expect(PROPOSE_PROCESSING_TOOL.description).toContain("+12 dB");
    expect(PROPOSE_PROCESSING_TOOL.description).toContain("400 Hz");
    expect(PROPOSE_PROCESSING_TOOL.description).toContain("measured bandwidth");
    expect(PROPOSE_PROCESSING_TOOL.description).toContain("never claim a measured fact");
  });
});

group("validating what comes back", () => {
  it("turns a good answer into moves on named slots", () => {
    const parsed = parseProposal(answer([{ op: "band", band: "lo", frequency_hz: 250, gain_db: -4, q: 1.2, why: "mud" }]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.trackId).toBe("t1");
    expect(parsed.value.proposal.moves[0]).toMatchObject({ op: "band", band: "lo", frequency: 250, gainDb: -4, q: 1.2, enabled: true });
    expect(parsed.value.proposal.confidence).toBe(0.62);
  });

  it("refuses an answer that is not a proposal at all", () => {
    for (const raw of [null, "a curve", 42, {}, { track_id: "t1" }]) {
      expect(parseProposal(raw).ok, JSON.stringify(raw)).toBe(false);
    }
  });

  it("refuses a confidence outside 0 to 1 rather than clamping a claim", () => {
    expect(parseProposal(answer([{ op: "band", band: "lo", gain_db: -3, why: "mud" }], { confidence: 4 })).ok).toBe(false);
  });

  it("skips a move with no band or no numbers, and keeps the rest", () => {
    const parsed = parseProposal(answer([
      { op: "band", gain_db: -3, why: "no band named" },
      { op: "band", band: "hi", why: "nothing asked for" },
      { op: "band", band: "lo", gain_db: -3, why: "mud" },
    ]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.proposal.moves).toHaveLength(1);
    expect(parsed.value.proposal.notes.join(" ")).toContain("named no band");
    expect(parsed.value.proposal.notes.join(" ")).toContain("changed nothing");
  });

  it("refuses when nothing usable is left rather than applying half of it", () => {
    const parsed = parseProposal(answer([{ op: "trim", why: "no number" }]));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("carried no number");
  });

  it("requires a reason on every move", () => {
    expect(parseProposal(answer([{ op: "band", band: "lo", gain_db: -3 }])).ok).toBe(false);
  });
});

group("asking", () => {
  it("applies a good answer to the chain the producer is looking at", async () => {
    const result = await requestProposal(brief(), async () => answer([
      { op: "band", band: "hp", frequency_hz: 60, why: "the mush a separator leaves" },
      { op: "band", band: "hs", frequency_hz: 8000, gain_db: 3, why: "the air it took" },
    ]));
    expect(result.ok).toBe(true);
    expect(bandOf(result.result!.processing, "hp")).toMatchObject({ frequency: 60, enabled: true });
    expect(bandOf(result.result!.processing, "hs").gainDb).toBe(3);
  });

  it("clamps an over-eager answer and reports what it did instead", async () => {
    const result = await requestProposal(brief(), async () => answer([{ op: "band", band: "hs", frequency_hz: 8000, gain_db: 24, why: "much brighter" }]));
    expect(result.ok).toBe(true);
    expect(bandOf(result.result!.processing, "hs").gainDb).toBe(12);
    expect(result.result!.notes.join(" ")).toContain("asked for +24 dB");
  });

  it("will not let a model lift above the bandwidth it was told about", async () => {
    const result = await requestProposal(brief(), async () => answer([{ op: "band", band: "hs", frequency_hz: 16000, gain_db: 4, why: "air" }]));
    expect(bandOf(result.result!.processing, "hs").frequency).toBe(13500);
    expect(result.result!.notes.join(" ")).toContain("13.5 kHz");
  });

  it("says why rather than throwing when the call fails", async () => {
    const result = await requestProposal(brief(), async () => {
      throw new Error("the model is over its limit");
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("the model is over its limit");
    expect(result.result).toBeNull();
  });

  it("says so when the answer would change nothing", async () => {
    const already = setBypass(setBand(defaultProcessing(), "lo", { frequency: 250, gainDb: -4, q: 1.2, enabled: true }), false);
    const result = await requestProposal(brief({ current: already }), async () => answer([{ op: "band", band: "lo", frequency_hz: 250, gain_db: -4, q: 1.2, why: "mud" }]));
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("would not change anything");
  });

  it("never reaches a network: the call is an argument", async () => {
    let asked = 0;
    await requestProposal(brief(), async () => {
      asked++;
      return answer([{ op: "band", band: "lo", gain_db: -3, why: "mud" }]);
    });
    expect(asked).toBe(1);
  });
});
