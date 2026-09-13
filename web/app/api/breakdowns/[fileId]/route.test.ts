import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, params, post, rawPost, seedBreakdown, seedFile, seedJob, seedStem, USER_A, USER_B, type World } from "@/lib/testing";
import type { BreakdownGetResponse } from "@/lib/api/breakdown";
import type { JobResponse } from "@/lib/api/types";
import { GET, POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/breakdowns/[fileId]", () => {
  it("returns the latest version, the stems and the pending jobs", async () => {
    const file = seedFile(world.db, USER_A);
    seedBreakdown(world.db, USER_A, file.id, { version: 1 });
    seedBreakdown(world.db, USER_A, file.id, { version: 2 });
    const stemFile = seedFile(world.db, USER_A, { kind: "stem" });
    seedStem(world.db, USER_A, file.id, stemFile.id);
    seedJob(world.db, USER_A, { kind: "breakdown", file_id: file.id, status: "queued" });

    const { status, body } = await call<BreakdownGetResponse>(GET(get(`/api/breakdowns/${file.id}`), params({ fileId: file.id })));
    expect(status).toBe(200);
    expect(body.breakdown?.version).toBe(2);
    expect(body.breakdowns).toHaveLength(1);
    expect(body.stems).toEqual([{ stem: "drums", stem_file_id: stemFile.id }]);
    expect(body.jobs).toHaveLength(1);
  });

  it("returns every version with all=1", async () => {
    const file = seedFile(world.db, USER_A);
    seedBreakdown(world.db, USER_A, file.id, { version: 1 });
    seedBreakdown(world.db, USER_A, file.id, { version: 2 });
    const { body } = await call<BreakdownGetResponse>(GET(get(`/api/breakdowns/${file.id}?all=1`), params({ fileId: file.id })));
    expect(body.breakdowns.map((b) => b.version)).toEqual([2, 1]);
  });

  it("404s another user's file", async () => {
    const theirs = seedFile(world.db, USER_B);
    seedBreakdown(world.db, USER_B, theirs.id);
    expect((await GET(get(`/api/breakdowns/${theirs.id}`), params({ fileId: theirs.id }))).status).toBe(404);
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await GET(get("/api/breakdowns/x"), params({ fileId: "x" }))).status).toBe(400);
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await GET(get(`/api/breakdowns/${file.id}`), params({ fileId: file.id }))).status).toBe(401);
  });
});

describe("POST /api/breakdowns/[fileId]", () => {
  it("queues a breakdown and dispatches it", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<JobResponse>(POST(post(`/api/breakdowns/${file.id}`, {}), params({ fileId: file.id })));
    expect(status).toBe(201);
    expect(body.job).toMatchObject({ kind: "breakdown", file_id: file.id });
    expect(world.dispatched).toEqual([body.job.id]);
  });

  it("carries web_context into the job params", async () => {
    const file = seedFile(world.db, USER_A);
    const { body } = await call<JobResponse>(
      POST(post(`/api/breakdowns/${file.id}`, { web_context: { artist: "Someone" } }), params({ fileId: file.id })),
    );
    expect(body.job.params).toEqual({ web_context: { artist: "Someone" } });
  });

  it("409s while one is already queued, and when analysis failed", async () => {
    const file = seedFile(world.db, USER_A);
    seedJob(world.db, USER_A, { kind: "breakdown", file_id: file.id, status: "running" });
    expect((await POST(post(`/api/breakdowns/${file.id}`, {}), params({ fileId: file.id }))).status).toBe(409);

    const failed = seedFile(world.db, USER_A, { status: "failed" });
    expect((await POST(post(`/api/breakdowns/${failed.id}`, {}), params({ fileId: failed.id }))).status).toBe(409);
  });

  it("404s another user's file and queues nothing", async () => {
    const theirs = seedFile(world.db, USER_B);
    expect((await POST(post(`/api/breakdowns/${theirs.id}`, {}), params({ fileId: theirs.id }))).status).toBe(404);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("400s a malformed body but accepts an empty one", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await POST(rawPost(`/api/breakdowns/${file.id}`, "{"), params({ fileId: file.id }))).status).toBe(400);
    expect((await POST(rawPost(`/api/breakdowns/${file.id}`, ""), params({ fileId: file.id }))).status).toBe(201);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await POST(post(`/api/breakdowns/${file.id}`, {}), params({ fileId: file.id }))).status).toBe(401);
  });
});
