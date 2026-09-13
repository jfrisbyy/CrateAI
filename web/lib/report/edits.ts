// Applying a user edit to a stored report (POST /api/files/[id]/edits).
//
// The edit lands in `report.user_edits`; the analyzed values are never
// overwritten, so `effective()` can resolve them and the corrections table
// can log prediction vs. correction (principle 7).

import { z } from "zod";
import { PITCH_CLASSES } from "@/lib/music/keys";
import type { Json } from "@/lib/types/db";
import type { AnalysisReport, UserEdits } from "@/lib/types/report";

export const EDIT_FIELDS = ["tempo_bpm", "downbeat_phase", "first_downbeat_s", "key", "meter", "section_labels"] as const;
export type EditField = (typeof EDIT_FIELDS)[number];

export const METERS = ["4/4", "3/4", "6/8", "5/4", "7/8"] as const;

const keySchema = z.object({ tonic: z.enum(PITCH_CLASSES), mode: z.enum(["major", "minor"]) });

export const EDIT_VALUE_SCHEMAS = {
  tempo_bpm: z.number().positive().max(999),
  downbeat_phase: z.number().int().min(0).max(15),
  first_downbeat_s: z.number().min(0),
  key: keySchema,
  meter: z.string().regex(/^\d{1,2}\/\d{1,2}$/, "meter must look like 4/4"),
  section_labels: z.record(z.string().regex(/^\d+$/), z.string().trim().min(1).max(64)),
} as const;

export const editRequestSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("tempo_bpm"), value: EDIT_VALUE_SCHEMAS.tempo_bpm }),
  z.object({ field: z.literal("downbeat_phase"), value: EDIT_VALUE_SCHEMAS.downbeat_phase }),
  z.object({ field: z.literal("first_downbeat_s"), value: EDIT_VALUE_SCHEMAS.first_downbeat_s }),
  z.object({ field: z.literal("key"), value: EDIT_VALUE_SCHEMAS.key }),
  z.object({ field: z.literal("meter"), value: EDIT_VALUE_SCHEMAS.meter }),
  z.object({ field: z.literal("section_labels"), value: EDIT_VALUE_SCHEMAS.section_labels }),
]);

export type EditRequest = z.infer<typeof editRequestSchema>;

/** The analyzed value the edit replaces, for the corrections row. */
export function predictedFor(report: AnalysisReport, edit: EditRequest): Json {
  switch (edit.field) {
    case "tempo_bpm":
      return report.tempo?.bpm ?? null;
    case "downbeat_phase":
      return report.beats?.downbeat_phase ?? null;
    case "first_downbeat_s":
      return report.beats?.downbeats_s[0] ?? null;
    case "key":
      return report.key ? { tonic: report.key.tonic, mode: report.key.mode } : null;
    case "meter":
      return report.beats?.meter ?? null;
    case "section_labels": {
      const out: Record<string, Json> = {};
      for (const idx of Object.keys(edit.value)) {
        out[idx] = report.structure?.sections[Number(idx)]?.label ?? null;
      }
      return out;
    }
  }
}

/** A new report with the edit merged into `user_edits` (the input is not mutated). */
export function applyEdit(report: AnalysisReport, edit: EditRequest, editedAt: string): AnalysisReport {
  const current: UserEdits = report.user_edits ?? {
    tempo_bpm: null,
    downbeat_phase: null,
    first_downbeat_s: null,
    key: null,
    meter: null,
    section_labels: null,
    edited_at: null,
  };
  const next: UserEdits = { ...current, edited_at: editedAt };
  switch (edit.field) {
    case "tempo_bpm":
      next.tempo_bpm = edit.value;
      break;
    case "downbeat_phase":
      next.downbeat_phase = edit.value;
      // a phase edit replaces any earlier click anchor
      next.first_downbeat_s = null;
      break;
    case "first_downbeat_s":
      next.first_downbeat_s = edit.value;
      next.downbeat_phase = null;
      break;
    case "key":
      next.key = { tonic: edit.value.tonic, mode: edit.value.mode };
      break;
    case "meter":
      next.meter = edit.value;
      break;
    case "section_labels":
      next.section_labels = { ...(current.section_labels ?? {}), ...edit.value };
      break;
  }
  return { ...report, user_edits: next };
}
