import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { PrepareResponse } from "@/lib/api/types";
import { GB } from "@/lib/billing/limits";
import { POST } from "./route";

let world: World;
const SHA = "a".repeat(64);

const bodyFor = (over: Record<string, unknown> = {}) => ({
  sha256: SHA,
  filename: "break.wav",
  size_bytes: 1024,
  content_type: "audio/wav",
  ...over,
});

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/files/prepare", () => {
  it("returns the storage path for a hash the caller does not have", async () => {
    const { status, body } = await call<PrepareResponse>(POST(post("/api/files/prepare", bodyFor())));
    expect(status).toBe(200);
    expect(body).toEqual({ status: "upload", storage_path: `library/${USER_A}/aa/${SHA}.wav` });
  });

  it("dedupes against the caller's own library", async () => {
    const existing = seedFile(world.db, USER_A, { sha256: SHA });
    const { body } = await call<PrepareResponse>(POST(post("/api/files/prepare", bodyFor())));
    expect(body.status).toBe("exists");
    expect(body.status === "exists" && body.file.id).toBe(existing.id);
  });

  it("does not dedupe against another user's identical upload", async () => {
    seedFile(world.db, USER_B, { sha256: SHA });
    const { body } = await call<PrepareResponse>(POST(post("/api/files/prepare", bodyFor())));
    expect(body.status).toBe("upload");
    expect(body.status === "upload" && body.storage_path.includes(USER_A)).toBe(true);
  });

  it("415s a file that is not audio", async () => {
    const { status } = await call(POST(post("/api/files/prepare", bodyFor({ filename: "notes.txt" }))));
    expect(status).toBe(415);
  });

  it("413s when the storage quota is already used up", async () => {
    seedFile(world.db, USER_A, { size_bytes: 2 * GB, sha256: "b".repeat(64) });
    const { status, body } = await call<{ error: string }>(POST(post("/api/files/prepare", bodyFor({ size_bytes: 1024 }))));
    expect(status).toBe(413);
    expect(body.error).toContain("quota");
  });

  it("400s a malformed body and a bad hash, not 500", async () => {
    expect((await POST(rawPost("/api/files/prepare", "{not json"))).status).toBe(400);
    expect((await POST(post("/api/files/prepare", bodyFor({ sha256: "short" })))).status).toBe(400);
    expect((await POST(post("/api/files/prepare", { filename: "x.wav" }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await POST(post("/api/files/prepare", bodyFor()))).status).toBe(401);
  });
});
