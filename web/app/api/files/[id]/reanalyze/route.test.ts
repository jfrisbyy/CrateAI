import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, params, post, rawPost, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { JobResponse } from "@/lib/api/types";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/files/[id]/reanalyze", () => {
  it("queues analyze at the next version and puts the file back in the queue", async () => {
    const file = seedFile(world.db, USER_A, { analysis_version: 3, status: "ready" });
    const { status, body } = await call<JobResponse>(POST(post(`/api/files/${file.id}/reanalyze`, {}), params({ id: file.id })));
    expect(status).toBe(201);
    expect(body.job.kind).toBe("analyze");
    expect(body.job.params).toEqual({ analysis_version: 4 });
    expect(world.db.find("files", file.id)?.status).toBe("queued");
    expect(world.dispatched).toEqual([body.job.id]);
  });

  it("passes the requested stages through", async () => {
    const file = seedFile(world.db, USER_A);
    const { body } = await call<JobResponse>(POST(post(`/api/files/${file.id}/reanalyze`, { stages: ["tempo", "key"] }), params({ id: file.id })));
    expect(body.job.params).toMatchObject({ stages: ["tempo", "key"] });
  });

  it("404s another user's file and queues nothing", async () => {
    const theirs = seedFile(world.db, USER_B);
    const { status } = await call(POST(post(`/api/files/${theirs.id}/reanalyze`, {}), params({ id: theirs.id })));
    expect(status).toBe(404);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("400s a body that does not validate instead of silently reanalyzing everything", async () => {
    const file = seedFile(world.db, USER_A);
    const { status } = await call(POST(post(`/api/files/${file.id}/reanalyze`, { stages: ["not-a-stage"] }), params({ id: file.id })));
    expect(status).toBe(400);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("400s a body that is not JSON", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await POST(rawPost(`/api/files/${file.id}/reanalyze`, "{oops"), params({ id: file.id }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await POST(post(`/api/files/${file.id}/reanalyze`, {}), params({ id: file.id }))).status).toBe(401);
  });
});
