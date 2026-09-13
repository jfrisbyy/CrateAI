import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, params, seedJob, USER_A, USER_B, type World } from "@/lib/testing";
import type { JobResponse } from "@/lib/api/types";
import { GET } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/jobs/[id]", () => {
  it("returns the caller's job", async () => {
    const job = seedJob(world.db, USER_A, { kind: "stems", status: "running", progress: 0.5 });
    const { status, body } = await call<JobResponse>(GET(get(`/api/jobs/${job.id}`), params({ id: job.id })));
    expect(status).toBe(200);
    expect(body.job).toMatchObject({ id: job.id, kind: "stems", progress: 0.5 });
  });

  it("404s another user's job", async () => {
    const theirs = seedJob(world.db, USER_B);
    expect((await GET(get(`/api/jobs/${theirs.id}`), params({ id: theirs.id }))).status).toBe(404);
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await GET(get("/api/jobs/x"), params({ id: "x" }))).status).toBe(400);
    const job = seedJob(world.db, USER_A);
    world.signOut();
    expect((await GET(get(`/api/jobs/${job.id}`), params({ id: job.id }))).status).toBe(401);
  });
});
