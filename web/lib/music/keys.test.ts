import { describe, expect, it } from "vitest";
import { displayKey, displayTonic, keyToken, normalizeTonic, otherSpelling, parseKeyText } from "./keys";

describe("displayKey", () => {
  it("uses the conventional spelling per mode", () => {
    expect(displayKey("F", "minor")).toBe("F minor");
    expect(displayKey("A#", "major")).toBe("Bb major");
    expect(displayKey("C#", "minor")).toBe("C# minor");
    expect(displayKey("C#", "major")).toBe("Db major");
    expect(displayKey("D#", "minor")).toBe("Eb minor");
    expect(displayKey("G#", "minor")).toBe("G# minor");
    expect(displayKey("G#", "major")).toBe("Ab major");
    expect(displayKey("F#", "major")).toBe("F# major");
    expect(displayKey("A#", "minor")).toBe("Bb minor");
  });

  it("passes naturals through", () => {
    expect(displayTonic("E", "major")).toBe("E");
  });
});

describe("otherSpelling", () => {
  it("returns the enharmonic that is not shown", () => {
    expect(otherSpelling("A#", "minor")).toBe("A# minor");
    expect(otherSpelling("C#", "minor")).toBe("Db minor");
    expect(otherSpelling("F", "minor")).toBeNull();
  });
});

describe("keyToken", () => {
  it("builds the export token", () => {
    expect(keyToken("F", "minor")).toBe("Fm");
    expect(keyToken("A#", "major")).toBe("Bb");
    expect(keyToken("C#", "minor")).toBe("C#m");
  });
});

describe("normalizeTonic", () => {
  it("maps any spelling to sharps", () => {
    expect(normalizeTonic("bb")).toBe("A#");
    expect(normalizeTonic("Bb")).toBe("A#");
    expect(normalizeTonic("Db")).toBe("C#");
    expect(normalizeTonic("e#")).toBe("F");
    expect(normalizeTonic("cb")).toBe("B");
    expect(normalizeTonic("f")).toBe("F");
    expect(normalizeTonic("F#")).toBe("F#");
    expect(normalizeTonic("g♭")).toBe("F#");
    expect(normalizeTonic("h")).toBeNull();
    expect(normalizeTonic("")).toBeNull();
  });
});

describe("parseKeyText", () => {
  it.each<[string, string, string]>([
    ["f minor", "F", "minor"],
    ["fm", "F", "minor"],
    ["F#m", "F#", "minor"],
    ["bb major", "A#", "major"],
    ["Bbmaj", "A#", "major"],
    ["Ebmin", "D#", "minor"],
    ["c# min", "C#", "minor"],
    ["something in a minor around 85", "A", "minor"],
    ["dusty rhodes gb-major", "F#", "major"],
  ])("parses %j", (text, tonic, mode) => {
    const parsed = parseKeyText(text);
    expect(parsed?.tonic).toBe(tonic);
    expect(parsed?.mode).toBe(mode);
  });

  it("does not treat bare note names or ordinary words as keys", () => {
    expect(parseKeyText("a")).toBeNull();
    expect(parseKeyText("bb")).toBeNull();
    expect(parseKeyText("drums")).toBeNull();
    expect(parseKeyText("firm")).toBeNull();
    expect(parseKeyText("85 bpm")).toBeNull();
  });
});
