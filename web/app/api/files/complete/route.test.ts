import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { CompleteResponse } from "@/lib/api/types";
import { libraryPath } from "@/lib/storage/paths";
import { POST } from "./route";

let world: World;
const SHA = "c".repeat(64);
const path = () => libraryPath(USER_A, SHA, "wav");

const bodyFor = (over: Record<string, unknown> = {}) => ({
  sha256: SHA,
  storage_path: path(),
  original_filename: "break.wav",
  size_bytes: 2048,
  content_type: "audio/wav",
  ...over,
});

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/files/complete", () => {
  it("inserts the file, queues analyze and dispatches it", async () => {
    world.db.putObject(path(), "audio");
    const { status, body } = await call<CompleteResponse>(POST(post("/api/files/complete", bodyFor())));
    expect(status).toBe(201);
    expect(body.file.status).toBe("queued");
    expect(body.file.user_id).toBe(USER_A);
    expect(body.job?.kind).toBe("analyze");
    expect(body.dispatch).toEqual({ ok: true, call_id: "call-1" });
    expect(world.dispatched).toEqual([body.job?.id]);
  });

  it("409s when nothing was uploaded to that path", async () => {
    const { status } = await call(POST(post("/api/files/complete", bodyFor())));
    expect(status).toBe(409);
    expect(world.db.rows("files")).toHaveLength(0);
  });

  it("400s a storage path under another user's prefix", async () => {
    world.db.putObject(libraryPath(USER_B, SHA, "wav"), "audio");
    const { status, body } = await call<{ error: string }>(POST(post("/api/files/complete", bodyFor({ storage_path: libraryPath(USER_B, SHA, "wav") }))));
    expect(status).toBe(400);
    expect(body.error).toContain("storage_path");
    expect(world.db.rows("files")).toHaveLength(0);
  });

  it("returns the existing row when the same upload is completed twice", async () => {
    world.db.putObject(path(), "audio");
    const existing = seedFile(world.db, USER_A, { sha256: SHA, storage_path: path(), withObject: false });
    const { status, body } = await call<CompleteResponse>(POST(post("/api/files/complete", bodyFor())));
    expect(status).toBe(200);
    expect(body.file.id).toBe(existing.id);
    expect(body.job).toBeNull();
    expect(world.db.rows("files")).toHaveLength(1);
  });

  it("415s a filename that is not audio", async () => {
    world.db.putObject(path(), "audio");
    expect((await POST(post("/api/files/complete", bodyFor({ original_filename: "notes.txt" })))).status).toBe(415);
  });

  it("400s a malformed body", async () => {
    expect((await POST(rawPost("/api/files/complete", "nope"))).status).toBe(400);
    expect((await POST(post("/api/files/complete", { sha256: SHA }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await POST(post("/api/files/complete", bodyFor()))).status).toBe(401);
  });
});
