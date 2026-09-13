import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, del, get, params, seedConversation, seedMessage, USER_A, USER_B, type World } from "@/lib/testing";
import type { ConversationResponse } from "@/lib/api/types";
import { DELETE, GET } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/conversations/[id]", () => {
  it("returns the conversation with its messages in order", async () => {
    const conversation = seedConversation(world.db, USER_A);
    seedMessage(world.db, USER_A, conversation.id, { created_at: "2026-09-13T10:00:00.000Z", content: [{ type: "text", text: "first" }] });
    seedMessage(world.db, USER_A, conversation.id, { created_at: "2026-09-13T11:00:00.000Z", role: "assistant", content: [{ type: "text", text: "second" }] });
    const { status, body } = await call<ConversationResponse>(GET(get(`/api/conversations/${conversation.id}`), params({ id: conversation.id })));
    expect(status).toBe(200);
    expect(body.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("404s another user's conversation and shows none of its messages", async () => {
    const theirs = seedConversation(world.db, USER_B);
    seedMessage(world.db, USER_B, theirs.id);
    const { status, body } = await call<{ error?: string; messages?: unknown[] }>(GET(get(`/api/conversations/${theirs.id}`), params({ id: theirs.id })));
    expect(status).toBe(404);
    expect(body.messages).toBeUndefined();
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await GET(get("/api/conversations/x"), params({ id: "x" }))).status).toBe(400);
    const conversation = seedConversation(world.db, USER_A);
    world.signOut();
    expect((await GET(get(`/api/conversations/${conversation.id}`), params({ id: conversation.id }))).status).toBe(401);
  });
});

describe("DELETE /api/conversations/[id]", () => {
  it("deletes the caller's conversation", async () => {
    const conversation = seedConversation(world.db, USER_A);
    expect((await DELETE(del(`/api/conversations/${conversation.id}`), params({ id: conversation.id }))).status).toBe(200);
    expect(world.db.rows("conversations")).toHaveLength(0);
  });

  it("404s another user's and leaves it in place", async () => {
    const theirs = seedConversation(world.db, USER_B);
    expect((await DELETE(del(`/api/conversations/${theirs.id}`), params({ id: theirs.id }))).status).toBe(404);
    expect(world.db.rows("conversations")).toHaveLength(1);
  });

  it("401s with no session", async () => {
    const conversation = seedConversation(world.db, USER_A);
    world.signOut();
    expect((await DELETE(del(`/api/conversations/${conversation.id}`), params({ id: conversation.id }))).status).toBe(401);
  });
});
