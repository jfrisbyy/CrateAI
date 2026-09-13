import { describe, expect, it } from "vitest";
import { describeParsed, emptyParsed, findTags, parseQuery } from "./parse";
import { expandTags } from "./vocabulary";

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

  it("parses 'around' and drops filler from the text", () => {
    expect(parseQuery("something dusty around 85")).toMatchObject({ bpm_min: 80, bpm_max: 90, text_query: "dusty", tags: ["dusty"] });
  });

  it("parses keys in the ways producers type them", () => {
    expect(parseQuery("f minor")).toMatchObject({ tonic: "F", mode: "minor", text_query: null });
    expect(parseQuery("fm")).toMatchObject({ tonic: "F", mode: "minor" });
    expect(parseQuery("bb major horns")).toMatchObject({ tonic: "A#", mode: "major", text_query: "horns", tags: ["horns"] });
    expect(parseQuery("Ebmin")).toMatchObject({ tonic: "D#", mode: "minor" });
  });

  it("parses kind filters, typed and spoken", () => {
    expect(parseQuery("kind:stem")).toMatchObject({ kind: "stem", text_query: null });
    expect(parseQuery("kind:loop rhodes")).toMatchObject({ kind: "loop_render", text_query: "rhodes" });
    expect(parseQuery("kind:nonsense")).toMatchObject({ kind: null, text_query: null });
    expect(parseQuery("drum stems around 90")).toMatchObject({ kind: "stem", bpm_min: 85, bpm_max: 95, text_query: "drum" });
    expect(parseQuery("rhodes chops")).toMatchObject({ kind: "chop", text_query: "rhodes" });
  });

  it("treats a bare number in tempo range as bpm", () => {
    expect(parseQuery("85")).toMatchObject({ bpm_min: 83, bpm_max: 87 });
    expect(parseQuery("808 kick")).toMatchObject({ bpm_min: null, text_query: "808 kick", tags: ["808", "kick"] });
  });

  it("resolves the packet's acceptance query fully", () => {
    const p = parseQuery("Something dusty in F minor around 85 with horns, no drums");
    expect(p).toMatchObject({
      tonic: "F",
      mode: "minor",
      bpm_min: 80,
      bpm_max: 90,
      has_drums: false,
      text_query: "dusty horns",
      parser: "rules",
    });
    expect(p.tags).toEqual(["dusty", "horns"]);
  });

  it("reads drums, loops and 'like this'", () => {
    expect(parseQuery("without drums")).toMatchObject({ has_drums: false, text_query: null });
    expect(parseQuery("drumless soul")).toMatchObject({ has_drums: false, text_query: "soul", tags: ["soul"] });
    expect(parseQuery("with drums")).toMatchObject({ has_drums: true });
    expect(parseQuery("a 4 bar loop")).toMatchObject({ is_loop_based: true, text_query: "4 bar" });
    expect(parseQuery("loop-based funk")).toMatchObject({ is_loop_based: true, text_query: "funk" });
    expect(parseQuery("more like this")).toMatchObject({ similar: true, text_query: null });
    expect(parseQuery("something similar to this one but slower")).toMatchObject({ similar: true, text_query: "slower" });
    expect(parseQuery("similar")).toMatchObject({ similar: true });
  });

  it("finds multi-word tags before their parts", () => {
    expect(findTags("a dusty drum break with vinyl crackle")).toEqual(["dusty", "drum break", "vinyl crackle"]);
    expect(parseQuery("drum break").tags).toEqual(["drum break"]);
  });

  it("expands typed words onto database tags", () => {
    expect(expandTags(["horns"])).toEqual(["brass", "trumpet", "saxophone"]);
    expect(expandTags(["dusty", "unknownword"])).toEqual(["dusty", "unknownword"]);
    expect(expandTags(["drum break"])).toEqual(["drum break"]);
  });

  it("returns the empty shape for an empty query", () => {
    expect(parseQuery("   ")).toEqual(emptyParsed());
  });

  it("describes the filters", () => {
    const p = parseQuery("Something dusty in F minor around 85 with horns, no drums");
    expect(describeParsed(p)).toEqual(["80–90 BPM", "F minor", "no drums", "tags dusty, horns", '"dusty horns"']);
  });
});
