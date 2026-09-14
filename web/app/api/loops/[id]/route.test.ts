import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, del, params, patch, rawPost, seedFile, seedLoop, USER_A, USER_B, type World } from "@/lib/testing";
import type { LoopResponse } from "@/lib/api/types";
import { DELETE, PATCH } from "./route";

/** The corrections this world logged, oldest first. */
function corrections(w: World) {
  return w.db.rows("corrections");
}

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

// The producer's half of principle 7: the ranker reads these back for this
// account alone (analysis/lockedgroove/learn/loop_prefs.py). What counts is in
// lib/report/edits.ts; this is that the route writes it, and does not write
// anything else.
describe("PATCH /api/loops/[id] as a correction", () => {
  it("logs a dragged edge as loop_edges, the offered span against the kept one", async () => {
    const file = seedFile(world.db, USER_A);
    const loop = seedLoop(world.db, USER_A, file.id, { start_s: 0, end_s: 8, bars: 4 });
    const { body } = await call<LoopResponse>(
      PATCH(patch(`/api/loops/${loop.id}`, { start_s: 0, end_s: 16, bars: 8 }), params({ id: loop.id })),
    );
    expect(corrections(world)).toHaveLength(1);
    expect(corrections(world)[0]).toMatchObject({
      user_id: USER_A,
      file_id: file.id,
      field: "loop_edges",
      predicted: { start_s: 0, end_s: 8, bars: 4 },
      corrected: { start_s: 0, end_s: 16, bars: 8 },
    });
    expect(body.correction?.field).toBe("loop_edges");
  });

  it("logs a bar count set outright as loop_bars", async () => {
    const loop = seedLoop(world.db, USER_A, seedFile(world.db, USER_A).id, { start_s: 0, end_s: 8, bars: 4 });
    await PATCH(patch(`/api/loops/${loop.id}`, { end_s: 4, bars: 2, via: "bars" }), params({ id: loop.id }));
    expect(corrections(world).map((c) => c.field)).toEqual(["loop_bars"]);
  });

  it("writes nothing for a drag that ended where it started, or a rename", async () => {
    const loop = seedLoop(world.db, USER_A, seedFile(world.db, USER_A).id, { start_s: 1, end_s: 9, bars: 4 });
    await PATCH(patch(`/api/loops/${loop.id}`, { start_s: 1, end_s: 9, bars: 4 }), params({ id: loop.id }));
    await PATCH(patch(`/api/loops/${loop.id}`, { name: "the one" }), params({ id: loop.id }));
    const { body } = await call<LoopResponse>(PATCH(patch(`/api/loops/${loop.id}`, { name: "the one again" }), params({ id: loop.id })));
    expect(corrections(world)).toHaveLength(0);
    expect(body.correction).toBeNull();
  });

  it("writes nothing for a loop the producer drew themselves", async () => {
    const loop = seedLoop(world.db, USER_A, seedFile(world.db, USER_A).id, { start_s: 0, end_s: 8, bars: 4, origin: "user" });
    await PATCH(patch(`/api/loops/${loop.id}`, { end_s: 16, bars: 8 }), params({ id: loop.id }));
    expect(world.db.find("loops", loop.id)?.end_s).toBe(16);
    expect(corrections(world)).toHaveLength(0);
  });

  it("logs an edit to a loop the chat proposed, because that was an offer too", async () => {
    const loop = seedLoop(world.db, USER_A, seedFile(world.db, USER_A).id, { start_s: 0, end_s: 8, bars: 4, origin: "chat" });
    await PATCH(patch(`/api/loops/${loop.id}`, { end_s: 16, bars: 8 }), params({ id: loop.id }));
    expect(corrections(world).map((c) => c.field)).toEqual(["loop_edges"]);
  });

  it("counts a chain of nudges as one correction, keeping the span we offered", async () => {
    const loop = seedLoop(world.db, USER_A, seedFile(world.db, USER_A).id, { start_s: 0, end_s: 8, bars: 4 });
    for (const start of [0.5, 1, 1.5, 2]) {
      await PATCH(patch(`/api/loops/${loop.id}`, { start_s: start, end_s: start + 8, bars: 4 }), params({ id: loop.id }));
    }
    expect(corrections(world)).toHaveLength(1);
    expect(corrections(world)[0]).toMatchObject({
      field: "loop_edges",
      predicted: { start_s: 0, end_s: 8, bars: 4 },
      corrected: { start_s: 2, end_s: 10, bars: 4 },
    });
  });

  it("starts a new correction for a loop that was not where the last one ended", async () => {
    const file = seedFile(world.db, USER_A);
    const one = seedLoop(world.db, USER_A, file.id, { start_s: 0, end_s: 8, bars: 4 });
    const two = seedLoop(world.db, USER_A, file.id, { start_s: 40, end_s: 48, bars: 4 });
    await PATCH(patch(`/api/loops/${one.id}`, { end_s: 16, bars: 8 }), params({ id: one.id }));
    await PATCH(patch(`/api/loops/${two.id}`, { end_s: 56, bars: 8 }), params({ id: two.id }));
    expect(corrections(world)).toHaveLength(2);
  });

  it("writes nothing when the edit was refused", async () => {
    const theirs = seedLoop(world.db, USER_B, seedFile(world.db, USER_B).id, { start_s: 0, end_s: 4 });
    await PATCH(patch(`/api/loops/${theirs.id}`, { end_s: 16 }), params({ id: theirs.id }));
    expect(corrections(world)).toHaveLength(0);
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
