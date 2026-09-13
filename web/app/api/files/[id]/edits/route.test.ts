import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, params, post, rawPost, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { EditResponse } from "@/lib/api/types";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/files/[id]/edits", () => {
  it("stores the edit and logs the prediction it replaced", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<EditResponse>(
      POST(post(`/api/files/${file.id}/edits`, { field: "tempo_bpm", value: 184 }), params({ id: file.id })),
    );
    expect(status).toBe(200);
    expect(body.file.report?.user_edits.tempo_bpm).toBe(184);
    expect(body.correction.predicted).toBe(92);
    expect(body.correction.corrected).toBe(184);
    expect(body.correction.user_id).toBe(USER_A);
    expect(world.db.rows("corrections")).toHaveLength(1);
  });

  it("cannot edit another user's file and logs nothing", async () => {
    const theirs = seedFile(world.db, USER_B);
    const { status } = await call(POST(post(`/api/files/${theirs.id}/edits`, { field: "tempo_bpm", value: 100 }), params({ id: theirs.id })));
    expect(status).toBe(404);
    expect(world.db.rows("corrections")).toHaveLength(0);
    expect(world.db.find("files", theirs.id)?.report).toMatchObject({ user_edits: { tempo_bpm: null } });
  });

  it("409s a file with no report to attach the edit to", async () => {
    const file = seedFile(world.db, USER_A, { report: null, status: "queued" });
    const { status } = await call(POST(post(`/api/files/${file.id}/edits`, { field: "tempo_bpm", value: 100 }), params({ id: file.id })));
    expect(status).toBe(409);
  });

  it("400s an unknown field, an impossible value and a malformed body", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await POST(post(`/api/files/${file.id}/edits`, { field: "vibe", value: 1 }), params({ id: file.id }))).status).toBe(400);
    expect((await POST(post(`/api/files/${file.id}/edits`, { field: "tempo_bpm", value: -3 }), params({ id: file.id }))).status).toBe(400);
    expect((await POST(rawPost(`/api/files/${file.id}/edits`, "{"), params({ id: file.id }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await POST(post(`/api/files/${file.id}/edits`, { field: "tempo_bpm", value: 100 }), params({ id: file.id }))).status).toBe(401);
  });
});
