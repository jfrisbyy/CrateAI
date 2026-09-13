import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, params, post, seedFile, seedLoop, USER_A, USER_B, type World } from "@/lib/testing";
import type { JobResponse } from "@/lib/api/types";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/loops/[id]/render", () => {
  it("queues render_loop with the contract's params", async () => {
    const file = seedFile(world.db, USER_A);
    const loop = seedLoop(world.db, USER_A, file.id);
    const { status, body } = await call<JobResponse>(POST(post(`/api/loops/${loop.id}/render`), params({ id: loop.id })));
    expect(status).toBe(201);
    expect(body.job).toMatchObject({ kind: "render_loop", file_id: file.id, user_id: USER_A });
    expect(body.job.params).toEqual({ loop_id: loop.id, crossfade_ms: 12, snap_zero_crossing: true });
    expect(world.dispatched).toEqual([body.job.id]);
  });

  it("404s another user's loop and queues nothing", async () => {
    const theirs = seedLoop(world.db, USER_B, seedFile(world.db, USER_B).id);
    expect((await POST(post(`/api/loops/${theirs.id}/render`), params({ id: theirs.id }))).status).toBe(404);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await POST(post("/api/loops/x/render"), params({ id: "x" }))).status).toBe(400);
    const loop = seedLoop(world.db, USER_A, seedFile(world.db, USER_A).id);
    world.signOut();
    expect((await POST(post(`/api/loops/${loop.id}/render`), params({ id: loop.id }))).status).toBe(401);
  });
});
