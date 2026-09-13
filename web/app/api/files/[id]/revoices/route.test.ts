import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, params, seedFile, seedMidi, seedRevoice, USER_A, USER_B, type World } from "@/lib/testing";
import type { RevoicesListResponse } from "@/lib/api/revoice";
import { GET } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/files/[id]/revoices", () => {
  it("lists the file's re-voices, newest first, with MIDI and renders", async () => {
    const file = seedFile(world.db, USER_A);
    const midi = seedMidi(world.db, USER_A, file.id, { kind: "melody" });
    seedRevoice(world.db, USER_A, file.id, { midi_id: midi.id, created_at: "2026-09-01T00:00:00.000Z", instrument: "old" });
    seedRevoice(world.db, USER_A, file.id, { created_at: "2026-09-12T00:00:00.000Z", instrument: "new" });
    const { status, body } = await call<RevoicesListResponse>(GET(get(`/api/files/${file.id}/revoices`), params({ id: file.id })));
    expect(status).toBe(200);
    expect(body.revoices.map((r) => r.revoice.instrument)).toEqual(["new", "old"]);
    expect(body.revoices[1]?.midi?.id).toBe(midi.id);
  });

  it("shows nothing for another user's file", async () => {
    const theirs = seedFile(world.db, USER_B);
    seedRevoice(world.db, USER_B, theirs.id);
    const { body } = await call<RevoicesListResponse>(GET(get(`/api/files/${theirs.id}/revoices`), params({ id: theirs.id })));
    expect(body.revoices).toEqual([]);
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await GET(get("/api/files/x/revoices"), params({ id: "x" }))).status).toBe(400);
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await GET(get(`/api/files/${file.id}/revoices`), params({ id: file.id }))).status).toBe(401);
  });
});
