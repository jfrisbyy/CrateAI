import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, del, params, patch, rawPost, seedFile, seedLoop, USER_A, USER_B, type World } from "@/lib/testing";
import type { LoopResponse } from "@/lib/api/types";
import { DELETE, PATCH } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("PATCH /api/loops/[id]", () => {
  it("moves an edge", async () => {
    const file = seedFile(world.db, USER_A);
    const loop = seedLoop(world.db, USER_A, file.id, { start_s: 0, end_s: 4 });
    const { status, body } = await call<LoopResponse>(PATCH(patch(`/api/loops/${loop.id}`, { start_s: 1.5 }), params({ id: loop.id })));
    expect(status).toBe(200);
    expect(body.loop.start_s).toBe(1.5);
    expect(body.loop.end_s).toBe(4);
  });

  it("cannot move another user's loop", async () => {
    const theirs = seedLoop(world.db, USER_B, seedFile(world.db, USER_B).id, { start_s: 0, end_s: 4 });
    const { status } = await call(PATCH(patch(`/api/loops/${theirs.id}`, { start_s: 2 }), params({ id: theirs.id })));
    expect(status).toBe(404);
    expect(world.db.find("loops", theirs.id)?.start_s).toBe(0);
  });

  it("400s edges that cross, an empty patch and a malformed body", async () => {
    const loop = seedLoop(world.db, USER_A, seedFile(world.db, USER_A).id, { start_s: 0, end_s: 4 });
    expect((await PATCH(patch(`/api/loops/${loop.id}`, { end_s: 0.0001, start_s: 3 }), params({ id: loop.id }))).status).toBe(400);
    expect((await PATCH(patch(`/api/loops/${loop.id}`, {}), params({ id: loop.id }))).status).toBe(400);
    expect((await PATCH(rawPost(`/api/loops/${loop.id}`, "{"), params({ id: loop.id }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const loop = seedLoop(world.db, USER_A, seedFile(world.db, USER_A).id);
    world.signOut();
    expect((await PATCH(patch(`/api/loops/${loop.id}`, { start_s: 1 }), params({ id: loop.id }))).status).toBe(401);
  });
});

describe("DELETE /api/loops/[id]", () => {
  it("deletes the caller's loop", async () => {
    const loop = seedLoop(world.db, USER_A, seedFile(world.db, USER_A).id);
    const { status } = await call(DELETE(del(`/api/loops/${loop.id}`), params({ id: loop.id })));
    expect(status).toBe(200);
    expect(world.db.rows("loops")).toHaveLength(0);
  });

  it("404s another user's loop and leaves it in place", async () => {
    const theirs = seedLoop(world.db, USER_B, seedFile(world.db, USER_B).id);
    expect((await DELETE(del(`/api/loops/${theirs.id}`), params({ id: theirs.id }))).status).toBe(404);
    expect(world.db.rows("loops")).toHaveLength(1);
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await DELETE(del("/api/loops/x"), params({ id: "x" }))).status).toBe(400);
    const loop = seedLoop(world.db, USER_A, seedFile(world.db, USER_A).id);
    world.signOut();
    expect((await DELETE(del(`/api/loops/${loop.id}`), params({ id: loop.id }))).status).toBe(401);
  });
});
