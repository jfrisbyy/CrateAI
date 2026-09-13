// POST /api/billing/webhook — Stripe events. Verified with STRIPE_WEBHOOK_SECRET,
// applied to profiles with the service role. Idempotent: the same event twice
// writes the same row.

import { NextResponse } from "next/server";
import { stripeEnv, subscriptionPatch, verifyWebhookSignature, type StripeEvent } from "@/lib/billing/stripe";
import { tryAdminClient } from "@/lib/supabase/admin";

export async function POST(req: Request) {
  const env = stripeEnv();
  if (!env.webhook) return NextResponse.json({ error: "STRIPE_WEBHOOK_SECRET is not set" }, { status: 503 });
  const payload = await req.text();
  if (!verifyWebhookSignature(payload, req.headers.get("stripe-signature"), env.webhook)) {
    return NextResponse.json({ error: "bad signature" }, { status: 400 });
  }
  let event: StripeEvent;
  try {
    event = JSON.parse(payload) as StripeEvent;
  } catch {
    return NextResponse.json({ error: "bad payload" }, { status: 400 });
  }
  const patch = subscriptionPatch(event);
  if (!patch) return NextResponse.json({ received: true, ignored: event.type });

  // Writing a plan needs the service role (a user's own policy freezes
  // profiles.plan). Missing configuration is 503, like the missing webhook
  // secret above, not an exception Stripe would see as a 500.
  const admin = tryAdminClient();
  if (!admin) return NextResponse.json({ error: "SUPABASE_SERVICE_ROLE_KEY is not set" }, { status: 503 });
  let userId = patch.user_id;
  if (!userId && patch.customer_id) {
    const { data } = await admin.from("profiles").select("id").eq("stripe_customer_id", patch.customer_id).maybeSingle();
    userId = data?.id ?? null;
  }
  if (!userId) {
    console.warn("[billing] event without a user", event.type, event.id);
    return NextResponse.json({ received: true, unmatched: true });
  }
  const { error } = await admin.from("profiles").update({
    plan: patch.plan,
    plan_status: patch.plan_status,
    stripe_customer_id: patch.customer_id ?? undefined,
    stripe_subscription_id: patch.subscription_id ?? undefined,
  }).eq("id", userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ received: true });
}
