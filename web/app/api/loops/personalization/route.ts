// GET /api/loops/personalization — whether this account's own loop corrections
// adjust its loop ranking. PATCH { enabled } — turn it off, or back on.
//
// A ranking that quietly changed is worse than one that did not change at all,
// so the switch is part of the feature rather than a setting somewhere else:
// the loops tab shows what a producer's corrections did to their rack and this
// is how they refuse it. Off means the measured ranking alone, which is exactly
// what a new account gets.
//
// The column lives in supabase/migrations/20260913001200_loop_ranking_personalization.sql,
// which is written and not yet applied. Until it is, GET says `available: false`
// and the ranking runs on (the default the column carries), and PATCH says so
// plainly instead of pretending to have saved something.

import { z } from "zod";
import type { LoopPersonalizationResponse } from "@/lib/api/types";
import { dbError, handle, HttpError, json, parseBody, requireUser } from "@/lib/http";

/** Missing column: the migration has not been applied to this database yet. */
const UNDEFINED_COLUMN = "42703";

export async function GET() {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const { data, error } = await supabase.from("profiles").select("*").eq("id", user.id).maybeSingle();
    if (error) throw dbError(error, "Loading the profile");
    const value = (data as { loop_personalization?: boolean | null } | null)?.loop_personalization;
    const response: LoopPersonalizationResponse =
      value === undefined ? { enabled: true, available: false } : { enabled: value !== false, available: true };
    return json(response);
  });
}

const patchSchema = z.object({ enabled: z.boolean() });

export async function PATCH(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const { enabled } = await parseBody(req, patchSchema);

    const { data, error } = await supabase
      .from("profiles")
      .update({ loop_personalization: enabled })
      .eq("id", user.id)
      .select("*")
      .maybeSingle();
    if (error?.code === UNDEFINED_COLUMN) {
      throw new HttpError(503, "Personal loop ranking cannot be switched yet: this database is missing the column it lives in.");
    }
    if (error) throw dbError(error, "Saving the switch");
    if (!data) throw new HttpError(404, "No profile for this account yet.");

    const value = (data as { loop_personalization?: boolean | null }).loop_personalization;
    const response: LoopPersonalizationResponse = { enabled: value !== false, available: true };
    return json(response);
  });
}
