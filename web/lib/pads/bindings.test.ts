import { describe, expect, it } from "vitest";
import type { ChopWithFile } from "@/lib/api/chops";
import { stemQualityColumns, type StemWithFile } from "@/lib/api/stems";
import { bindPads, EMPTY_BINDINGS } from "./bindings";

function chop(index: number, fileId: string | null, name: string | null = null): ChopWithFile {
  return {
    id: `chop-${index}`,
    user_id: "u",
    source_file_id: "src",
    start_s: index,
    end_s: index + 1,
    index,
    name,
    chop_file_id: fileId,
    created_at: "2026-09-13T00:00:00Z",
    file: null,
  };
}

function stem(model: string, name: string, createdAt: string): StemWithFile {
  return {
    id: `${model}-${name}`,
    user_id: "u",
    file_id: "src",
    stem: name,
    model,
    stem_file_id: `file-${model}-${name}`,
    ...stemQualityColumns(model),
    created_at: createdAt,
    file: null,
  };
}

describe("bindPads", () => {
  it("binds chops by index, first sixteen, skipping chops without a file", () => {
    const chops = [chop(2, "f2", "snare"), chop(0, "f0"), chop(1, null), ...Array.from({ length: 20 }, (_, i) => chop(i + 3, `f${i + 3}`))];
    const pads = bindPads(chops, [stem("htdemucs_ft", "drums", "2026-01-01")]);
    expect(pads).toHaveLength(16);
    expect(pads[0]).toMatchObject({ pad: 1, source: "chop", file_id: "f0", label: "chop 1", chop_id: "chop-0" });
    expect(pads[1]).toMatchObject({ pad: 2, file_id: "f2", label: "snare", detail: "3" });
    expect(pads[15]).toMatchObject({ pad: 16, file_id: "f16" });
    expect(pads.every((p) => p?.source === "chop")).toBe(true);
  });

  it("falls back to stems, newest model first, in the canonical stem order", () => {
    const stems = [
      stem("htdemucs_ft", "other", "2026-01-01T00:00:00Z"),
      stem("htdemucs_ft", "drums", "2026-01-01T00:00:00Z"),
      stem("bs_roformer", "instrumental", "2026-02-01T00:00:00Z"),
      stem("bs_roformer", "vocals", "2026-02-01T00:00:00Z"),
      stem("htdemucs_ft", "bass", "2026-01-01T00:00:00Z"),
      stem("htdemucs_ft", "vocals", "2026-01-01T00:00:00Z"),
    ];
    const pads = bindPads([chop(0, null)], stems);
    expect(pads.slice(0, 6).map((p) => `${p?.detail}/${p?.label}`)).toEqual([
      "bs_roformer/vocals",
      "bs_roformer/instrumental",
      "htdemucs_ft/drums",
      "htdemucs_ft/bass",
      "htdemucs_ft/vocals",
      "htdemucs_ft/other",
    ]);
    expect(pads[6]).toBeNull();
    expect(pads[0]?.file_id).toBe("file-bs_roformer-vocals");
  });

  it("is empty with nothing to bind", () => {
    expect(bindPads([], [])).toEqual(EMPTY_BINDINGS);
  });
});
