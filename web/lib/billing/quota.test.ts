import { describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "./limits";
import { checkChatQuota, checkJobQuota, checkStorageQuota, checkWebSearchQuota } from "./quota";
import { fractions, type UsageReport } from "./usage";
import { subscriptionPatch, verifyWebhookSignature } from "./stripe";
import { createHmac } from "node:crypto";
import { rateLimit, resetRateLimits } from "@/lib/ratelimit";

function report(over: Partial<UsageReport["usage"]> = {}, plan: "free" | "pro" = "free"): UsageReport {
  const usage = { storage_bytes: 0, gpu_seconds_month: 0, cpu_seconds_month: 0, stem_jobs_month: 0, chat_turns_today: 0, web_searches_today: 0, ...over };
  return { plan, plan_status: "active", limits: PLAN_LIMITS[plan], usage, fractions: fractions(PLAN_LIMITS[plan], usage) };
}

describe("quotas", () => {
  it("caps stem jobs and GPU minutes on the free plan", () => {
    expect(checkJobQuota(report(), "stems").ok).toBe(true);
    expect(checkJobQuota(report({ stem_jobs_month: 5 }), "stems").ok).toBe(false);
    expect(checkJobQuota(report({ gpu_seconds_month: 30 * 60 }), "embed").ok).toBe(false);
    expect(checkJobQuota(report({ gpu_seconds_month: 30 * 60 }), "analyze").ok).toBe(true);
    expect(checkJobQuota(report({ stem_jobs_month: 5 }, "pro"), "stems").ok).toBe(true);
  });
  it("caps storage, chat turns and web searches", () => {
    const r = report({ storage_bytes: PLAN_LIMITS.free.storage_bytes - 100 });
    expect(checkStorageQuota(r, 50).ok).toBe(true);
    expect(checkStorageQuota(r, 200).ok).toBe(false);
    expect(checkChatQuota(report({ chat_turns_today: 50 })).ok).toBe(false);
    expect(checkWebSearchQuota(report({ web_searches_today: 19 })).ok).toBe(true);
    expect(checkWebSearchQuota(report({ web_searches_today: 20 })).ok).toBe(false);
  });
  it("reports fractions", () => {
    expect(fractions(PLAN_LIMITS.free, report({ stem_jobs_month: 1 }).usage).stem_jobs_per_month).toBeCloseTo(0.2);
  });
});

describe("stripe", () => {
  it("verifies webhook signatures and rejects stale or forged ones", () => {
    const secret = "whsec_test";
    const payload = '{"id":"evt_1","type":"checkout.session.completed"}';
    const t = 1_700_000_000;
    const sig = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
    expect(verifyWebhookSignature(payload, `t=${t},v1=${sig}`, secret, 300, t + 10)).toBe(true);
    expect(verifyWebhookSignature(payload, `t=${t},v1=${sig}`, secret, 300, t + 1000)).toBe(false);
    expect(verifyWebhookSignature(payload + " ", `t=${t},v1=${sig}`, secret, 300, t)).toBe(false);
    expect(verifyWebhookSignature(payload, null, secret)).toBe(false);
  });
  it("maps subscription events to profile patches", () => {
    const done = subscriptionPatch({ id: "e", type: "checkout.session.completed", data: { object: { client_reference_id: "u1", customer: "cus_1", subscription: "sub_1" } } });
    expect(done).toEqual({ user_id: "u1", customer_id: "cus_1", subscription_id: "sub_1", plan: "pro", plan_status: "active" });
    const pastDue = subscriptionPatch({ id: "e", type: "customer.subscription.updated", data: { object: { id: "sub_1", customer: "cus_1", status: "past_due", metadata: { user_id: "u1" } } } });
    expect(pastDue?.plan).toBe("pro");
    expect(pastDue?.plan_status).toBe("past_due");
    const gone = subscriptionPatch({ id: "e", type: "customer.subscription.deleted", data: { object: { id: "sub_1", customer: "cus_1", metadata: { user_id: "u1" } } } });
    expect(gone?.plan).toBe("free");
    expect(subscriptionPatch({ id: "e", type: "invoice.paid", data: { object: {} } })).toBeNull();
  });
});

describe("rate limit", () => {
  it("allows a burst then refills", () => {
    resetRateLimits();
    const now = 1_000_000;
    expect(rateLimit("k", { capacity: 2, refillPerSec: 1, now })).toBe(true);
    expect(rateLimit("k", { capacity: 2, refillPerSec: 1, now })).toBe(true);
    expect(rateLimit("k", { capacity: 2, refillPerSec: 1, now })).toBe(false);
    expect(rateLimit("k", { capacity: 2, refillPerSec: 1, now: now + 1500 })).toBe(true);
  });
});
