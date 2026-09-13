import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, seedProfile, USER_A, USER_B, type World } from "@/lib/testing";
import { POST } from "./route";

let world: World;

const SECRET = "whsec_test";

function signed(payload: unknown, secret = SECRET, at = Math.floor(Date.now() / 1000)): Request {
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", secret).update(`${at}.${body}`).digest("hex");
  return new Request("http://localhost:3000/api/billing/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": `t=${at},v1=${signature}` },
    body,
  });
}

const checkoutCompleted = (userId: string) => ({
  id: "evt_1",
  type: "checkout.session.completed",
  data: { object: { client_reference_id: userId, customer: "cus_123", subscription: "sub_123" } },
});

beforeEach(() => {
  world = createWorld({ env: { STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_test" } });
});

describe("POST /api/billing/webhook", () => {
  it("upgrades the plan with the service role (a user cannot do this themselves)", async () => {
    seedProfile(world.db, USER_A, { plan: "free" });
    const { status, body } = await call<{ received: boolean }>(POST(signed(checkoutCompleted(USER_A))));
    expect(status).toBe(200);
    expect(body.received).toBe(true);
    expect(world.db.find("profiles", USER_A)).toMatchObject({ plan: "pro", plan_status: "active", stripe_customer_id: "cus_123" });
  });

  it("400s a bad signature, a missing header and a stale timestamp, and writes nothing", async () => {
    seedProfile(world.db, USER_A, { plan: "free" });
    expect((await POST(signed(checkoutCompleted(USER_A), "whsec_wrong"))).status).toBe(400);
    const unsigned = new Request("http://localhost:3000/api/billing/webhook", { method: "POST", body: JSON.stringify(checkoutCompleted(USER_A)) });
    expect((await POST(unsigned)).status).toBe(400);
    const stale = signed(checkoutCompleted(USER_A), SECRET, Math.floor(Date.now() / 1000) - 3600);
    expect((await POST(stale)).status).toBe(400);
    expect(world.db.find("profiles", USER_A)?.plan).toBe("free");
  });

  it("400s a signed payload that is not JSON", async () => {
    const body = "not json";
    const at = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", SECRET).update(`${at}.${body}`).digest("hex");
    const req = new Request("http://localhost:3000/api/billing/webhook", {
      method: "POST",
      headers: { "stripe-signature": `t=${at},v1=${signature}` },
      body,
    });
    expect((await POST(req)).status).toBe(400);
  });

  it("matches the customer id when the event carries no user id", async () => {
    seedProfile(world.db, USER_B, { stripe_customer_id: "cus_999", plan: "pro", plan_status: "active" });
    const event = { id: "evt_2", type: "customer.subscription.deleted", data: { object: { id: "sub_999", customer: "cus_999", status: "canceled" } } };
    const { status } = await call(POST(signed(event)));
    expect(status).toBe(200);
    expect(world.db.find("profiles", USER_B)).toMatchObject({ plan: "free", plan_status: "canceled" });
  });

  it("acknowledges an event it does not act on", async () => {
    const { status, body } = await call<{ ignored?: string; unmatched?: boolean }>(
      POST(signed({ id: "evt_3", type: "invoice.paid", data: { object: {} } })),
    );
    expect(status).toBe(200);
    expect(body.ignored).toBe("invoice.paid");

    const noUser = { id: "evt_4", type: "customer.subscription.updated", data: { object: { id: "sub_x", customer: "cus_unknown", status: "active" } } };
    const unmatched = await call<{ unmatched?: boolean }>(POST(signed(noUser)));
    expect(unmatched.status).toBe(200);
    expect(unmatched.body.unmatched).toBe(true);
  });

  it("503s when the webhook secret is not set", async () => {
    world = createWorld();
    const { status, body } = await call<{ error: string }>(POST(signed(checkoutCompleted(USER_A))));
    expect(status).toBe(503);
    expect(body.error).toContain("STRIPE_WEBHOOK_SECRET");
  });

  it("503s rather than throwing when the service role is not configured", async () => {
    world = createWorld({ serviceRole: false, env: { STRIPE_WEBHOOK_SECRET: SECRET } });
    seedProfile(world.db, USER_A, { plan: "free" });
    const { status, body } = await call<{ error: string }>(POST(signed(checkoutCompleted(USER_A))));
    expect(status).toBe(503);
    expect(body.error).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });
});
