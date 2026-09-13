import { describe, expect, it } from "vitest";
import { parseQuery } from "./parse";

describe("parseQuery", () => {
  it("parses a bpm with tolerance", () => {
    expect(parseQuery("85 bpm")).toMatchObject({ bpm_min: 83, bpm_max: 87, text_query: null });
    expect(parseQuery("bpm 120")).toMatchObject({ bpm_min: 118, bpm_max: 122 });
    expect(parseQuery("bpm:92")).toMatchObject({ bpm_min: 90, bpm_max: 94 });
  });

  it("parses a range in either order", () => {
    expect(parseQuery("80-95")).toMatchObject({ bpm_min: 80, bpm_max: 95 });
    expect(parseQuery("95 - 80 bpm")).toMatchObject({ bpm_min: 80, bpm_max: 95 });
    expect(parseQuery("80–95")).toMatchObject({ bpm_min: 80, bpm_max: 95 });
  });

  it("parses 'around'", () => {
    expect(parseQuery("something dusty around 85")).toMatchObject({ bpm_min: 80, bpm_max: 90, text_query: "something dusty" });
  });

  it("parses keys in the ways producers type them", () => {
    expect(parseQuery("f minor")).toMatchObject({ tonic: "F", mode: "minor", text_query: null });
    expect(parseQuery("fm")).toMatchObject({ tonic: "F", mode: "minor" });
    expect(parseQuery("bb major horns")).toMatchObject({ tonic: "A#", mode: "major", text_query: "horns" });
    expect(parseQuery("Ebmin")).toMatchObject({ tonic: "D#", mode: "minor" });
  });

  it("parses kind filters", () => {
    expect(parseQuery("kind:stem")).toMatchObject({ kind: "stem", text_query: null });
    expect(parseQuery("kind:loop rhodes")).toMatchObject({ kind: "loop_render", text_query: "rhodes" });
    expect(parseQuery("kind:nonsense")).toMatchObject({ kind: null, text_query: null });
  });

  it("treats a bare number in tempo range as bpm", () => {
    expect(parseQuery("85")).toMatchObject({ bpm_min: 83, bpm_max: 87 });
    expect(parseQuery("808 kick")).toMatchObject({ bpm_min: null, text_query: "808 kick" });
  });

  it("combines filters and keeps the rest as text", () => {
    const p = parseQuery("something dusty in f minor around 85 with horns kind:stem");
    expect(p).toEqual({
      text_query: "something dusty in with horns",
      bpm_min: 80,
      bpm_max: 90,
      tonic: "F",
      mode: "minor",
      kind: "stem",
    });
  });

  it("returns all nulls for an empty query", () => {
    expect(parseQuery("   ")).toEqual({ text_query: null, bpm_min: null, bpm_max: null, tonic: null, mode: null, kind: null });
  });
});
