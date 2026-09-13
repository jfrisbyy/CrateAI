// A dependency-free Stripe client: Checkout, the Billing Portal, and webhook
// signature verification. Server only. Env: STRIPE_SECRET_KEY,
// STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_ID (the Pro price), NEXT_PUBLIC_APP_URL.

import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://api.stripe.com/v1";

export function stripeEnv() {
  const secret = process.env.STRIPE_SECRET_KEY;
  const webhook = process.env.STRIPE_WEBHOOK_SECRET;
  const price = process.env.STRIPE_PRICE_ID;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  return { secret, webhook, price, appUrl, configured: Boolean(secret && price) };
}

function form(params: Record<string, string | number | boolean | undefined>): string {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) body.set(k, String(v));
  }
  return body.toString();
}

async function stripePost<T>(path: string, params: Record<string, string | number | boolean | undefined>, secret: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${secret}:`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form(params),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok || !body) {
    throw new Error(`Stripe ${path} failed: ${body?.error?.message ?? res.status}`);
  }
  return body;
}

export async function createCheckoutSession(input: {
  userId: string;
  email: string | null;
  customerId: string | null;
}): Promise<{ url: string }> {
  const env = stripeEnv();
  if (!env.secret || !env.price) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY, STRIPE_PRICE_ID).");
  const session = await stripePost<{ url: string }>("/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": env.price,
    "line_items[0][quantity]": 1,
    success_url: `${env.appUrl}/account?checkout=success`,
    cancel_url: `${env.appUrl}/account?checkout=canceled`,
    client_reference_id: input.userId,
    "metadata[user_id]": input.userId,
    "subscription_data[metadata][user_id]": input.userId,
    customer: input.customerId ?? undefined,
    customer_email: input.customerId ? undefined : input.email ?? undefined,
    allow_promotion_codes: true,
  }, env.secret);
  return { url: session.url };
}

export async function createPortalSession(customerId: string): Promise<{ url: string }> {
  const env = stripeEnv();
  if (!env.secret) throw new Error("Stripe is not configured (STRIPE_SECRET_KEY).");
  const session = await stripePost<{ url: string }>("/billing_portal/sessions", {
    customer: customerId,
    return_url: `${env.appUrl}/account`,
  }, env.secret);
  return { url: session.url };
}

/** Stripe-Signature: t=<ts>,v1=<hex>[,v1=<hex>]. HMAC-SHA256 over `${t}.${payload}`. */
export function verifyWebhookSignature(payload: string, header: string | null, secret: string, toleranceSec = 300,
                                       now = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!t || sigs.length === 0) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  const exp = Buffer.from(expected);
  return sigs.some((s) => {
    const got = Buffer.from(s);
    return got.length === exp.length && timingSafeEqual(got, exp);
  });
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/** What a subscription event means for the profile row. */
export function subscriptionPatch(event: StripeEvent): {
  user_id: string | null;
  customer_id: string | null;
  subscription_id: string | null;
  plan: "free" | "pro";
  plan_status: "active" | "past_due" | "canceled" | "trialing";
} | null {
  const obj = event.data.object;
  const metadata = (obj.metadata as Record<string, string> | undefined) ?? {};
  const customer = typeof obj.customer === "string" ? obj.customer : null;
  if (event.type === "checkout.session.completed") {
    return {
      user_id: (obj.client_reference_id as string | undefined) ?? metadata.user_id ?? null,
      customer_id: customer,
      subscription_id: typeof obj.subscription === "string" ? obj.subscription : null,
      plan: "pro",
      plan_status: "active",
    };
  }
  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.created") {
    const status = String(obj.status ?? "active");
    const active = status === "active" || status === "trialing";
    return {
      user_id: metadata.user_id ?? null,
      customer_id: customer,
      subscription_id: typeof obj.id === "string" ? obj.id : null,
      plan: active || status === "past_due" ? "pro" : "free",
      plan_status: status === "trialing" ? "trialing" : status === "past_due" ? "past_due" : active ? "active" : "canceled",
    };
  }
  if (event.type === "customer.subscription.deleted") {
    return {
      user_id: metadata.user_id ?? null,
      customer_id: customer,
      subscription_id: typeof obj.id === "string" ? obj.id : null,
      plan: "free",
      plan_status: "canceled",
    };
  }
  return null;
}
