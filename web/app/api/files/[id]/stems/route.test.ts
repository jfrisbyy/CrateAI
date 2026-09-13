import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, params, post, rawPost, seedFile, seedJob, seedStem, USER_A, USER_B, type World } from "@/lib/testing";
import type { StemsListResponse } from "@/lib/api/stems";
import type { JobResponse } from "@/lib/api/types";
import { GET, POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/files/[id]/stems", () => {
  it("lists the stems with their files", async () => {
    const file = seedFile(world.db, USER_A);
    const stemFile = seedFile(world.db, USER_A, { kind: "stem", parent_file_id: file.id, original_filename: "drums.wav" });
    seedStem(world.db, USER_A, file.id, stemFile.id);
    const { status, body } = await call<StemsListResponse>(GET(get(`/api/files/${file.id}/stems`), params({ id: file.id })));
    expect(status).toBe(200);
    expect(body.stems).toHaveLength(1);
    expect(body.stems[0]?.file?.original_filename).toBe("drums.wav");
  });

  it("shows nothing for another user's file", async () => {
    const theirs = seedFile(world.db, USER_B);
    seedStem(world.db, USER_B, theirs.id, seedFile(world.db, USER_B).id);
    const { body } = await call<StemsListResponse>(GET(get(`/api/files/${theirs.id}/stems`), params({ id: theirs.id })));
    expect(body.stems).toEqual([]);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await GET(get(`/api/files/${file.id}/stems`), params({ id: file.id }))).status).toBe(401);
  });
});

describe("POST /api/files/[id]/stems", () => {
  it("queues a separation and dispatches it", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<JobResponse>(POST(post(`/api/files/${file.id}/stems`, { model: "htdemucs_ft" }), params({ id: file.id })));
    expect(status).toBe(201);
    expect(body.job).toMatchObject({ kind: "stems", file_id: file.id, user_id: USER_A });
    expect(body.job.params).toEqual({ model: "htdemucs_ft" });
    expect(world.dispatched).toEqual([body.job.id]);
  });

  it("409s a second separation with the same model", async () => {
    const file = seedFile(world.db, USER_A);
    seedJob(world.db, USER_A, { kind: "stems", file_id: file.id, status: "running", params: { model: "htdemucs_ft" } });
    expect((await POST(post(`/api/files/${file.id}/stems`, { model: "htdemucs_ft" }), params({ id: file.id }))).status).toBe(409);
    expect((await POST(post(`/api/files/${file.id}/stems`, { model: "bs_roformer" }), params({ id: file.id }))).status).toBe(201);
  });

  it("409s a file that is still uploading", async () => {
    const file = seedFile(world.db, USER_A, { status: "uploading" });
    expect((await POST(post(`/api/files/${file.id}/stems`, { model: "htdemucs_ft" }), params({ id: file.id }))).status).toBe(409);
  });

  it("404s another user's file and queues nothing", async () => {
    const theirs = seedFile(world.db, USER_B);
    expect((await POST(post(`/api/files/${theirs.id}/stems`, { model: "htdemucs_ft" }), params({ id: theirs.id }))).status).toBe(404);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("400s an unknown model and a malformed body", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await POST(post(`/api/files/${file.id}/stems`, { model: "spleeter" }), params({ id: file.id }))).status).toBe(400);
    expect((await POST(rawPost(`/api/files/${file.id}/stems`, "{"), params({ id: file.id }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await POST(post(`/api/files/${file.id}/stems`, { model: "htdemucs_ft" }), params({ id: file.id }))).status).toBe(401);
  });
});
