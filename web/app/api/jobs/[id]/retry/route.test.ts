import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, params, post, seedFile, seedJob, USER_A, USER_B, type World } from "@/lib/testing";
import type { JobResponse } from "@/lib/api/types";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/jobs/[id]/retry", () => {
  it("requeues a failed job, clears the error and dispatches again", async () => {
    const job = seedJob(world.db, USER_A, { status: "failed", error: "boom", finished_at: "2026-09-13T00:00:00.000Z" });
    const { status, body } = await call<JobResponse>(POST(post(`/api/jobs/${job.id}/retry`), params({ id: job.id })));
    expect(status).toBe(200);
    expect(body.job).toMatchObject({ status: "queued", error: null, finished_at: null });
    expect(world.dispatched).toEqual([job.id]);
  });

  it("puts a failed file back in the queue with its analyze job", async () => {
    const file = seedFile(world.db, USER_A, { status: "failed" });
    const job = seedJob(world.db, USER_A, { status: "failed", kind: "analyze", file_id: file.id });
    await POST(post(`/api/jobs/${job.id}/retry`), params({ id: job.id }));
    expect(world.db.find("files", file.id)?.status).toBe("queued");
  });

  it("409s a job that is running or done", async () => {
    const running = seedJob(world.db, USER_A, { status: "running" });
    expect((await POST(post(`/api/jobs/${running.id}/retry`), params({ id: running.id }))).status).toBe(409);
    const done = seedJob(world.db, USER_A, { status: "done" });
    expect((await POST(post(`/api/jobs/${done.id}/retry`), params({ id: done.id }))).status).toBe(409);
  });

  it("404s another user's job and leaves it alone", async () => {
    const theirs = seedJob(world.db, USER_B, { status: "failed", error: "boom" });
    expect((await POST(post(`/api/jobs/${theirs.id}/retry`), params({ id: theirs.id }))).status).toBe(404);
    expect(world.db.find("jobs", theirs.id)).toMatchObject({ status: "failed", error: "boom" });
    expect(world.dispatched).toEqual([]);
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await POST(post("/api/jobs/x/retry"), params({ id: "x" }))).status).toBe(400);
    const job = seedJob(world.db, USER_A, { status: "failed" });
    world.signOut();
    expect((await POST(post(`/api/jobs/${job.id}/retry`), params({ id: job.id }))).status).toBe(401);
  });
});
