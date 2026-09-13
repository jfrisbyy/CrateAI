import { describe, expect, it } from "vitest";
import { basenameOf, bundleFilename, planBundle, safeFilename, uniqueNames } from "./manifest";

describe("planBundle", () => {
  const file = { id: "f1", name: "Soul Sample #2.wav", bpm: 88, key: { tonic: "A#", mode: "major" } };

  it("lists every chop WAV and .mid under chops/ and midi/ with the manifest shape", () => {
    const plan = planBundle(
      file,
      [
        { index: 1, name: null, start_s: 1, end_s: 2, file: { original_filename: "Soul-Sample-#2_chop02.wav", storage_path: "derived/u/f1/chops/001.wav" } },
        { index: 0, name: "kick", start_s: 0, end_s: 1, file: { original_filename: "Soul-Sample-#2_chop01.wav", storage_path: "derived/u/f1/chops/000.wav" } },
        { index: 2, name: "gone", start_s: 2, end_s: 3, file: null },
      ],
      [
        { kind: "drums", storage_path: "derived/u/f1/midi/drums.mid" },
        { kind: "drums", storage_path: "derived/u/f1/midi/pads-1757721600000.mid" },
      ],
      "2026-09-13T00:00:00.000Z",
    );
    expect(plan.manifest).toEqual({
      file,
      chops: [
        { index: 0, name: "kick", filename: "chops/Soul-Sample-#2_chop01.wav", start_s: 0, end_s: 1 },
        { index: 1, name: "chop 2", filename: "chops/Soul-Sample-#2_chop02.wav", start_s: 1, end_s: 2 },
      ],
      midi: [
        { kind: "drums", filename: "midi/drums.mid" },
        { kind: "drums", filename: "midi/pads-1757721600000.mid" },
      ],
      generated_at: "2026-09-13T00:00:00.000Z",
    });
    expect(plan.entries).toEqual([
      { zip_path: "chops/Soul-Sample-#2_chop01.wav", storage_path: "derived/u/f1/chops/000.wav" },
      { zip_path: "chops/Soul-Sample-#2_chop02.wav", storage_path: "derived/u/f1/chops/001.wav" },
      { zip_path: "midi/drums.mid", storage_path: "derived/u/f1/midi/drums.mid" },
      { zip_path: "midi/pads-1757721600000.mid", storage_path: "derived/u/f1/midi/pads-1757721600000.mid" },
    ]);
    expect(plan.skipped_chops).toEqual([2]);
  });

  it("keeps duplicate filenames apart", () => {
    const plan = planBundle(
      file,
      [0, 1, 2].map((i) => ({ index: i, name: null, start_s: i, end_s: i + 1, file: { original_filename: "same.wav", storage_path: `p/${i}` } })),
      [],
      "now",
    );
    expect(plan.manifest.chops.map((c) => c.filename)).toEqual(["chops/same.wav", "chops/same-2.wav", "chops/same-3.wav"]);
  });
});

describe("names", () => {
  it("sanitizes and dedupes", () => {
    expect(safeFilename("a b/c?.wav")).toBe("c-.wav");
    expect(safeFilename("///", "x")).toBe("x");
    expect(uniqueNames(["a.mid", "a.mid", "b", "b", "a.mid"])).toEqual(["a.mid", "a-2.mid", "b", "b-2", "a-3.mid"]);
    expect(basenameOf("derived/u/f/midi/drums.mid")).toBe("drums.mid");
    expect(bundleFilename("My Beat (final).aiff")).toBe("My-Beat-final_kit.zip");
    expect(bundleFilename("noext")).toBe("noext_kit.zip");
  });
});
