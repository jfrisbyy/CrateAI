// POST /api/billing/checkout — a Stripe Checkout session for the Pro plan.

import { createCheckoutSession, stripeEnv } from "@/lib/billing/stripe";
import { getProfile } from "@/lib/billing/usage";
import { handle, HttpError, json, requireUser } from "@/lib/http";

export async function POST() {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    if (!stripeEnv().configured) throw new HttpError(503, "Billing is not configured yet.");
    const profile = await getProfile(supabase, user.id);
    if (profile.plan === "pro" && profile.plan_status !== "canceled") {
      throw new HttpError(409, "You are already on Pro. Manage the subscription from the portal.");
    }
    const session = await createCheckoutSession({ userId: user.id, email: user.email ?? profile.email, customerId: profile.stripe_customer_id });
    return json({ url: session.url });
  });
}
