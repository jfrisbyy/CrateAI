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

// Exporting is where a producer takes a candidate out of the rack, so it is
// where `loop_pick` is logged (principle 7). The rank is ours to compute, and
// most exports are not a correction at all.
describe("POST /api/loops/[id]/render as a pick", () => {
  const terms = { seam: 0.61, phrase: 0.8, stability: 0.95, novelty: 1, onset_lock: 1, recurrence: 0.5 };

  function rack(fileId: string) {
    const top = seedLoop(world.db, USER_A, fileId, { start_s: 0, end_s: 8, bars: 4, score: 0.85, components: terms });
    const second = seedLoop(world.db, USER_A, fileId, { start_s: 16, end_s: 32, bars: 8, score: 0.78, components: { ...terms, seam: 0.9 } });
    return { top, second };
  }

  it("logs the row the producer took against the one we put first", async () => {
    const file = seedFile(world.db, USER_A);
    const { second } = rack(file.id);
    const { body } = await call<JobResponse>(POST(post(`/api/loops/${second.id}/render`), params({ id: second.id })));

    expect(world.db.rows("corrections")).toHaveLength(1);
    expect(world.db.rows("corrections")[0]).toMatchObject({
      user_id: USER_A,
      file_id: file.id,
      field: "loop_pick",
      predicted: { bars: 4, rank: 1, components: terms },
      corrected: { bars: 8, rank: 2, components: { ...terms, seam: 0.9 } },
    });
    expect(body.correction?.field).toBe("loop_pick");
    expect(body.job.kind).toBe("render_loop");
  });

  it("writes nothing when they exported the one we already put first", async () => {
    const { top } = rack(seedFile(world.db, USER_A).id);
    const { body } = await call<JobResponse>(POST(post(`/api/loops/${top.id}/render`), params({ id: top.id })));
    expect(world.db.rows("corrections")).toHaveLength(0);
    expect(body.correction).toBeNull();
  });

  it("writes nothing when there was nothing else to pick", async () => {
    const only = seedLoop(world.db, USER_A, seedFile(world.db, USER_A).id, { score: 0.8, components: terms });
    await POST(post(`/api/loops/${only.id}/render`), params({ id: only.id }));
    expect(world.db.rows("corrections")).toHaveLength(0);
  });

  it("writes nothing for a loop the finder never ranked", async () => {
    const file = seedFile(world.db, USER_A);
    rack(file.id);
    const mine = seedLoop(world.db, USER_A, file.id, { start_s: 40, end_s: 48, bars: 4, score: null, origin: "user" });
    await POST(post(`/api/loops/${mine.id}/render`), params({ id: mine.id }));
    expect(world.db.rows("corrections")).toHaveLength(0);
  });

  it("counts one choice once, however many times it is exported", async () => {
    const file = seedFile(world.db, USER_A);
    const { second } = rack(file.id);
    await POST(post(`/api/loops/${second.id}/render`), params({ id: second.id }));
    await POST(post(`/api/loops/${second.id}/render`), params({ id: second.id }));
    expect(world.db.rows("corrections")).toHaveLength(1);

    // and not again once the export has landed in the library
    const row = world.db.find("loops", second.id)!;
    row.render_file_id = seedFile(world.db, USER_A).id;
    await POST(post(`/api/loops/${second.id}/render`), params({ id: second.id }));
    expect(world.db.rows("corrections")).toHaveLength(1);
    expect(world.db.rows("jobs")).toHaveLength(3);
  });
});
