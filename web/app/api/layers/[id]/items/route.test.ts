import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, params, post, rawPost, seedFile, seedLayer, seedLayerItem, USER_A, USER_B, type World } from "@/lib/testing";
import type { LayerItemResponse } from "@/lib/api/layers";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/layers/[id]/items", () => {
  it("adds a lane at the end, at the defaults", async () => {
    const layer = seedLayer(world.db, USER_A);
    const first = seedFile(world.db, USER_A);
    seedLayerItem(world.db, USER_A, layer.id, first.id, { position: 0 });
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<LayerItemResponse>(POST(post(`/api/layers/${layer.id}/items`, { file_id: file.id }), params({ id: layer.id })));
    expect(status).toBe(201);
    expect(body.item).toMatchObject({ position: 1, file_id: file.id, gain_db: 0, offset_s: 0, muted: false });
  });

  it("404s another user's layer and another user's file", async () => {
    const theirLayer = seedLayer(world.db, USER_B);
    const mine = seedFile(world.db, USER_A);
    expect((await POST(post(`/api/layers/${theirLayer.id}/items`, { file_id: mine.id }), params({ id: theirLayer.id }))).status).toBe(404);

    const myLayer = seedLayer(world.db, USER_A);
    const theirFile = seedFile(world.db, USER_B);
    expect((await POST(post(`/api/layers/${myLayer.id}/items`, { file_id: theirFile.id }), params({ id: myLayer.id }))).status).toBe(404);
    expect(world.db.rows("layer_items")).toHaveLength(0);
  });

  it("400s past 16 lanes and on a malformed body", async () => {
    const layer = seedLayer(world.db, USER_A);
    const file = seedFile(world.db, USER_A);
    seedLayerItem(world.db, USER_A, layer.id, file.id, { position: 15 });
    expect((await POST(post(`/api/layers/${layer.id}/items`, { file_id: file.id }), params({ id: layer.id }))).status).toBe(400);
    expect((await POST(rawPost(`/api/layers/${layer.id}/items`, "{"), params({ id: layer.id }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const layer = seedLayer(world.db, USER_A);
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await POST(post(`/api/layers/${layer.id}/items`, { file_id: file.id }), params({ id: layer.id }))).status).toBe(401);
  });
});
