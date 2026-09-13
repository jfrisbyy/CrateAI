import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, del, params, patch, rawPost, seedFile, seedLayer, seedLayerItem, USER_A, USER_B, type World } from "@/lib/testing";
import type { LayerItemResponse } from "@/lib/api/layers";
import { DELETE, PATCH } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("PATCH /api/layers/[id]/items/[itemId]", () => {
  it("moves, gains and mutes a lane", async () => {
    const layer = seedLayer(world.db, USER_A);
    const item = seedLayerItem(world.db, USER_A, layer.id, seedFile(world.db, USER_A).id);
    const { status, body } = await call<LayerItemResponse>(
      PATCH(patch(`/api/layers/${layer.id}/items/${item.id}`, { offset_s: 1.25, gain_db: -3, muted: true }), params({ id: layer.id, itemId: item.id })),
    );
    expect(status).toBe(200);
    expect(body.item).toMatchObject({ offset_s: 1.25, gain_db: -3, muted: true });
  });

  it("400s a filter whose high-pass sits above its low-pass", async () => {
    const layer = seedLayer(world.db, USER_A);
    const item = seedLayerItem(world.db, USER_A, layer.id, seedFile(world.db, USER_A).id);
    const res = await PATCH(
      patch(`/api/layers/${layer.id}/items/${item.id}`, { filter: { highpass_hz: 8000, lowpass_hz: 200 } }),
      params({ id: layer.id, itemId: item.id }),
    );
    expect(res.status).toBe(400);
  });

  it("404s a lane from another layer and another user's lane", async () => {
    const layer = seedLayer(world.db, USER_A);
    const otherLayer = seedLayer(world.db, USER_A);
    const item = seedLayerItem(world.db, USER_A, otherLayer.id, seedFile(world.db, USER_A).id);
    const mismatched = await PATCH(patch(`/api/layers/${layer.id}/items/${item.id}`, { gain_db: 1 }), params({ id: layer.id, itemId: item.id }));
    expect(mismatched.status).toBe(404);

    const theirLayer = seedLayer(world.db, USER_B);
    const theirItem = seedLayerItem(world.db, USER_B, theirLayer.id, seedFile(world.db, USER_B).id, { gain_db: 0 });
    const crossUser = await PATCH(patch(`/api/layers/${theirLayer.id}/items/${theirItem.id}`, { gain_db: 9 }), params({ id: theirLayer.id, itemId: theirItem.id }));
    expect(crossUser.status).toBe(404);
    expect(world.db.find("layer_items", theirItem.id)?.gain_db).toBe(0);
  });

  it("400s an empty patch and a malformed body", async () => {
    const layer = seedLayer(world.db, USER_A);
    const item = seedLayerItem(world.db, USER_A, layer.id, seedFile(world.db, USER_A).id);
    expect((await PATCH(patch(`/api/layers/${layer.id}/items/${item.id}`, {}), params({ id: layer.id, itemId: item.id }))).status).toBe(400);
    expect((await PATCH(rawPost(`/api/layers/${layer.id}/items/${item.id}`, "{"), params({ id: layer.id, itemId: item.id }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const layer = seedLayer(world.db, USER_A);
    const item = seedLayerItem(world.db, USER_A, layer.id, seedFile(world.db, USER_A).id);
    world.signOut();
    const res = await PATCH(patch(`/api/layers/${layer.id}/items/${item.id}`, { gain_db: 1 }), params({ id: layer.id, itemId: item.id }));
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/layers/[id]/items/[itemId]", () => {
  it("removes the lane", async () => {
    const layer = seedLayer(world.db, USER_A);
    const item = seedLayerItem(world.db, USER_A, layer.id, seedFile(world.db, USER_A).id);
    expect((await DELETE(del(`/api/layers/${layer.id}/items/${item.id}`), params({ id: layer.id, itemId: item.id }))).status).toBe(200);
    expect(world.db.rows("layer_items")).toHaveLength(0);
  });

  it("404s another user's lane and leaves it in place", async () => {
    const theirLayer = seedLayer(world.db, USER_B);
    const theirItem = seedLayerItem(world.db, USER_B, theirLayer.id, seedFile(world.db, USER_B).id);
    const res = await DELETE(del(`/api/layers/${theirLayer.id}/items/${theirItem.id}`), params({ id: theirLayer.id, itemId: theirItem.id }));
    expect(res.status).toBe(404);
    expect(world.db.rows("layer_items")).toHaveLength(1);
  });

  it("401s with no session", async () => {
    const layer = seedLayer(world.db, USER_A);
    const item = seedLayerItem(world.db, USER_A, layer.id, seedFile(world.db, USER_A).id);
    world.signOut();
    expect((await DELETE(del(`/api/layers/${layer.id}/items/${item.id}`), params({ id: layer.id, itemId: item.id }))).status).toBe(401);
  });
});
