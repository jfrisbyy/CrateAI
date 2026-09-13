import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, params, seedFile, seedMidi, USER_A, USER_B, type World } from "@/lib/testing";
import type { MidiDownloadResponse } from "@/lib/api/midi";
import { GET } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/midi/[id]/download", () => {
  it("signs the caller's own .mid", async () => {
    const file = seedFile(world.db, USER_A);
    const midi = seedMidi(world.db, USER_A, file.id);
    const { status, body } = await call<MidiDownloadResponse>(GET(get(`/api/midi/${midi.id}/download`), params({ id: midi.id })));
    expect(status).toBe(200);
    expect(body.filename).toBe("drums.mid");
    expect(body.url).toContain(midi.storage_path);
    expect(body.expires_in).toBe(600);
  });

  it("404s a row whose .mid is not in storage, rather than 500ing", async () => {
    const midi = seedMidi(world.db, USER_A, seedFile(world.db, USER_A).id);
    world.db.objects.delete(midi.storage_path);
    const { status, body } = await call<{ error: string }>(GET(get(`/api/midi/${midi.id}/download`), params({ id: midi.id })));
    expect(status).toBe(404);
    expect(body.error).toContain("not in storage");
  });

  it("404s another user's .mid", async () => {
    const theirs = seedMidi(world.db, USER_B, seedFile(world.db, USER_B).id);
    expect((await GET(get(`/api/midi/${theirs.id}/download`), params({ id: theirs.id }))).status).toBe(404);
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await GET(get("/api/midi/x/download"), params({ id: "x" }))).status).toBe(400);
    const midi = seedMidi(world.db, USER_A, seedFile(world.db, USER_A).id);
    world.signOut();
    expect((await GET(get(`/api/midi/${midi.id}/download`), params({ id: midi.id }))).status).toBe(401);
  });
});
