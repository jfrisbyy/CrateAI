import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, seedFile, seedUsageEvent, USER_A, USER_B, type World } from "@/lib/testing";
import type { JobResponse } from "@/lib/api/types";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/jobs", () => {
  it("creates the job for the caller and dispatches it", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<JobResponse>(POST(post("/api/jobs", { kind: "chop", file_id: file.id, params: { mode: "transients" } })));
    expect(status).toBe(201);
    expect(body.job).toMatchObject({ kind: "chop", status: "queued", user_id: USER_A, file_id: file.id });
    expect(body.dispatch).toEqual({ ok: true, call_id: "call-1" });
    expect(world.dispatched).toEqual([body.job.id]);
  });

  it("404s a file the caller does not own and queues nothing", async () => {
    const theirs = seedFile(world.db, USER_B);
    const { status } = await call(POST(post("/api/jobs", { kind: "stems", file_id: theirs.id, params: { model: "htdemucs_ft" } })));
    expect(status).toBe(404);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("refuses a job over the plan's stem quota and never calls compute", async () => {
    const file = seedFile(world.db, USER_A);
    seedUsageEvent(world.db, USER_A, { kind: "stem_job", amount: 5 });
    const { status, body } = await call<JobResponse>(POST(post("/api/jobs", { kind: "stems", file_id: file.id, params: { model: "htdemucs_ft" } })));
    expect(status).toBe(201);
    expect(body.dispatch).toMatchObject({ ok: false });
    expect(body.dispatch && "reason" in body.dispatch && body.dispatch.reason).toContain("quota");
    expect(world.dispatched).toEqual([]);
    expect(world.db.find("jobs", body.job.id)).toMatchObject({ status: "failed" });
  });

  it("counts another user's usage separately", async () => {
    const file = seedFile(world.db, USER_A);
    seedUsageEvent(world.db, USER_B, { kind: "stem_job", amount: 500 });
    const { body } = await call<JobResponse>(POST(post("/api/jobs", { kind: "stems", file_id: file.id, params: { model: "htdemucs_ft" } })));
    expect(body.dispatch).toEqual({ ok: true, call_id: "call-1" });
  });

  it("400s an unknown kind, a bad file id and a malformed body", async () => {
    expect((await POST(post("/api/jobs", { kind: "transcode" }))).status).toBe(400);
    expect((await POST(post("/api/jobs", { kind: "analyze", file_id: "nope" }))).status).toBe(400);
    expect((await POST(rawPost("/api/jobs", "{"))).status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await POST(post("/api/jobs", { kind: "analyze" }))).status).toBe(401);
  });
});
