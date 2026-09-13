import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, seedConversation, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { ConversationsListResponse } from "@/lib/api/types";
import type { ConversationRow } from "@/lib/types/db";
import { GET, POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/conversations", () => {
  it("lists the caller's conversations, most recent first", async () => {
    seedConversation(world.db, USER_A, { title: "older", updated_at: "2026-09-01T00:00:00.000Z" });
    seedConversation(world.db, USER_A, { title: "newer", updated_at: "2026-09-12T00:00:00.000Z" });
    const { status, body } = await call<ConversationsListResponse>(GET());
    expect(status).toBe(200);
    expect(body.conversations.map((c) => c.title)).toEqual(["newer", "older"]);
  });

  it("never lists another user's", async () => {
    seedConversation(world.db, USER_B);
    const { body } = await call<ConversationsListResponse>(GET());
    expect(body.conversations).toEqual([]);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await GET()).status).toBe(401);
  });
});

describe("POST /api/conversations", () => {
  it("starts one for the caller", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<{ conversation: ConversationRow }>(POST(post("/api/conversations", { title: "how was this made", file_ids: [file.id] })));
    expect(status).toBe(201);
    expect(body.conversation).toMatchObject({ user_id: USER_A, title: "how was this made", file_ids: [file.id] });
  });

  it("accepts an empty body", async () => {
    const { status, body } = await call<{ conversation: ConversationRow }>(POST(post("/api/conversations", {})));
    expect(status).toBe(201);
    expect(body.conversation.title).toBeNull();
    expect(body.conversation.file_ids).toEqual([]);
  });

  it("400s a malformed body", async () => {
    expect((await POST(rawPost("/api/conversations", "{"))).status).toBe(400);
    expect((await POST(post("/api/conversations", { file_ids: ["nope"] })))?.status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await POST(post("/api/conversations", {}))).status).toBe(401);
  });
});
