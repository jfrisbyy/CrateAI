import { beforeEach, describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "@/lib/billing/limits";
import { createWorld, seedConversation, seedMessage, seedProfile, seedUsageEvent, sessionClient, USER_A, USER_B, type World } from "@/lib/testing";
import {
  chatQuotaMessage,
  chatTurnsLeft,
  FREE_TIER,
  meterChatTurn,
  meterWebSearches,
  readUsage,
  webQuotaMessage,
  webSearchesIn,
  webSearchesLeft,
} from "./limits";

let world: World;
const NOW = new Date("2026-09-13T15:30:00Z");

function client(userId = USER_A) {
  return sessionClient(world.db, userId).asServerClient();
}

beforeEach(() => {
  world = createWorld();
});

describe("free-tier limits", () => {
  it("is the plan table, not a second copy of it", () => {
    expect(FREE_TIER).toBe(PLAN_LIMITS.free);
  });

  it("keeps the launch numbers, with a monthly ceiling under every daily burst cap", () => {
    expect(FREE_TIER.chat_turns_per_day).toBe(8);
    expect(FREE_TIER.chat_turns_per_month).toBe(40);
    expect(FREE_TIER.web_searches_per_day).toBe(5);
    expect(FREE_TIER.web_searches_per_month).toBe(25);
    // the packet's other free numbers survived the arithmetic unchanged
    expect(FREE_TIER.stem_jobs_per_month).toBe(5);
    expect(FREE_TIER.storage_bytes).toBe(2 * 1024 ** 3);
    expect(FREE_TIER.gpu_seconds_per_month).toBe(30 * 60);
    // a month can never be spent in one day, and a month of days can never
    // outrun the monthly ceiling: that is the point of having both
    expect(FREE_TIER.chat_turns_per_day).toBeLessThan(FREE_TIER.chat_turns_per_month);
    expect(FREE_TIER.chat_turns_per_day * 30).toBeGreaterThan(FREE_TIER.chat_turns_per_month);
  });

  it("counts web searches from recorded tool calls", () => {
    expect(webSearchesIn(null)).toBe(0);
    expect(webSearchesIn([{ name: "get_report" }, { name: "web_search" }, { name: "identify_context", searches: 4 }, { name: "identify_context" }])).toBe(6);
    expect(webSearchesIn([{ name: "batch", nested: [{ name: "web_search" }, { name: "web_search" }] }])).toBe(2);
  });

  it("counts the day and the month from UTC midnight and the first", async () => {
    seedUsageEvent(world.db, USER_A, { id: "d1", kind: "chat_turn", amount: 2, created_at: "2026-09-13T00:00:00.000Z" });
    seedUsageEvent(world.db, USER_A, { id: "d2", kind: "chat_turn", amount: 3, created_at: "2026-09-12T23:59:59.000Z" });
    seedUsageEvent(world.db, USER_A, { id: "d3", kind: "chat_turn", amount: 4, created_at: "2026-08-31T23:59:59.000Z" });
    const usage = await readUsage(client(), USER_A, NOW);
    expect(usage.usage.chat_turns_today).toBe(2);
    expect(usage.usage.chat_turns_month).toBe(5);
  });
});

describe("readUsage", () => {
  it("reads today's and this month's metered usage and computes what is left", async () => {
    seedProfile(world.db, USER_A);
    seedUsageEvent(world.db, USER_A, { id: "e1", kind: "chat_turn", amount: 6 });
    seedUsageEvent(world.db, USER_A, { id: "e2", kind: "web_search", amount: 3 });
    const usage = await readUsage(client(), USER_A, NOW);
    expect(usage.plan).toBe("free");
    expect(usage.usage.chat_turns_today).toBe(6);
    expect(usage.usage.chat_turns_month).toBe(6);
    expect(usage.usage.web_searches_today).toBe(3);
    expect(chatTurnsLeft(usage)).toBe(2);
    expect(webSearchesLeft(usage)).toBe(2);
  });

  it("counts the conversation as a floor, so the cap bites even with metering off", async () => {
    const conversation = seedConversation(world.db, USER_A);
    for (let i = 0; i < 9; i++) seedMessage(world.db, USER_A, conversation.id, { id: `m${i}`, role: "user" });
    const usage = await readUsage(client(), USER_A, NOW);
    expect(usage.usage.chat_turns_today).toBe(9);
    expect(chatTurnsLeft(usage)).toBe(0);
  });

  it("gives a pro account the pro caps", async () => {
    seedProfile(world.db, USER_A, { plan: "pro" });
    const usage = await readUsage(client(), USER_A, NOW);
    expect(usage.limits).toBe(PLAN_LIMITS.pro);
    expect(chatTurnsLeft(usage)).toBe(PLAN_LIMITS.pro.chat_turns_per_day);
  });

  it("never sees another account's usage", async () => {
    seedUsageEvent(world.db, USER_B, { id: "e9", kind: "chat_turn", amount: 30 });
    const usage = await readUsage(client(), USER_A, NOW);
    expect(usage.usage.chat_turns_month).toBe(0);
  });

  it("names the cap that actually bit", async () => {
    seedUsageEvent(world.db, USER_A, { id: "e1", kind: "chat_turn", amount: FREE_TIER.chat_turns_per_month });
    const spent = await readUsage(client(), USER_A, NOW);
    expect(chatQuotaMessage(spent)).toContain("month");
    seedUsageEvent(world.db, USER_A, { id: "e2", kind: "web_search", amount: FREE_TIER.web_searches_per_day });
    expect(webQuotaMessage(await readUsage(client(), USER_A, NOW))).toContain("today");
  });
});

describe("metering", () => {
  it("writes one usage_events row per turn and per batch of searches", async () => {
    await meterChatTurn(USER_A);
    await meterWebSearches(USER_A, 4);
    await meterWebSearches(USER_A, 0);
    const rows = world.db.rows("usage_events");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.kind, r.amount])).toEqual([["chat_turn", 1], ["web_search", 4]]);
    expect(rows.every((r) => r.user_id === USER_A)).toBe(true);
    const usage = await readUsage(client(), USER_A, NOW);
    expect(usage.usage.chat_turns_today).toBe(1);
    expect(usage.usage.web_searches_today).toBe(4);
  });

  it("is best effort: no service role means no rows and no throw", async () => {
    world.setServiceRole(false);
    await expect(meterChatTurn(USER_A)).resolves.toBeUndefined();
    expect(world.db.rows("usage_events")).toHaveLength(0);
  });
});
