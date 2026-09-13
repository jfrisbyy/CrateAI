// GET /api/usage — the caller's plan, limits, month/day usage, and what that
// usage has cost us to serve.
//
// Every number comes from `usage_events` through `usage_summary` (storage is
// summed from `files.size_bytes`), so this one response answers both "how much
// of my plan is left" and "what is this account costing". The cost is an
// estimate from list prices (lib/billing/cost.ts), not an invoice.

import { getUsage } from "@/lib/billing/usage";
import { handle, json, requireUser } from "@/lib/http";

export async function GET() {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    return json(await getUsage(supabase, user.id));
  });
}
