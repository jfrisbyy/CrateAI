import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, post, rawPost, seedFile, seedLoop, USER_A, USER_B, type World } from "@/lib/testing";
import type { LoopResponse, LoopsListResponse } from "@/lib/api/types";
import { GET, POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/loops", () => {
  it("lists a file's loops, best first", async () => {
    const file = seedFile(world.db, USER_A);
    seedLoop(world.db, USER_A, file.id, { score: 0.2, name: "weak" });
    seedLoop(world.db, USER_A, file.id, { score: 0.9, name: "strong" });
    const { status, body } = await call<LoopsListResponse>(GET(get(`/api/loops?file_id=${file.id}`)));
    expect(status).toBe(200);
    expect(body.loops.map((l) => l.name)).toEqual(["strong", "weak"]);
  });

  it("returns nothing for another user's file", async () => {
    const theirs = seedFile(world.db, USER_B);
    seedLoop(world.db, USER_B, theirs.id);
    const { body } = await call<LoopsListResponse>(GET(get(`/api/loops?file_id=${theirs.id}`)));
    expect(body.loops).toEqual([]);
  });

  it("400s without a file_id and 401s with no session", async () => {
    expect((await GET(get("/api/loops"))).status).toBe(400);
    expect((await GET(get("/api/loops?file_id=nope"))).status).toBe(400);
    world.signOut();
    expect((await GET(get("/api/loops?file_id=00000000-0000-4000-8000-000000000001"))).status).toBe(401);
  });
});

describe("POST /api/loops", () => {
  it("creates a user loop on the caller's file", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<LoopResponse>(POST(post("/api/loops", { file_id: file.id, start_s: 1, end_s: 3, name: "hook" })));
    expect(status).toBe(201);
    expect(body.loop).toMatchObject({ origin: "user", user_id: USER_A, file_id: file.id, start_s: 1, end_s: 3 });
  });

  it("404s another user's file and writes nothing", async () => {
    const theirs = seedFile(world.db, USER_B);
    const { status } = await call(POST(post("/api/loops", { file_id: theirs.id, start_s: 0, end_s: 2 })));
    expect(status).toBe(404);
    expect(world.db.rows("loops")).toHaveLength(0);
  });

  it("400s a loop that ends before it starts or starts past the file", async () => {
    const file = seedFile(world.db, USER_A, { duration_s: 10 });
    expect((await POST(post("/api/loops", { file_id: file.id, start_s: 5, end_s: 2 }))).status).toBe(400);
    expect((await POST(post("/api/loops", { file_id: file.id, start_s: 50, end_s: 60 }))).status).toBe(400);
  });

  it("400s a malformed body", async () => {
    expect((await POST(rawPost("/api/loops", "{"))).status).toBe(400);
    expect((await POST(post("/api/loops", { file_id: "nope", start_s: 0, end_s: 1 }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await POST(post("/api/loops", { file_id: file.id, start_s: 0, end_s: 1 }))).status).toBe(401);
  });
});
