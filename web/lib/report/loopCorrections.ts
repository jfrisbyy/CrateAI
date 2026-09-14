// Writing the three loop corrections a producer makes without being asked to
// (principle 7), so the ranker can read them back per account.
//
// `lib/report/edits.ts` decides the payloads and what counts; this decides when,
// and is the only place that touches the table for loops. Three rules hold here
// rather than in each route:
//
//   * a correction is a footnote to an act that already happened. The loop edit
//     or the export has landed by the time these run, so a failure to write the
//     footnote is logged and swallowed — rolling the producer's edit back
//     because bookkeeping failed would be a worse lie than a missing row.
//   * the account is the caller and only the caller. Every read filters by
//     `user_id` as well as relying on RLS, and the row is written with the
//     caller's id: the ranker reads one account and this is the writer's half
//     of that promise.
//   * nothing is written for an act that corrected nothing. `null` in, nothing
//     written, and the route says so in its response.

import {
  compareRank,
  continuesEdit,
  loopPickCorrection,
  loopSpanCorrection,
  type LoopCorrection,
  type LoopEditVia,
  type LoopSpan,
} from "./edits";
import type { ServerSupabase } from "@/lib/supabase/server";
import type { CorrectionRow, LoopRow } from "@/lib/types/db";

/** Loops the finder ranked, in the order it ranked them. A rank means nothing without this. */
type RackRow = Pick<LoopRow, "id" | "score" | "start_s" | "bars" | "components">;

export type PickSkipped = "not_from_the_finder" | "the_only_candidate" | "ranked_first" | "already_recorded";

export interface PickResult {
  correction: CorrectionRow | null;
  /** why nothing was written, for the route's response and for a test to assert on */
  skipped: PickSkipped | null;
}

/** Insert one correction row for the caller. Never throws: see the note at the top. */
export async function writeCorrection(
  supabase: ServerSupabase,
  userId: string,
  fileId: string,
  correction: LoopCorrection,
): Promise<CorrectionRow | null> {
  const { data, error } = await supabase
    .from("corrections")
    .insert({ user_id: userId, file_id: fileId, field: correction.field, predicted: correction.predicted, corrected: correction.corrected })
    .select("*")
    .single();
  if (error) {
    console.warn("[corrections] could not log", correction.field, error.message);
    return null;
  }
  return data;
}

/**
 * `loop_edges` or `loop_bars` for a loop the system offered and the producer changed.
 *
 * Only for a span we proposed: `finder` ranked it, `chat` answered a sentence
 * with it. A loop of origin `user` was drawn by the producer at their own
 * cursor, so there is no prediction to correct and a row would tell the ranker
 * that the app's own four-bar default was wrong — which it was not, it was
 * never a claim.
 */
export async function recordLoopSpanCorrection(
  supabase: ServerSupabase,
  userId: string,
  before: LoopRow,
  after: LoopSpan,
  via: LoopEditVia,
): Promise<CorrectionRow | null> {
  if (before.origin !== "finder" && before.origin !== "chat") return null;
  const correction = loopSpanCorrection({ start_s: before.start_s, end_s: before.end_s, bars: before.bars }, after, via);
  if (!correction) return null;

  // Still moving the same loop: extend the row already written rather than
  // adding one per keypress. Eight taps of the nudge key are one correction.
  const open = await lastSpanCorrection(supabase, userId, before.file_id, correction.field);
  if (open && continuesEdit(open.corrected, correction.predicted)) {
    const { data, error } = await supabase
      .from("corrections")
      .update({ corrected: correction.corrected })
      .eq("id", open.id)
      .select("*")
      .single();
    if (error) {
      console.warn("[corrections] could not extend", correction.field, error.message);
      return null;
    }
    return data;
  }
  return writeCorrection(supabase, userId, before.file_id, correction);
}

/** The newest span correction of this kind on this file, for the caller. */
async function lastSpanCorrection(
  supabase: ServerSupabase,
  userId: string,
  fileId: string,
  field: LoopCorrection["field"],
): Promise<CorrectionRow | null> {
  const { data, error } = await supabase
    .from("corrections")
    .select("*")
    .eq("user_id", userId)
    .eq("file_id", fileId)
    .eq("field", field)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data?.length) return null;
  return data[0];
}

/**
 * `loop_pick` for a candidate the producer committed to that we did not put first.
 *
 * The rank is computed here from the rack as it stands, never taken from the
 * client: a rank is a claim about our own ordering and we are the ones who know
 * it. What does not count, in the order it is checked:
 *
 *   * a loop the finder never ranked — nothing was predicted;
 *   * the only candidate on the file — being the sole option is not a preference;
 *   * the row already ranked first — that is agreement, and logging it would
 *     put a row in the table every time anyone exported anything;
 *   * the same row picked again — re-exporting a loop is one choice, not two.
 */
export async function recordLoopPick(supabase: ServerSupabase, userId: string, loop: LoopRow): Promise<PickResult> {
  if (loop.origin !== "finder") return { correction: null, skipped: "not_from_the_finder" };

  const { data, error } = await supabase
    .from("loops")
    .select("id, score, start_s, bars, components")
    .eq("file_id", loop.file_id)
    .eq("user_id", userId)
    .eq("origin", "finder");
  if (error) {
    console.warn("[corrections] could not read the rack to rank a pick", error.message);
    return { correction: null, skipped: null };
  }

  const rack = ([...(data ?? [])] as RackRow[]).sort(compareRank);
  if (rack.length < 2) return { correction: null, skipped: "the_only_candidate" };
  const index = rack.findIndex((r) => r.id === loop.id);
  if (index < 0) return { correction: null, skipped: "not_from_the_finder" };

  const top = rack[0];
  const chosen = rack[index];
  const correction = loopPickCorrection(
    { bars: top.bars, rank: 1, components: top.components },
    { bars: chosen.bars, rank: index + 1, components: chosen.components },
  );
  if (!correction) return { correction: null, skipped: "ranked_first" };

  if (await alreadyRecorded(supabase, userId, loop.file_id, index + 1, chosen.bars)) {
    return { correction: null, skipped: "already_recorded" };
  }
  return { correction: await writeCorrection(supabase, userId, loop.file_id, correction), skipped: null };
}

/**
 * Whether the last pick logged for this file is this same row.
 *
 * Rank and bar count identify a row inside one rack, which is as much identity
 * as the pinned payload carries. It costs a genuine second pick only when the
 * finder has re-run and the producer takes a row at the same rank with the same
 * length and has picked nothing else on that file in between — rare, and the
 * direction to be wrong in is the one with fewer rows.
 */
async function alreadyRecorded(
  supabase: ServerSupabase,
  userId: string,
  fileId: string,
  rank: number,
  bars: number | null,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("corrections")
    .select("corrected")
    .eq("user_id", userId)
    .eq("file_id", fileId)
    .eq("field", "loop_pick")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !data?.length) return false;
  const last = data[0].corrected;
  if (!last || typeof last !== "object" || Array.isArray(last)) return false;
  const row = last as Record<string, unknown>;
  return row.rank === rank && (row.bars ?? null) === bars;
}
