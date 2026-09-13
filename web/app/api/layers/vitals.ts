// What a lane needs to know about its file, from the file's effective report.
// Mirrors what analysis/lockedgroove/jobs/layer.py reads when it plans the
// alignment (tempo, key, first downbeat, and whether the material is tonal),
// so the tab can show the plan the compute will apply before it runs.

import type { LaneFileVitals } from "@/lib/api/layers";
import { effective } from "@/lib/report/effective";
import type { FileRow } from "@/lib/types/db";

/** align.py NON_TONAL_TAGS */
const NON_TONAL_TAGS = new Set(["drums", "drum", "break", "percussion", "hats", "kick", "snare", "beatbox"]);

export function laneVitals(file: FileRow): LaneFileVitals {
  const report = file.report ? effective(file.report) : null;
  const tags = new Set((report?.tags ?? []).map((t) => t.tag.toLowerCase()));
  const drumsStem = file.kind === "stem" && file.original_filename.toLowerCase().includes("drums");
  let tonal = true;
  if (drumsStem) tonal = false;
  for (const t of tags) if (NON_TONAL_TAGS.has(t)) tonal = false;
  return {
    file_id: file.id,
    name: file.title?.trim() || file.original_filename,
    kind: file.kind,
    status: file.status,
    duration_s: file.duration_s ?? report?.file.duration_s ?? null,
    bpm: report?.tempo?.bpm ?? null,
    bpm_confidence: report?.tempo?.confidence ?? null,
    key: report?.key ? { tonic: report.key.tonic, mode: report.key.mode } : null,
    key_confidence: report?.key?.confidence ?? null,
    first_downbeat_s: report?.beats?.downbeats_s[0] ?? null,
    tonal,
  };
}
