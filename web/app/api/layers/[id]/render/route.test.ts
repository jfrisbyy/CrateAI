import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, params, post, seedFile, seedLayer, seedLayerItem, USER_A, USER_B, type World } from "@/lib/testing";
import type { JobResponse } from "@/lib/api/types";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/layers/[id]/render", () => {
  it("queues a layer job carrying only the layer id", async () => {
    const layer = seedLayer(world.db, USER_A);
    seedLayerItem(world.db, USER_A, layer.id, seedFile(world.db, USER_A).id);
    const { status, body } = await call<JobResponse>(POST(post(`/api/layers/${layer.id}/render`), params({ id: layer.id })));
    expect(status).toBe(201);
    expect(body.job).toMatchObject({ kind: "layer", file_id: null });
    expect(body.job.params).toEqual({ layer_id: layer.id });
    expect(world.dispatched).toEqual([body.job.id]);
  });

  it("409s an empty layer and one where every lane is muted", async () => {
    const empty = seedLayer(world.db, USER_A);
    expect((await POST(post(`/api/layers/${empty.id}/render`), params({ id: empty.id }))).status).toBe(409);
    const muted = seedLayer(world.db, USER_A);
    seedLayerItem(world.db, USER_A, muted.id, seedFile(world.db, USER_A).id, { muted: true });
    expect((await POST(post(`/api/layers/${muted.id}/render`), params({ id: muted.id }))).status).toBe(409);
  });

  it("404s another user's layer and queues nothing", async () => {
    const theirs = seedLayer(world.db, USER_B);
    seedLayerItem(world.db, USER_B, theirs.id, seedFile(world.db, USER_B).id);
    expect((await POST(post(`/api/layers/${theirs.id}/render`), params({ id: theirs.id }))).status).toBe(404);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await POST(post("/api/layers/x/render"), params({ id: "x" }))).status).toBe(400);
    const layer = seedLayer(world.db, USER_A);
    world.signOut();
    expect((await POST(post(`/api/layers/${layer.id}/render`), params({ id: layer.id }))).status).toBe(401);
  });
});
