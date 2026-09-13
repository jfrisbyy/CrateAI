import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, post, rawPost, seedFile, seedLayer, seedLayerItem, USER_A, USER_B, type World } from "@/lib/testing";
import type { LayerResponse, LayersListResponse } from "@/lib/api/layers";
import { GET, POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/layers", () => {
  it("lists the layers a file is a lane of", async () => {
    const file = seedFile(world.db, USER_A);
    const layer = seedLayer(world.db, USER_A, { name: "drums over keys" });
    seedLayerItem(world.db, USER_A, layer.id, file.id);
    const { status, body } = await call<LayersListResponse>(GET(get(`/api/layers?file_id=${file.id}`)));
    expect(status).toBe(200);
    expect(body.layers).toHaveLength(1);
    expect(body.layers[0]?.layer.name).toBe("drums over keys");
    expect(body.layers[0]?.items).toHaveLength(1);
  });

  it("shows nothing for another user's file", async () => {
    const theirs = seedFile(world.db, USER_B);
    const layer = seedLayer(world.db, USER_B);
    seedLayerItem(world.db, USER_B, layer.id, theirs.id);
    const { body } = await call<LayersListResponse>(GET(get(`/api/layers?file_id=${theirs.id}`)));
    expect(body.layers).toEqual([]);
  });

  it("400s without a file_id and 401s with no session", async () => {
    expect((await GET(get("/api/layers"))).status).toBe(400);
    world.signOut();
    expect((await GET(get("/api/layers?file_id=00000000-0000-4000-8000-000000000001"))).status).toBe(401);
  });
});

describe("POST /api/layers", () => {
  it("creates a layer with one lane per file, in order", async () => {
    const a = seedFile(world.db, USER_A, { original_filename: "drums.wav" });
    const b = seedFile(world.db, USER_A, { original_filename: "keys.wav" });
    const { status, body } = await call<LayerResponse>(POST(post("/api/layers", { file_ids: [a.id, b.id] })));
    expect(status).toBe(201);
    expect(body.layer.name).toBe("drums + keys");
    expect(body.items.map((i) => i.file_id)).toEqual([a.id, b.id]);
    expect(body.items.map((i) => i.position)).toEqual([0, 1]);
    expect(body.files).toHaveLength(2);
  });

  it("404s when one of the files is another user's, and creates nothing", async () => {
    const mine = seedFile(world.db, USER_A);
    const theirs = seedFile(world.db, USER_B);
    const { status } = await call(POST(post("/api/layers", { file_ids: [mine.id, theirs.id] })));
    expect(status).toBe(404);
    expect(world.db.rows("layers")).toHaveLength(0);
    expect(world.db.rows("layer_items")).toHaveLength(0);
  });

  it("400s an empty or malformed body", async () => {
    expect((await POST(post("/api/layers", { file_ids: [] }))).status).toBe(400);
    expect((await POST(rawPost("/api/layers", "{"))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await POST(post("/api/layers", { file_ids: [file.id] }))).status).toBe(401);
  });
});
