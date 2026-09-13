// GET /api/beatbox/profile — the caller's beatbox_profiles row (one per user) or null.

import type { ProfileResponse } from "@/lib/api/beatbox";
import { dbError, handle, json, requireUser } from "@/lib/http";

export async function GET() {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const { data, error } = await supabase.from("beatbox_profiles").select("*").eq("user_id", user.id).maybeSingle();
    if (error) throw dbError(error, "Loading the beatbox profile");
    const response: ProfileResponse = { profile: data ?? null };
    return json(response, { headers: { "cache-control": "private, no-store" } });
  });
}
