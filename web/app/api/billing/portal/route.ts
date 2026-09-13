// POST /api/billing/portal — the Stripe Billing Portal for the caller's customer.

import { createPortalSession, stripeEnv } from "@/lib/billing/stripe";
import { getProfile } from "@/lib/billing/usage";
import { handle, HttpError, json, requireUser } from "@/lib/http";

export async function POST() {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    if (!stripeEnv().configured) throw new HttpError(503, "Billing is not configured yet.");
    const profile = await getProfile(supabase, user.id);
    if (!profile.stripe_customer_id) throw new HttpError(409, "No subscription yet. Upgrade first.");
    return json(await createPortalSession(profile.stripe_customer_id));
  });
}
