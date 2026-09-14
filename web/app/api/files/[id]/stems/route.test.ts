import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, params, post, rawPost, seedFile, seedJob, seedStem, USER_A, USER_B, type World } from "@/lib/testing";
import type { StemsListResponse } from "@/lib/api/stems";
import { DEFAULT_STEMS } from "@/lib/types/stemModels";
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

// The request names the split, not the model: separation is the irreversible
// step, the registry in analysis/lockedgroove/stems/separate.py is ordered by
// quality, and only the worker knows which checkpoints its image carries. This
// route used to require a model id from a hard-coded list of three, so that
// ordering never ran for a request from the tab.
describe("POST /api/files/[id]/stems — asking for a split", () => {
  const postSplit = (fileId: string, body: unknown) => POST(post(`/api/files/${fileId}/stems`, body), params({ id: fileId }));

  it("takes a split and leaves the model to the worker", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<JobResponse>(postSplit(file.id, { stems: ["vocals", "instrumental"] }));
    expect(status).toBe(201);
    expect(body.job.params).toEqual({ stems: ["vocals", "instrumental"] });
    expect(body.job.params).not.toHaveProperty("model");
  });

  it("defaults to the four-stem split when nothing is asked for", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<JobResponse>(postSplit(file.id, {}));
    expect(status).toBe(201);
    expect(body.job.params).toEqual({ stems: [...DEFAULT_STEMS] });
  });

  it("refuses a split no separator makes, and says which ones it does", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<{ error: string }>(postSplit(file.id, { stems: ["drums", "instrumental"] }));
    expect(status).toBe(400);
    expect(body.error).toContain("drums and instrumental");
    expect(body.error).toContain("vocals and instrumental");
  });

  it("refuses a named model that cannot make the asked-for split", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<{ error: string }>(postSplit(file.id, { model: "bs_roformer", stems: ["drums", "bass", "vocals", "other"] }));
    expect(status).toBe(400);
    expect(body.error).toContain("does not produce");
    expect(body.error).toContain("vocals and instrumental");
  });

  // The bug this test exists for: defaulting the split *and* honouring a named
  // model would queue bs_roformer against a request for drums and bass, which
  // the worker can only refuse. Naming a model means "what that model gives".
  it("takes a bare model to mean that model's own stems", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<JobResponse>(postSplit(file.id, { model: "bs_roformer" }));
    expect(status).toBe(201);
    expect(body.job.params).toEqual({ model: "bs_roformer" });
  });

  it("rejects a model that is not in the registry", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await postSplit(file.id, { model: "kuielab_a_other" })).status).toBe(400);
  });

  it("still offers the weak model by name, because a producer may know why", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await postSplit(file.id, { model: "kuielab_other" })).status).toBe(201);
  });

  it("409s a second request for the same split, whatever order the stems arrive in", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await postSplit(file.id, { stems: ["vocals", "instrumental"] })).status).toBe(201);
    const { status, body } = await call<{ error: string }>(postSplit(file.id, { stems: ["instrumental", "vocals"] }));
    expect(status).toBe(409);
    expect(body.error).toContain("already queued");
  });

  it("lets a different split run alongside one in flight", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await postSplit(file.id, { stems: ["vocals", "instrumental"] })).status).toBe(201);
    expect((await postSplit(file.id, {})).status).toBe(201);
  });

  it("lets a named model run alongside a split, since it is a different ask", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await postSplit(file.id, { stems: ["vocals", "instrumental"] })).status).toBe(201);
    expect((await postSplit(file.id, { model: "bs_roformer" })).status).toBe(201);
  });

  // Jobs queued before this route stopped taking a bare model carry `model` and
  // no `stems`; they must still collide with a new request for the same model.
  it("still de-duplicates against a job queued under the old shape", async () => {
    const file = seedFile(world.db, USER_A);
    seedJob(world.db, USER_A, { file_id: file.id, kind: "stems", status: "running", params: { model: "htdemucs_ft" } });
    expect((await postSplit(file.id, { model: "htdemucs_ft" })).status).toBe(409);
  });
});
