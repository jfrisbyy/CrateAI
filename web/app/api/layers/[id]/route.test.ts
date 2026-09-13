import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, del, get, params, patch, rawPost, seedFile, seedLayer, seedLayerItem, USER_A, USER_B, type World } from "@/lib/testing";
import type { LayerResponse } from "@/lib/api/layers";
import { DELETE, GET, PATCH } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/layers/[id]", () => {
  it("returns the layer with its lanes and their vitals", async () => {
    const file = seedFile(world.db, USER_A);
    const layer = seedLayer(world.db, USER_A);
    seedLayerItem(world.db, USER_A, layer.id, file.id);
    const { status, body } = await call<LayerResponse>(GET(get(`/api/layers/${layer.id}`), params({ id: layer.id })));
    expect(status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.files[0]).toMatchObject({ file_id: file.id, bpm: 92 });
  });

  it("404s another user's layer", async () => {
    const theirs = seedLayer(world.db, USER_B);
    expect((await GET(get(`/api/layers/${theirs.id}`), params({ id: theirs.id }))).status).toBe(404);
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await GET(get("/api/layers/x"), params({ id: "x" }))).status).toBe(400);
    const layer = seedLayer(world.db, USER_A);
    world.signOut();
    expect((await GET(get(`/api/layers/${layer.id}`), params({ id: layer.id }))).status).toBe(401);
  });
});

describe("PATCH /api/layers/[id]", () => {
  it("sets the target tempo and key", async () => {
    const layer = seedLayer(world.db, USER_A);
    const { status, body } = await call<LayerResponse>(
      PATCH(patch(`/api/layers/${layer.id}`, { tempo_bpm: 88, key: { tonic: "A", mode: "minor" } }), params({ id: layer.id })),
    );
    expect(status).toBe(200);
    expect(body.layer.tempo_bpm).toBe(88);
    expect(body.layer.key).toEqual({ tonic: "A", mode: "minor" });
  });

  it("cannot rename another user's layer", async () => {
    const theirs = seedLayer(world.db, USER_B, { name: "theirs" });
    expect((await PATCH(patch(`/api/layers/${theirs.id}`, { name: "mine" }), params({ id: theirs.id }))).status).toBe(404);
    expect(world.db.find("layers", theirs.id)?.name).toBe("theirs");
  });

  it("400s an empty patch, an impossible tempo and a malformed body", async () => {
    const layer = seedLayer(world.db, USER_A);
    expect((await PATCH(patch(`/api/layers/${layer.id}`, {}), params({ id: layer.id }))).status).toBe(400);
    expect((await PATCH(patch(`/api/layers/${layer.id}`, { tempo_bpm: 4000 }), params({ id: layer.id }))).status).toBe(400);
    expect((await PATCH(rawPost(`/api/layers/${layer.id}`, "{"), params({ id: layer.id }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const layer = seedLayer(world.db, USER_A);
    world.signOut();
    expect((await PATCH(patch(`/api/layers/${layer.id}`, { name: "x" }), params({ id: layer.id }))).status).toBe(401);
  });
});

describe("DELETE /api/layers/[id]", () => {
  it("deletes the caller's layer", async () => {
    const layer = seedLayer(world.db, USER_A);
    expect((await DELETE(del(`/api/layers/${layer.id}`), params({ id: layer.id }))).status).toBe(200);
    expect(world.db.rows("layers")).toHaveLength(0);
  });

  it("404s another user's layer and leaves it in place", async () => {
    const theirs = seedLayer(world.db, USER_B);
    expect((await DELETE(del(`/api/layers/${theirs.id}`), params({ id: theirs.id }))).status).toBe(404);
    expect(world.db.rows("layers")).toHaveLength(1);
  });

  it("401s with no session", async () => {
    const layer = seedLayer(world.db, USER_A);
    world.signOut();
    expect((await DELETE(del(`/api/layers/${layer.id}`), params({ id: layer.id }))).status).toBe(401);
  });
});
