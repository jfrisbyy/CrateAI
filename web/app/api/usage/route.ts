// GET /api/usage — the caller's plan, limits, and month/day usage.

import { getUsage } from "@/lib/billing/usage";
import { handle, json, requireUser } from "@/lib/http";

export async function GET() {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    return json(await getUsage(supabase, user.id));
  });
}
