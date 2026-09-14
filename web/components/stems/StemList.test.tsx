// What a producer is told about the separation that made their stems.
//
// Separation is the irreversible step, so a stem that came from a soft
// separator has to say so where it cannot be missed. Before this, the header
// showed a bare model id and the tier the backend already knew was never shown
// at all.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { qualityOf, stemQualityColumns, type StemWithFile } from "@/lib/api/stems";
import type { StemRow } from "@/lib/types/db";
import { groupStems, SeparationHeader } from "./StemList";

const stemRow = (model: string, stem: string, createdAt = "2026-09-15T12:00:00.000Z", extra: Partial<StemRow> = {}): StemWithFile => ({
  id: `${model}-${stem}`,
  user_id: "u",
  file_id: "f",
  stem,
  model,
  stem_file_id: `sf-${model}-${stem}`,
  ...stemQualityColumns(model),
  created_at: createdAt,
  file: null,
  ...extra,
});

const header = (model: string, extra: Partial<StemRow> = {}) =>
  renderToStaticMarkup(<SeparationHeader model={model} quality={qualityOf(stemRow(model, "drums", undefined, extra))} stems={4} />);

describe("the separation header", () => {
  it("leads with the tier, not with an identifier a producer cannot evaluate", () => {
    const html = header("bs_roformer");
    expect(html).toContain("reference");
    expect(html).toContain("the source&#x27;s top end survives it");
  });

  it("shows a published SDR only alongside what the number is", () => {
    const html = header("bs_roformer");
    expect(html).toContain("12.98 dB SDR");
    expect(html).toContain("vocals SDR published by the checkpoint&#x27;s author");
  });

  it("shows no SDR at all for a model whose author published none", () => {
    const html = header("htdemucs_6s");
    expect(html).not.toContain("dB SDR");
    expect(html).toContain("strong");
  });

  it("says out loud that a weak separator lost something unrecoverable", () => {
    const html = header("kuielab_other");
    expect(html).toContain("weak");
    expect(html).toContain("cannot be recovered downstream");
  });

  it("marks a stand-in as not a separation at all", () => {
    const html = header("htdemucs_ft-fake");
    expect(html).toContain("stand in");
    expect(html).toContain("not a separation model");
  });

  it("says a row from before the quality columns is unknown, never fine", () => {
    const html = header("htdemucs_ft", { model_tier: null, quality_note: null });
    expect(html).toContain("unknown");
  });

  it("still names the model, for someone who wants it", () => {
    expect(header("htdemucs_ft")).toContain("htdemucs_ft");
  });
});

describe("groupStems", () => {
  it("groups by the separation that made them, newest first", () => {
    const groups = groupStems([
      stemRow("htdemucs_ft", "drums", "2026-09-15T10:00:00.000Z"),
      stemRow("htdemucs_ft", "bass", "2026-09-15T10:00:00.000Z"),
      stemRow("bs_roformer", "vocals", "2026-09-15T11:00:00.000Z"),
    ]);
    expect(groups.map((g) => g.model)).toEqual(["bs_roformer", "htdemucs_ft"]);
    expect(groups[1]?.stems.map((s) => s.stem)).toEqual(["drums", "bass"]);
  });

  it("carries each group's quality, so two separations of one file read differently", () => {
    const groups = groupStems([stemRow("bs_roformer", "vocals"), stemRow("kuielab_other", "other")]);
    expect(groups.map((g) => g.quality.tier).sort()).toEqual(["reference", "weak"]);
    expect(groups.find((g) => g.model === "kuielab_other")?.quality.untrusted).toBe(true);
    expect(groups.find((g) => g.model === "bs_roformer")?.quality.untrusted).toBe(false);
  });
});
