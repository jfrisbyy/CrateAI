import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, params, patch, rawPost, seedChop, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { ChopResponse } from "@/lib/api/chops";
import { PATCH } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("PATCH /api/files/[id]/chops/[chopId]", () => {
  it("renames a pad", async () => {
    const file = seedFile(world.db, USER_A);
    const chop = seedChop(world.db, USER_A, file.id);
    const { status, body } = await call<ChopResponse>(
      PATCH(patch(`/api/files/${file.id}/chops/${chop.id}`, { name: "kick" }), params({ id: file.id, chopId: chop.id })),
    );
    expect(status).toBe(200);
    expect(body.chop.name).toBe("kick");
  });

  it("clears the name with an empty string", async () => {
    const file = seedFile(world.db, USER_A);
    const chop = seedChop(world.db, USER_A, file.id, { name: "kick" });
    const { body } = await call<ChopResponse>(PATCH(patch(`/api/files/${file.id}/chops/${chop.id}`, { name: "" }), params({ id: file.id, chopId: chop.id })));
    expect(body.chop.name).toBeNull();
  });

  it("404s a chop that belongs to another file", async () => {
    const file = seedFile(world.db, USER_A);
    const other = seedFile(world.db, USER_A);
    const chop = seedChop(world.db, USER_A, other.id);
    const res = await PATCH(patch(`/api/files/${file.id}/chops/${chop.id}`, { name: "x" }), params({ id: file.id, chopId: chop.id }));
    expect(res.status).toBe(404);
  });

  it("cannot rename another user's chop", async () => {
    const theirs = seedFile(world.db, USER_B);
    const chop = seedChop(world.db, USER_B, theirs.id, { name: "theirs" });
    const res = await PATCH(patch(`/api/files/${theirs.id}/chops/${chop.id}`, { name: "mine" }), params({ id: theirs.id, chopId: chop.id }));
    expect(res.status).toBe(404);
    expect(world.db.find("chops", chop.id)?.name).toBe("theirs");
  });

  it("400s malformed ids and a malformed body", async () => {
    const file = seedFile(world.db, USER_A);
    const chop = seedChop(world.db, USER_A, file.id);
    expect((await PATCH(patch(`/api/files/x/chops/${chop.id}`, { name: "a" }), params({ id: "x", chopId: chop.id }))).status).toBe(400);
    expect((await PATCH(patch(`/api/files/${file.id}/chops/y`, { name: "a" }), params({ id: file.id, chopId: "y" }))).status).toBe(400);
    expect((await PATCH(rawPost(`/api/files/${file.id}/chops/${chop.id}`, "{"), params({ id: file.id, chopId: chop.id }))).status).toBe(400);
    expect((await PATCH(patch(`/api/files/${file.id}/chops/${chop.id}`, {}), params({ id: file.id, chopId: chop.id }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    const chop = seedChop(world.db, USER_A, file.id);
    world.signOut();
    const res = await PATCH(patch(`/api/files/${file.id}/chops/${chop.id}`, { name: "x" }), params({ id: file.id, chopId: chop.id }));
    expect(res.status).toBe(401);
  });
});
