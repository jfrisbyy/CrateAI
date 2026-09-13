import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, params, post, rawPost, seedChop, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { ChopsListResponse } from "@/lib/api/chops";
import type { JobResponse } from "@/lib/api/types";
import { GET, POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/files/[id]/chops", () => {
  it("lists chops in index order with their files", async () => {
    const file = seedFile(world.db, USER_A);
    const chopFile = seedFile(world.db, USER_A, { kind: "chop", original_filename: "chop-002.wav" });
    seedChop(world.db, USER_A, file.id, { index: 1, chop_file_id: chopFile.id });
    seedChop(world.db, USER_A, file.id, { index: 0 });
    const { status, body } = await call<ChopsListResponse>(GET(get(`/api/files/${file.id}/chops`), params({ id: file.id })));
    expect(status).toBe(200);
    expect(body.chops.map((c) => c.index)).toEqual([0, 1]);
    expect(body.chops[1]?.file?.original_filename).toBe("chop-002.wav");
  });

  it("shows nothing for another user's file", async () => {
    const theirs = seedFile(world.db, USER_B);
    seedChop(world.db, USER_B, theirs.id);
    const { body } = await call<ChopsListResponse>(GET(get(`/api/files/${theirs.id}/chops`), params({ id: theirs.id })));
    expect(body.chops).toEqual([]);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await GET(get(`/api/files/${file.id}/chops`), params({ id: file.id }))).status).toBe(401);
  });
});

describe("POST /api/files/[id]/chops", () => {
  it("queues a transient chop", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<JobResponse>(
      POST(post(`/api/files/${file.id}/chops`, { mode: "transients", count: 16, min_gap_ms: 30 }), params({ id: file.id })),
    );
    expect(status).toBe(201);
    expect(body.job.params).toEqual({ mode: "transients", count: 16, min_gap_ms: 30 });
    expect(world.dispatched).toEqual([body.job.id]);
  });

  it("sorts manual markers before queueing", async () => {
    const file = seedFile(world.db, USER_A);
    const { body } = await call<JobResponse>(POST(post(`/api/files/${file.id}/chops`, { mode: "manual", markers_s: [2, 0.5, 1] }), params({ id: file.id })));
    expect(body.job.params).toEqual({ mode: "manual", markers_s: [0.5, 1, 2] });
  });

  it("409s grid chops on a file with no beat grid", async () => {
    const file = seedFile(world.db, USER_A, { report: null, status: "queued" });
    const res = await POST(post(`/api/files/${file.id}/chops`, { mode: "grid", start_bar: 0, end_bar: 3, divisions: 4 }), params({ id: file.id }));
    expect(res.status).toBe(409);
  });

  it("400s markers that are all past the end of the file", async () => {
    const file = seedFile(world.db, USER_A, { duration_s: 5 });
    expect((await POST(post(`/api/files/${file.id}/chops`, { mode: "manual", markers_s: [10, 20] }), params({ id: file.id }))).status).toBe(400);
  });

  it("404s another user's file and queues nothing", async () => {
    const theirs = seedFile(world.db, USER_B);
    const res = await POST(post(`/api/files/${theirs.id}/chops`, { mode: "transients", count: 8, min_gap_ms: 30 }), params({ id: theirs.id }));
    expect(res.status).toBe(404);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("400s an unknown mode, an impossible grid and a malformed body", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await POST(post(`/api/files/${file.id}/chops`, { mode: "vibes" }), params({ id: file.id }))).status).toBe(400);
    const tooMany = await POST(post(`/api/files/${file.id}/chops`, { mode: "grid", start_bar: 0, end_bar: 4096, divisions: 64 }), params({ id: file.id }));
    expect(tooMany.status).toBe(400);
    expect((await POST(rawPost(`/api/files/${file.id}/chops`, "{"), params({ id: file.id }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    const res = await POST(post(`/api/files/${file.id}/chops`, { mode: "transients", count: 8, min_gap_ms: 30 }), params({ id: file.id }));
    expect(res.status).toBe(401);
  });
});
