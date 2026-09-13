import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, del, get, params, patch, rawPost, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { FileResponse } from "@/lib/api/types";
import { DELETE, GET, PATCH } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/files/[id]", () => {
  it("returns the caller's file", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<FileResponse>(GET(get(`/api/files/${file.id}`), params({ id: file.id })));
    expect(status).toBe(200);
    expect(body.file.id).toBe(file.id);
  });

  it("404s another user's file", async () => {
    const theirs = seedFile(world.db, USER_B);
    const { status } = await call(GET(get(`/api/files/${theirs.id}`), params({ id: theirs.id })));
    expect(status).toBe(404);
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await GET(get("/api/files/nope"), params({ id: "nope" }))).status).toBe(400);
    world.signOut();
    const file = seedFile(world.db, USER_A);
    expect((await GET(get(`/api/files/${file.id}`), params({ id: file.id }))).status).toBe(401);
  });
});

describe("PATCH /api/files/[id]", () => {
  it("edits the title and clears it with an empty string", async () => {
    const file = seedFile(world.db, USER_A);
    const named = await call<FileResponse>(PATCH(patch(`/api/files/${file.id}`, { title: "Amen" }), params({ id: file.id })));
    expect(named.body.file.title).toBe("Amen");
    const cleared = await call<FileResponse>(PATCH(patch(`/api/files/${file.id}`, { title: "" }), params({ id: file.id })));
    expect(cleared.body.file.title).toBeNull();
  });

  it("cannot write another user's file", async () => {
    const theirs = seedFile(world.db, USER_B, { title: "theirs" });
    const { status } = await call(PATCH(patch(`/api/files/${theirs.id}`, { title: "mine" }), params({ id: theirs.id })));
    expect(status).toBe(404);
    expect(world.db.find("files", theirs.id)?.title).toBe("theirs");
  });

  it("400s an empty patch and a malformed body", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await PATCH(patch(`/api/files/${file.id}`, {}), params({ id: file.id }))).status).toBe(400);
    expect((await PATCH(rawPost(`/api/files/${file.id}`, "{"), params({ id: file.id }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await PATCH(patch(`/api/files/${file.id}`, { title: "x" }), params({ id: file.id }))).status).toBe(401);
  });
});

describe("DELETE /api/files/[id]", () => {
  it("removes the row and every derived object", async () => {
    const file = seedFile(world.db, USER_A);
    world.db.putObject(`derived/${USER_A}/${file.id}/chops/000.wav`, "chop");
    world.db.putObject(`derived/${USER_A}/${file.id}/midi/drums.mid`, "midi");
    const { status } = await call(DELETE(del(`/api/files/${file.id}`), params({ id: file.id })));
    expect(status).toBe(200);
    expect(world.db.find("files", file.id)).toBeUndefined();
    expect([...world.db.objects.keys()]).toEqual([]);
  });

  it("cannot delete another user's file or its audio", async () => {
    const theirs = seedFile(world.db, USER_B);
    const { status } = await call(DELETE(del(`/api/files/${theirs.id}`), params({ id: theirs.id })));
    expect(status).toBe(404);
    expect(world.db.find("files", theirs.id)).toBeDefined();
    expect(world.db.objects.has(theirs.storage_path)).toBe(true);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await DELETE(del(`/api/files/${file.id}`), params({ id: file.id }))).status).toBe(401);
  });
});
