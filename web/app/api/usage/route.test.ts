import { beforeEach, describe, expect, it } from "vitest";
import {
  call,
  createWorld,
  seedConversation,
  seedFile,
  seedMessage,
  seedProfile,
  seedUsageEvent,
  USER_A,
  USER_B,
  type World,
} from "@/lib/testing";
import type { UsageReport } from "@/lib/billing/usage";
import { GB, PLAN_LIMITS } from "@/lib/billing/limits";
import { GET } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/usage", () => {
  it("reports this period's usage against the plan's limits", async () => {
    seedProfile(world.db, USER_A);
    seedFile(world.db, USER_A, { size_bytes: 100 * 1024 * 1024 });
    seedUsageEvent(world.db, USER_A, { kind: "stem_job", amount: 2 });
    seedUsageEvent(world.db, USER_A, { kind: "gpu_seconds", amount: 120 });
    const { status, body } = await call<UsageReport>(GET());
    expect(status).toBe(200);
    expect(body.plan).toBe("free");
    expect(body.limits.storage_bytes).toBe(2 * GB);
    expect(body.usage.stem_jobs_month).toBe(2);
    expect(body.usage.gpu_seconds_month).toBe(120);
    expect(body.usage.storage_bytes).toBe(100 * 1024 * 1024);
    expect(body.fractions.stem_jobs_per_month).toBeCloseTo(0.4);
  });

  it("shows chat turns and web searches by day and by month, from usage_events", async () => {
    seedProfile(world.db, USER_A);
    seedUsageEvent(world.db, USER_A, { id: "u1", kind: "chat_turn", amount: 3 });
    seedUsageEvent(world.db, USER_A, { id: "u2", kind: "chat_turn", amount: 5, created_at: "2026-09-01T00:00:00.000Z" });
    seedUsageEvent(world.db, USER_A, { id: "u3", kind: "web_search", amount: 2 });
    const { body } = await call<UsageReport>(GET());
    expect(body.usage.chat_turns_today).toBe(3);
    expect(body.usage.chat_turns_month).toBe(8);
    expect(body.usage.web_searches_today).toBe(2);
    expect(body.usage.web_searches_month).toBe(2);
    expect(body.limits.chat_turns_per_month).toBe(PLAN_LIMITS.free.chat_turns_per_month);
    expect(body.fractions.chat_turns_per_month).toBeCloseTo(8 / PLAN_LIMITS.free.chat_turns_per_month);
  });

  it("counts the conversation as a floor under the metered turns", async () => {
    const conversation = seedConversation(world.db, USER_A);
    for (let i = 0; i < 4; i++) seedMessage(world.db, USER_A, conversation.id, { id: `m${i}`, role: "user" });
    const { body } = await call<UsageReport>(GET());
    expect(body.usage.chat_turns_today).toBe(4);
  });

  it("reports what the account has cost, and never a cost without usage", async () => {
    seedUsageEvent(world.db, USER_A, { id: "u1", kind: "chat_turn", amount: 10 });
    seedUsageEvent(world.db, USER_A, { id: "u2", kind: "gpu_seconds", amount: 600 });
    seedFile(world.db, USER_A, { size_bytes: 1024 * 1024 * 1024 });
    const { body } = await call<UsageReport>(GET());
    expect(body.chat_turn_usd).toBeGreaterThan(0);
    expect(body.cost.chat_usd).toBeCloseTo(10 * body.chat_turn_usd, 9);
    expect(body.cost.compute_usd).toBeGreaterThan(0);
    expect(body.cost.storage_usd).toBeGreaterThan(0);
    expect(body.cost.web_search_usd).toBe(0);
    expect(body.cost.total_usd).toBeCloseTo(
      body.cost.chat_usd + body.cost.web_search_usd + body.cost.compute_usd + body.cost.storage_usd,
      9,
    );
    // a free account that uses everything still cannot cost much
    expect(body.cost.total_usd).toBeLessThan(1);
  });

  it("counts nothing from another user", async () => {
    seedFile(world.db, USER_B, { size_bytes: 500 });
    seedUsageEvent(world.db, USER_B, { kind: "stem_job", amount: 4 });
    const { body } = await call<UsageReport>(GET());
    expect(body.usage.storage_bytes).toBe(0);
    expect(body.usage.stem_jobs_month).toBe(0);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await GET()).status).toBe(401);
  });
});
