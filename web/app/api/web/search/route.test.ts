import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, jsonResponse, post, rawPost, seedConversation, seedMessage, USER_A, USER_B, type World } from "@/lib/testing";
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
    const { status, body } = await call<{ results: Array<{ url: string }>; provider: string; quota: { per_day: number } }>(
      POST(post("/api/web/search", { query: "who produced this record" })),
    );
    expect(status).toBe(200);
    expect(body.results.map((r) => r.url)).toEqual(["https://example.com/a"]);
    expect(body.provider).toBe("brave");
    expect(body.quota.per_day).toBe(20);
  });

  it("429s once today's free-tier searches are used up", async () => {
    const conversation = seedConversation(world.db, USER_A);
    const toolCalls = Array.from({ length: 20 }, () => ({ name: "web_search" }));
    seedMessage(world.db, USER_A, conversation.id, { role: "assistant", content: [], tool_calls: toolCalls });
    const { status, body } = await call<{ error: string }>(POST(post("/api/web/search", { query: "anything" })));
    expect(status).toBe(429);
    expect(body.error).toContain("web searches");
  });

  it("counts only the caller's own searches", async () => {
    braveAnswers(world, []);
    const conversation = seedConversation(world.db, USER_B);
    const toolCalls = Array.from({ length: 20 }, () => ({ name: "web_search" }));
    seedMessage(world.db, USER_B, conversation.id, { role: "assistant", content: [], tool_calls: toolCalls });
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
