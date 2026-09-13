import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_LIMITS } from "@/lib/billing/limits";
import {
  createWorld,
  jsonResponse,
  ndjson,
  post,
  rawPost,
  seedConversation,
  seedFile,
  seedMessage,
  seedUsageEvent,
  USER_A,
  USER_B,
  type World,
} from "@/lib/testing";
import { scriptedModel, type Scripted } from "@/lib/chat/fakes";

// The chat route reaches the model through this module and nowhere else.
let model = scriptedModel([]);

vi.mock("@/lib/anthropic/client", () => ({
  hasAnthropicKey: () => Boolean(process.env.ANTHROPIC_API_KEY),
  getAnthropic: () => ({ messages: { stream: (params: Parameters<typeof model.stream>[0]) => model.stream(params) } }),
  describeAnthropicError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}));

const { POST } = await import("./route");

let world: World;

function script(...turns: Scripted[]) {
  model = scriptedModel(turns);
  return model;
}

type Event = { type: string; delta?: string; name?: string; card?: { type: string; gpu_count?: number }; message_id?: string; conversation_id?: string };

beforeEach(() => {
  world = createWorld({ env: { ANTHROPIC_API_KEY: "test-key" } });
  script({ text: "The tempo is 92 BPM." });
});

describe("POST /api/chat", () => {
  it("streams the reply and persists both messages", async () => {
    const file = seedFile(world.db, USER_A, { original_filename: "break.wav" });
    const res = await POST(post("/api/chat", { message: "what is the tempo?", file_ids: [file.id] }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("x-ndjson");
    const conversationId = res.headers.get("x-conversation-id");
    expect(conversationId).toBeTruthy();

    const events = await ndjson<Event>(res);
    expect(events.filter((e) => e.type === "text").map((e) => e.delta).join("")).toBe("The tempo is 92 BPM.");
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    expect(done?.conversation_id).toBe(conversationId);

    const messages = world.db.rows("messages");
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages.every((m) => m.user_id === USER_A)).toBe(true);
    expect(world.db.rows("conversations")).toHaveLength(1);
  });

  it("continues an existing conversation", async () => {
    const conversation = seedConversation(world.db, USER_A);
    seedMessage(world.db, USER_A, conversation.id, { content: [{ type: "text", text: "earlier" }] });
    const res = await POST(post("/api/chat", { conversation_id: conversation.id, message: "and the key?" }));
    expect(res.headers.get("x-conversation-id")).toBe(conversation.id);
    await ndjson(res);
    expect(world.db.rows("conversations")).toHaveLength(1);
    expect(model.requests[0]?.messages.map((m) => m.role)).toEqual(["user", "user"]);
  });

  it("404s another user's conversation and writes no message into it", async () => {
    const theirs = seedConversation(world.db, USER_B);
    const res = await POST(post("/api/chat", { conversation_id: theirs.id, message: "hello" }));
    expect(res.status).toBe(404);
    expect(world.db.rows("messages")).toHaveLength(0);
  });

  it("never puts another user's file in the model's context", async () => {
    const theirs = seedFile(world.db, USER_B, { original_filename: "their-secret.wav" });
    const mine = seedFile(world.db, USER_A, { original_filename: "mine.wav" });
    const res = await POST(post("/api/chat", { message: "compare these", file_ids: [mine.id, theirs.id] }));
    await ndjson(res);
    const system = JSON.stringify(model.requests[0]?.system ?? []);
    expect(system).toContain("mine.wav");
    expect(system).not.toContain("their-secret.wav");
  });

  it("asks for confirmation over five GPU operations instead of running them", async () => {
    const files = Array.from({ length: 6 }, () => seedFile(world.db, USER_A));
    const operations = files.map((f) => ({ tool: "separate_stems", input_json: JSON.stringify({ file_id: f.id }) }));
    script(
      { text: "That is six separations.", tools: [{ id: "toolu_1", name: "batch", input: { operations } }] },
      { text: "Say the word and I'll run them." },
    );
    const res = await POST(post("/api/chat", { message: "separate all of them" }));
    const events = await ndjson<Event>(res);
    const result = events.find((e) => e.type === "tool_result" && e.name === "batch");
    expect(result?.card?.type).toBe("confirm");
    expect(result?.card?.gpu_count).toBe(6);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("runs the batch when the producer re-sends it confirmed", async () => {
    const files = Array.from({ length: 6 }, () => seedFile(world.db, USER_A));
    const operations = files.map((f) => ({ tool: "separate_stems", input_json: JSON.stringify({ file_id: f.id }) }));
    script({ tools: [{ id: "toolu_1", name: "batch", input: { operations } }] }, { text: "Running." });
    const res = await POST(post("/api/chat", { message: "run it", batch: { operations, confirmed: true } }));
    const events = await ndjson<Event>(res);
    const result = events.find((e) => e.type === "tool_result" && e.name === "batch");
    expect(result?.card?.type).not.toBe("confirm");
    expect(world.db.rows("jobs")).toHaveLength(6);
    expect(world.db.rows("jobs").every((j) => j.user_id === USER_A && j.kind === "stems")).toBe(true);
  });

  it("429s once the day's chat turns are used up", async () => {
    const conversation = seedConversation(world.db, USER_A);
    for (let i = 0; i < 50; i++) seedMessage(world.db, USER_A, conversation.id, { role: "user" });
    const res = await POST(post("/api/chat", { message: "one more" }));
    expect(res.status).toBe(429);
    expect(world.db.rows("messages")).toHaveLength(50);
  });

  it("counts another user's turns separately", async () => {
    const conversation = seedConversation(world.db, USER_B);
    for (let i = 0; i < 50; i++) seedMessage(world.db, USER_B, conversation.id, { role: "user" });
    const res = await POST(post("/api/chat", { message: "still fine" }));
    expect(res.status).toBe(200);
    await ndjson(res);
  });

  it("meters the turn into usage_events", async () => {
    await ndjson(await POST(post("/api/chat", { message: "what is the tempo?" })));
    const events = world.db.rows("usage_events");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ user_id: USER_A, kind: "chat_turn", amount: 1 });
  });

  it("meters the searches a turn actually ran", async () => {
    world = createWorld({ env: { ANTHROPIC_API_KEY: "test-key", WEB_SEARCH_PROVIDER: "brave", BRAVE_SEARCH_API_KEY: "k" } });
    world.onFetch((url) => (url.startsWith("https://api.search.brave.com/") ? jsonResponse({ web: { results: [] } }) : null));
    script({ tools: [{ id: "t1", name: "web_search", input: { query: "who produced this" } }] }, { text: "Nothing found." });
    await ndjson(await POST(post("/api/chat", { message: "who produced this?" })));
    const searches = world.db.rows("usage_events").filter((e) => e.kind === "web_search");
    expect(searches).toHaveLength(1);
    expect(searches[0]!.amount).toBe(1);
  });

  it("429s on the monthly ceiling even with none spent today", async () => {
    seedUsageEvent(world.db, USER_A, {
      id: "u1",
      kind: "chat_turn",
      amount: PLAN_LIMITS.free.chat_turns_per_month,
      created_at: "2026-09-01T00:00:00.000Z",
    });
    const res = await POST(post("/api/chat", { message: "one more" }));
    expect(res.status).toBe(429);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("month");
  });

  it("503s without a model key", async () => {
    world = createWorld();
    const res = await POST(post("/api/chat", { message: "hello" }));
    expect(res.status).toBe(503);
  });

  it("400s an empty message and a malformed body", async () => {
    expect((await POST(post("/api/chat", { message: "   " }))).status).toBe(400);
    expect((await POST(post("/api/chat", {}))).status).toBe(400);
    expect((await POST(rawPost("/api/chat", "{"))).status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await POST(post("/api/chat", { message: "hello" }))).status).toBe(401);
  });
});
