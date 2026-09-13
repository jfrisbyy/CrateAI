import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { FilesListResponse } from "@/lib/api/types";
import { GET } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/files", () => {
  it("lists the caller's files, newest first", async () => {
    seedFile(world.db, USER_A, { original_filename: "old.wav", created_at: "2026-09-01T00:00:00.000Z" });
    seedFile(world.db, USER_A, { original_filename: "new.wav", created_at: "2026-09-12T00:00:00.000Z" });
    const { status, body } = await call<FilesListResponse>(GET(get("/api/files")));
    expect(status).toBe(200);
    expect(body.files.map((f) => f.original_filename)).toEqual(["new.wav", "old.wav"]);
  });

  it("never lists another user's files", async () => {
    seedFile(world.db, USER_B, { original_filename: "theirs.wav" });
    seedFile(world.db, USER_A, { original_filename: "mine.wav" });
    const { body } = await call<FilesListResponse>(GET(get("/api/files")));
    expect(body.files).toHaveLength(1);
    expect(body.files[0]?.user_id).toBe(USER_A);
  });

  it("filters by kind and parent", async () => {
    const parent = seedFile(world.db, USER_A);
    seedFile(world.db, USER_A, { kind: "stem", parent_file_id: parent.id, original_filename: "drums.wav" });
    const byKind = await call<FilesListResponse>(GET(get("/api/files?kind=stem")));
    expect(byKind.body.files.map((f) => f.original_filename)).toEqual(["drums.wav"]);
    const byParent = await call<FilesListResponse>(GET(get(`/api/files?parent=${parent.id}`)));
    expect(byParent.body.files).toHaveLength(1);
  });

  it("400s on an unknown kind or a malformed parent", async () => {
    expect((await GET(get("/api/files?kind=banana"))).status).toBe(400);
    expect((await GET(get("/api/files?parent=not-a-uuid"))).status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await GET(get("/api/files"))).status).toBe(401);
  });
});
