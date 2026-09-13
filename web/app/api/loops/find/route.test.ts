import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { JobResponse } from "@/lib/api/types";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/loops/find", () => {
  it("queues the finder as an analyze job with task find_loops", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<JobResponse>(POST(post("/api/loops/find", { file_id: file.id })));
    expect(status).toBe(201);
    expect(body.job.kind).toBe("analyze");
    expect(body.job.params).toEqual({ task: "find_loops", bars: [1, 2, 4, 8], top_k: 12 });
    expect(world.dispatched).toEqual([body.job.id]);
  });

  it("409s a file that is not analyzed yet", async () => {
    const file = seedFile(world.db, USER_A, { report: null, status: "queued" });
    expect((await POST(post("/api/loops/find", { file_id: file.id }))).status).toBe(409);
  });

  it("404s another user's file", async () => {
    const theirs = seedFile(world.db, USER_B);
    expect((await POST(post("/api/loops/find", { file_id: theirs.id }))).status).toBe(404);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("400s a malformed body", async () => {
    expect((await POST(rawPost("/api/loops/find", "{"))).status).toBe(400);
    expect((await POST(post("/api/loops/find", { file_id: "nope" }))).status).toBe(400);
    const file = seedFile(world.db, USER_A);
    expect((await POST(post("/api/loops/find", { file_id: file.id, bars: [999] }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await POST(post("/api/loops/find", { file_id: "00000000-0000-4000-8000-000000000001" }))).status).toBe(401);
  });
});
