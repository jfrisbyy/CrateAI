// Applying a user edit to a stored report (POST /api/files/[id]/edits), and
// the three loop corrections the ranker reads back (lib/report/loopCorrections.ts).
//
// The edit lands in `report.user_edits`; the analyzed values are never
// overwritten, so `effective()` can resolve them and the corrections table
// can log prediction vs. correction (principle 7).

import { z } from "zod";
import { PITCH_CLASSES } from "@/lib/music/keys";
import type { Json, LoopRow } from "@/lib/types/db";
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

// ---------------------------------------------------------------------------
// loop corrections (principle 7): the three `corrections.field` values the loop
// ranker reads back (analysis/lockedgroove/learn/loop_prefs.py)
// ---------------------------------------------------------------------------
//
// The payload shapes are pinned by `comment on column corrections.field` in
// supabase/migrations/20260913001200_loop_ranking_personalization.sql. They are
// written here exactly as that comment says, and not one key wider: the reader
// treats an unknown key as data, and a variant nobody agreed on is how a
// learner starts training on something the writer never meant.
//
// These functions decide what *counts*. A row that is not evidence of anything
// is not a cheap row: the ranker would learn from it and the accuracy harness
// reads the same table, so noise costs twice. Each returns `null` for "the
// producer did not correct anything", and the caller writes nothing.

export const LOOP_CORRECTION_FIELDS = ["loop_edges", "loop_bars", "loop_pick"] as const;
export type LoopCorrectionField = (typeof LOOP_CORRECTION_FIELDS)[number];

/** The finder's scored terms. A `loop_pick` row carries these and nothing else. */
export const SCORED_TERMS = ["seam", "phrase", "stability", "novelty", "onset_lock", "recurrence"] as const;

/**
 * Below this, an edge did not move: one millisecond is under a pixel at any
 * zoom a producer drags at, and a drag that ends where it started is not a
 * correction — it is a click.
 */
export const LOOP_EDGE_EPSILON_S = 1e-3;

/** Which control the producer used. The server cannot tell a dragged span from a set bar count. */
export type LoopEditVia = "edges" | "bars";

export interface LoopSpan {
  start_s: number;
  end_s: number;
  bars: number | null;
}

/** One row of the rack, as a `loop_pick` payload sees it. */
export interface RankedLoop {
  bars: number | null;
  rank: number;
  components: Json | null;
}

export interface LoopCorrection {
  field: LoopCorrectionField;
  predicted: Json;
  corrected: Json;
}

/** `{start_s, end_s, bars?}` — `bars` only when there is one; never guessed. */
export function loopSpanPayload(span: LoopSpan): Json {
  const out: Record<string, Json> = { start_s: round(span.start_s), end_s: round(span.end_s) };
  if (span.bars !== null && Number.isFinite(span.bars)) out.bars = span.bars;
  return out;
}

/** The finder's scored terms out of a loop's components, or null when it carries none. */
export function scoredTermsOf(components: Json | null): Json | null {
  if (!components || typeof components !== "object" || Array.isArray(components)) return null;
  const source = components as Record<string, Json>;
  const out: Record<string, Json> = {};
  for (const term of SCORED_TERMS) {
    const value = source[term];
    if (typeof value === "number" && Number.isFinite(value)) out[term] = round(value);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** `{bars, rank, components?}` for one row of the rack. */
export function rankedLoopPayload(loop: RankedLoop): Json {
  const out: Record<string, Json> = { bars: loop.bars, rank: loop.rank };
  const terms = scoredTermsOf(loop.components);
  if (terms) out.components = terms;
  return out;
}

/**
 * A `loop_edges` or `loop_bars` correction, or null when nothing was corrected.
 *
 * `via` says which control was used, because the payloads cannot tell them
 * apart: dragging an edge changes the bar count as a consequence, and setting
 * the bar count moves an edge as a consequence. What the producer *said* is the
 * difference, and only the client knows it.
 */
export function loopSpanCorrection(before: LoopSpan, after: LoopSpan, via: LoopEditVia): LoopCorrection | null {
  if (via === "bars") {
    // "make this four bars": the count is the statement and the edge follows it
    if (after.bars === null || after.bars === before.bars) return null;
    return { field: "loop_bars", predicted: loopSpanPayload(before), corrected: loopSpanPayload(after) };
  }
  const moved =
    Math.abs(after.start_s - before.start_s) > LOOP_EDGE_EPSILON_S ||
    Math.abs(after.end_s - before.end_s) > LOOP_EDGE_EPSILON_S;
  if (!moved) return null;
  return { field: "loop_edges", predicted: loopSpanPayload(before), corrected: loopSpanPayload(after) };
}

/**
 * A `loop_pick` correction: the producer took a candidate we did not put first.
 *
 * Null when they took the top row — that is agreement, and a table full of
 * "you were right" teaches the ranker nothing while costing the harness a row
 * every time anyone exports anything.
 */
export function loopPickCorrection(top: RankedLoop, chosen: RankedLoop): LoopCorrection | null {
  if (top.rank !== 1 || chosen.rank <= 1) return null;
  return { field: "loop_pick", predicted: rankedLoopPayload(top), corrected: rankedLoopPayload(chosen) };
}

/**
 * Whether a stored `loop_edges` / `loop_bars` payload ends exactly where this
 * edit begins — that is, whether the producer is still moving the same loop.
 *
 * Eight taps of the nudge key are one correction, not eight: the row is
 * supposed to say "the offered span and the kept one", and a chain of
 * intermediate spans says neither. The caller extends the first row instead of
 * writing another, so the offer stays the finder's and the correction stays
 * wherever the producer stopped.
 */
export function continuesEdit(storedCorrected: Json | null, next: Json): boolean {
  const a = storedCorrected as { start_s?: unknown; end_s?: unknown } | null;
  const b = next as { start_s?: unknown; end_s?: unknown };
  if (!a || typeof a !== "object" || Array.isArray(a)) return false;
  if (typeof a.start_s !== "number" || typeof a.end_s !== "number") return false;
  if (typeof b.start_s !== "number" || typeof b.end_s !== "number") return false;
  return Math.abs(a.start_s - b.start_s) <= LOOP_EDGE_EPSILON_S && Math.abs(a.end_s - b.end_s) <= LOOP_EDGE_EPSILON_S;
}

/**
 * The rack's order, which is the order `GET /api/loops` returns and the order a
 * rank in a `loop_pick` row means: best score first, nulls last, ties by time.
 */
export function compareRank(a: Pick<LoopRow, "score" | "start_s">, b: Pick<LoopRow, "score" | "start_s">): number {
  const sa = a.score ?? Number.NEGATIVE_INFINITY;
  const sb = b.score ?? Number.NEGATIVE_INFINITY;
  if (sa !== sb) return sb - sa;
  return a.start_s - b.start_s;
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}
