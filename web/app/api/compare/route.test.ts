import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, post, rawPost, seedComparison, seedFile, seedJob, USER_A, USER_B, type World } from "@/lib/testing";
import type { ComparisonGetResponse } from "@/lib/api/compare";
import type { JobResponse } from "@/lib/api/types";
import { GET, POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/compare", () => {
  it("returns the latest comparison for a pair", async () => {
    const a = seedFile(world.db, USER_A);
    const b = seedFile(world.db, USER_A);
    seedComparison(world.db, USER_A, a.id, b.id, { created_at: "2026-09-01T00:00:00.000Z" });
    const latest = seedComparison(world.db, USER_A, a.id, b.id, { created_at: "2026-09-12T00:00:00.000Z" });
    const { status, body } = await call<ComparisonGetResponse>(GET(get(`/api/compare?a=${a.id}&b=${b.id}`)));
    expect(status).toBe(200);
    expect(body.comparison?.id).toBe(latest.id);
  });

  it("returns null for another user's comparison", async () => {
    const a = seedFile(world.db, USER_B);
    const b = seedFile(world.db, USER_B);
    seedComparison(world.db, USER_B, a.id, b.id);
    const { body } = await call<ComparisonGetResponse>(GET(get(`/api/compare?a=${a.id}`)));
    expect(body.comparison).toBeNull();
  });

  it("400s without a valid a and 401s with no session", async () => {
    expect((await GET(get("/api/compare"))).status).toBe(400);
    expect((await GET(get("/api/compare?a=nope"))).status).toBe(400);
    world.signOut();
    expect((await GET(get("/api/compare?a=00000000-0000-4000-8000-000000000001"))).status).toBe(401);
  });
});

describe("POST /api/compare", () => {
  it("queues a compare job on the pair", async () => {
    const a = seedFile(world.db, USER_A);
    const b = seedFile(world.db, USER_A);
    const { status, body } = await call<JobResponse>(POST(post("/api/compare", { file_a_id: a.id, file_b_id: b.id })));
    expect(status).toBe(201);
    expect(body.job).toMatchObject({ kind: "compare", file_id: a.id });
    expect(body.job.params).toEqual({ file_a_id: a.id, file_b_id: b.id });
    expect(world.dispatched).toEqual([body.job.id]);
  });

  it("409s when a file is not analyzed or is not the caller's", async () => {
    const a = seedFile(world.db, USER_A);
    const unanalyzed = seedFile(world.db, USER_A, { report: null });
    expect((await POST(post("/api/compare", { file_a_id: a.id, file_b_id: unanalyzed.id }))).status).toBe(409);

    const theirs = seedFile(world.db, USER_B);
    expect((await POST(post("/api/compare", { file_a_id: a.id, file_b_id: theirs.id }))).status).toBe(409);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("409s the same pair twice", async () => {
    const a = seedFile(world.db, USER_A);
    const b = seedFile(world.db, USER_A);
    seedJob(world.db, USER_A, { kind: "compare", file_id: a.id, status: "queued", params: { file_a_id: a.id, file_b_id: b.id } });
    expect((await POST(post("/api/compare", { file_a_id: a.id, file_b_id: b.id }))).status).toBe(409);
  });

  it("400s the same file twice and a malformed body", async () => {
    const a = seedFile(world.db, USER_A);
    expect((await POST(post("/api/compare", { file_a_id: a.id, file_b_id: a.id }))).status).toBe(400);
    expect((await POST(rawPost("/api/compare", "{"))).status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    const ids = { file_a_id: "00000000-0000-4000-8000-000000000001", file_b_id: "00000000-0000-4000-8000-000000000002" };
    expect((await POST(post("/api/compare", ids))).status).toBe(401);
  });
});
