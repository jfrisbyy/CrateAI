import { describe, expect, it } from "vitest";
import { confidenceLevel, hedgeWord, hedged } from "./hedge";

// Mirrors analysis/tests/test_report_schema.py::test_hedge_bands.
describe("hedgeWord", () => {
  it.each<[number | null, string]>([
    [0.95, ""],
    [0.8, ""],
    [0.7, "likely"],
    [0.6, "likely"],
    [0.5, "roughly"],
    [0.4, "roughly"],
    [0.39, "I can't tell"],
    [0.0, "I can't tell"],
    [null, "not measured"],
  ])("hedgeWord(%s) -> %j", (conf, word) => {
    expect(hedgeWord(conf)).toBe(word);
  });

  it("treats undefined like null", () => {
    expect(hedgeWord(undefined)).toBe("not measured");
  });
});

describe("confidenceLevel", () => {
  it("maps to three dot levels plus none", () => {
    expect(confidenceLevel(0.9)).toBe("full");
    expect(confidenceLevel(0.8)).toBe("full");
    expect(confidenceLevel(0.65)).toBe("half");
    expect(confidenceLevel(0.6)).toBe("half");
    expect(confidenceLevel(0.59)).toBe("low");
    expect(confidenceLevel(0)).toBe("low");
    expect(confidenceLevel(null)).toBe("none");
    expect(confidenceLevel(Number.NaN)).toBe("none");
  });
});

describe("hedged", () => {
  it("prefixes the hedge word and leaves confident values alone", () => {
    expect(hedged("F minor", 0.9)).toBe("F minor");
    expect(hedged("F minor", 0.7)).toBe("likely F minor");
    expect(hedged("92 BPM", 0.5)).toBe("roughly 92 BPM");
    expect(hedged("92 BPM", 0.1)).toBe("92 BPM (I can't tell)");
    expect(hedged("92 BPM", null)).toBe("not measured yet");
  });
});
