import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, jsonResponse, seedProfile, USER_A, USER_B, type World } from "@/lib/testing";
import { POST } from "./route";

let world: World;

const stripeEnv = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_test" };

beforeEach(() => {
  world = createWorld({ env: stripeEnv });
  world.onFetch((url) => (url.startsWith("https://api.stripe.com/") ? jsonResponse({ url: "https://portal.stripe.test/session" }) : null));
});

describe("POST /api/billing/portal", () => {
  it("opens the portal for the caller's customer", async () => {
    seedProfile(world.db, USER_A, { stripe_customer_id: "cus_123" });
    const { status, body } = await call<{ url: string }>(POST());
    expect(status).toBe(200);
    expect(body.url).toBe("https://portal.stripe.test/session");
    expect(world.fetchCalls.find((c) => c.url.includes("/billing_portal/"))?.body).toContain("cus_123");
  });

  it("409s a caller with no subscription", async () => {
    seedProfile(world.db, USER_A, { stripe_customer_id: null });
    expect((await POST()).status).toBe(409);
  });

  it("never opens another user's portal", async () => {
    seedProfile(world.db, USER_B, { stripe_customer_id: "cus_999" });
    seedProfile(world.db, USER_A, { stripe_customer_id: null });
    expect((await POST()).status).toBe(409);
    expect(world.fetchCalls.some((c) => (c.body ?? "").includes("cus_999"))).toBe(false);
  });

  it("503s when Stripe is not configured", async () => {
    world = createWorld();
    seedProfile(world.db, USER_A, { stripe_customer_id: "cus_123" });
    expect((await POST()).status).toBe(503);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await POST()).status).toBe(401);
  });
});
