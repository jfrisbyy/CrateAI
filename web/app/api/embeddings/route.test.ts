import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, seedFile, seedJob, USER_A, USER_B, type World } from "@/lib/testing";
import type { JobRow } from "@/lib/types/db";
import { GET, POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/embeddings", () => {
  it("counts the caller's ready files and the ones with no embedding", async () => {
    const embedded = seedFile(world.db, USER_A);
    const missing = seedFile(world.db, USER_A);
    seedFile(world.db, USER_A, { status: "queued" });
    world.db.seed("embeddings", { user_id: USER_A, file_id: embedded.id, model: "clap", vector: [0.1] });
    const { status, body } = await call<{ embedded_count: number; ready_count: number; missing_file_ids: string[] }>(GET());
    expect(status).toBe(200);
    expect(body.ready_count).toBe(2);
    expect(body.embedded_count).toBe(1);
    expect(body.missing_file_ids).toEqual([missing.id]);
  });

  it("does not count another user's files", async () => {
    seedFile(world.db, USER_B);
    const { body } = await call<{ ready_count: number }>(GET());
    expect(body.ready_count).toBe(0);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await GET()).status).toBe(401);
  });
});

describe("POST /api/embeddings", () => {
  it("queues one embed job per ready file without an embedding", async () => {
    const a = seedFile(world.db, USER_A);
    const b = seedFile(world.db, USER_A);
    const { status, body } = await call<{ queued: JobRow[]; skipped: number }>(POST(post("/api/embeddings", {})));
    expect(status).toBe(201);
    expect(body.queued.map((j) => j.file_id).sort()).toEqual([a.id, b.id].sort());
    expect(body.queued.every((j) => j.kind === "embed" && j.user_id === USER_A)).toBe(true);
    expect(world.dispatched).toHaveLength(2);
  });

  it("skips a file that already has an embed job in flight", async () => {
    const file = seedFile(world.db, USER_A);
    seedJob(world.db, USER_A, { kind: "embed", file_id: file.id, status: "running" });
    const { body } = await call<{ queued: JobRow[]; skipped: number }>(POST(post("/api/embeddings", {})));
    expect(body.queued).toEqual([]);
    expect(body.skipped).toBe(1);
  });

  it("ignores file ids that are not the caller's", async () => {
    const theirs = seedFile(world.db, USER_B);
    const { body } = await call<{ queued: JobRow[] }>(POST(post("/api/embeddings", { file_ids: [theirs.id] })));
    expect(body.queued).toEqual([]);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("400s a malformed body", async () => {
    expect((await POST(rawPost("/api/embeddings", "{"))).status).toBe(400);
    expect((await POST(post("/api/embeddings", { file_ids: ["nope"] })))?.status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await POST(post("/api/embeddings", {}))).status).toBe(401);
  });
});
