// GET /api/profile — the caller's profile row.
// PATCH /api/profile { corrections_opt_in } — the only field a user edits directly.

import { z } from "zod";
import { getProfile } from "@/lib/billing/usage";
import { dbError, handle, json, parseBody, requireUser } from "@/lib/http";

const patchSchema = z.object({ corrections_opt_in: z.boolean() });

export async function GET() {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    return json({ profile: await getProfile(supabase, user.id) });
  });
}

export async function PATCH(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, patchSchema);
    const { data, error } = await supabase.from("profiles").update(body).eq("id", user.id).select("*").single();
    if (error) throw dbError(error, "profile");
    return json({ profile: data });
  });
}
