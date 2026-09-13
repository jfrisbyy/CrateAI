import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, jsonResponse, seedProfile, USER_A, USER_B, type World } from "@/lib/testing";
import { POST } from "./route";

let world: World;

const stripeEnv = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_test", NEXT_PUBLIC_APP_URL: "https://app.test" };

beforeEach(() => {
  world = createWorld({ env: stripeEnv });
  world.onFetch((url) => (url.startsWith("https://api.stripe.com/") ? jsonResponse({ url: "https://checkout.stripe.test/session" }) : null));
});

describe("POST /api/billing/checkout", () => {
  it("creates a Checkout session for the caller", async () => {
    seedProfile(world.db, USER_A, { plan: "free" });
    const { status, body } = await call<{ url: string }>(POST());
    expect(status).toBe(200);
    expect(body.url).toBe("https://checkout.stripe.test/session");
    const sent = world.fetchCalls.find((c) => c.url.includes("/checkout/sessions"));
    expect(sent?.body).toContain(`client_reference_id=${USER_A}`);
    expect(sent?.body).toContain("price_test");
  });

  it("reads only the caller's own plan", async () => {
    seedProfile(world.db, USER_B, { plan: "pro", plan_status: "active" });
    seedProfile(world.db, USER_A, { plan: "free" });
    expect((await POST()).status).toBe(200);
  });

  it("409s a caller who is already on pro", async () => {
    seedProfile(world.db, USER_A, { plan: "pro", plan_status: "active" });
    expect((await POST()).status).toBe(409);
  });

  it("503s when Stripe is not configured", async () => {
    world = createWorld();
    seedProfile(world.db, USER_A);
    const { status, body } = await call<{ error: string }>(POST());
    expect(status).toBe(503);
    expect(body.error).toContain("not configured");
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await POST()).status).toBe(401);
  });
});
