import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, USER_A, USER_B, type World } from "@/lib/testing";
import type { JobResponse } from "@/lib/api/types";
import { POST } from "./route";

let world: World;

const mine = (name: string) => `library/${USER_A}/beatbox/${name}`;

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/beatbox/train", () => {
  it("queues beatbox_train with the enrollment recordings", async () => {
    const examples = [
      { class: "kick", storage_path: mine("kick-1.wav") },
      { class: "snare", storage_path: mine("snare-1.wav") },
    ];
    const { status, body } = await call<JobResponse>(POST(post("/api/beatbox/train", { examples })));
    expect(status).toBe(201);
    expect(body.job).toMatchObject({ kind: "beatbox_train", file_id: null, user_id: USER_A });
    expect(body.job.params).toEqual({ examples });
    expect(world.dispatched).toEqual([body.job.id]);
  });

  it("400s a recording under another user's prefix", async () => {
    const examples = [
      { class: "kick", storage_path: mine("kick-1.wav") },
      { class: "snare", storage_path: `library/${USER_B}/beatbox/snare-1.wav` },
    ];
    const { status, body } = await call<{ error: string }>(POST(post("/api/beatbox/train", { examples })));
    expect(status).toBe(400);
    expect(body.error).toContain("your beatbox uploads");
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("400s a traversal out of the caller's prefix", async () => {
    const examples = [
      { class: "kick", storage_path: `library/${USER_A}/beatbox/../../${USER_B}/secret.wav` },
      { class: "snare", storage_path: mine("snare-1.wav") },
    ];
    expect((await POST(post("/api/beatbox/train", { examples }))).status).toBe(400);
  });

  it("400s fewer than two classes and a malformed body", async () => {
    const one = [{ class: "kick", storage_path: mine("kick-1.wav") }];
    expect((await POST(post("/api/beatbox/train", { examples: one }))).status).toBe(400);
    expect((await POST(post("/api/beatbox/train", { examples: [] }))).status).toBe(400);
    expect((await POST(rawPost("/api/beatbox/train", "{"))).status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    const examples = [
      { class: "kick", storage_path: mine("kick-1.wav") },
      { class: "snare", storage_path: mine("snare-1.wav") },
    ];
    expect((await POST(post("/api/beatbox/train", { examples }))).status).toBe(401);
  });
});
