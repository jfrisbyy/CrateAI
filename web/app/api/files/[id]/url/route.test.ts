import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, params, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { SignedUrlResponse } from "@/lib/api/types";
import { SIGNED_URL_TTL_S } from "@/lib/storage/paths";
import { GET } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/files/[id]/url", () => {
  it("signs a 10-minute URL for the caller's own audio", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<SignedUrlResponse>(GET(get(`/api/files/${file.id}/url`), params({ id: file.id })));
    expect(status).toBe(200);
    expect(body.expires_in).toBe(SIGNED_URL_TTL_S);
    expect(body.url).toContain(file.storage_path);
  });

  it("never signs another user's audio", async () => {
    const theirs = seedFile(world.db, USER_B);
    const { status } = await call(GET(get(`/api/files/${theirs.id}/url`), params({ id: theirs.id })));
    expect(status).toBe(404);
  });

  it("404s a row whose audio is not in storage, rather than 500ing", async () => {
    const file = seedFile(world.db, USER_A, { withObject: false, status: "uploading" });
    const { status, body } = await call<{ error: string }>(GET(get(`/api/files/${file.id}/url`), params({ id: file.id })));
    expect(status).toBe(404);
    expect(body.error).toContain("not in storage");
  });

  it("is private and not stored by any cache", async () => {
    const file = seedFile(world.db, USER_A);
    const res = await GET(get(`/api/files/${file.id}/url`), params({ id: file.id }));
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await GET(get("/api/files/x/url"), params({ id: "x" }))).status).toBe(400);
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await GET(get(`/api/files/${file.id}/url`), params({ id: file.id }))).status).toBe(401);
  });
});
