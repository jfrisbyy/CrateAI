import { beforeEach, describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "@/lib/billing/limits";
import { call, createWorld, jsonResponse, post, rawPost, seedUsageEvent, USER_A, USER_B, type World } from "@/lib/testing";
import { POST } from "./route";

let world: World;

const brave = { WEB_SEARCH_PROVIDER: "brave", BRAVE_SEARCH_API_KEY: "brave-test-key" };

function braveAnswers(world: World, results: Array<{ title: string; url: string; description: string }>) {
  world.onFetch((url) =>
    url.startsWith("https://api.search.brave.com/") ? jsonResponse({ web: { results } }) : null,
  );
}

beforeEach(() => {
  world = createWorld({ env: brave });
});

describe("POST /api/web/search", () => {
  it("returns the provider's results with the quota left", async () => {
    braveAnswers(world, [{ title: "Who produced it", url: "https://example.com/a", description: "a piece" }]);
    const { status, body } = await call<{ results: Array<{ url: string }>; provider: string; quota: { per_day: number; per_month: number } }>(
      POST(post("/api/web/search", { query: "who produced this record" })),
    );
    expect(status).toBe(200);
    expect(body.results.map((r) => r.url)).toEqual(["https://example.com/a"]);
    expect(body.provider).toBe("brave");
    expect(body.quota.per_day).toBe(PLAN_LIMITS.free.web_searches_per_day);
    expect(body.quota.per_month).toBe(PLAN_LIMITS.free.web_searches_per_month);
  });

  it("meters the search it ran, so calling this route directly is no longer free", async () => {
    braveAnswers(world, []);
    expect((await POST(post("/api/web/search", { query: "who sampled this" }))).status).toBe(200);
    const events = world.db.rows("usage_events").filter((r) => r.kind === "web_search");
    expect(events).toHaveLength(1);
    expect(events[0]!.user_id).toBe(USER_A);
    expect(events[0]!.amount).toBe(1);
  });

  it("429s once the plan's searches are used up", async () => {
    seedUsageEvent(world.db, USER_A, { id: "u1", kind: "web_search", amount: PLAN_LIMITS.free.web_searches_per_day });
    const { status, body } = await call<{ error: string }>(POST(post("/api/web/search", { query: "anything" })));
    expect(status).toBe(429);
    expect(body.error).toContain("web searches");
  });

  it("429s on the monthly ceiling even with none spent today", async () => {
    seedUsageEvent(world.db, USER_A, {
      id: "u2",
      kind: "web_search",
      amount: PLAN_LIMITS.free.web_searches_per_month,
      created_at: "2026-09-01T00:00:00.000Z",
    });
    const { status, body } = await call<{ error: string }>(POST(post("/api/web/search", { query: "anything" })));
    expect(status).toBe(429);
    expect(body.error).toContain("month");
  });

  it("counts only the caller's own searches", async () => {
    braveAnswers(world, []);
    seedUsageEvent(world.db, USER_B, { id: "u3", kind: "web_search", amount: PLAN_LIMITS.free.web_searches_per_month });
    expect((await POST(post("/api/web/search", { query: "still allowed" }))).status).toBe(200);
  });

  it("503s when no provider is configured", async () => {
    world = createWorld();
    const { status, body } = await call<{ error: string }>(POST(post("/api/web/search", { query: "anything" })));
    expect(status).toBe(503);
    expect(body.error).toContain("BRAVE_SEARCH_API_KEY");
  });

  it("400s an empty query and a malformed body", async () => {
    expect((await POST(post("/api/web/search", { query: "  " }))).status).toBe(400);
    expect((await POST(rawPost("/api/web/search", "{"))).status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await POST(post("/api/web/search", { query: "x" }))).status).toBe(401);
  });
});
