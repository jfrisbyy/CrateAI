import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, params, seedFile, seedMidi, seedRevoice, USER_A, USER_B, type World } from "@/lib/testing";
import type { RevoiceResponse } from "@/lib/api/revoice";
import { GET } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/revoices/[id]", () => {
  it("returns the re-voice with its MIDI and its render", async () => {
    const source = seedFile(world.db, USER_A);
    const midi = seedMidi(world.db, USER_A, source.id, { kind: "melody" });
    const render = seedFile(world.db, USER_A, { kind: "revoice_render", original_filename: "piano.wav" });
    const revoice = seedRevoice(world.db, USER_A, source.id, { midi_id: midi.id, render_file_id: render.id });
    const { status, body } = await call<RevoiceResponse>(GET(get(`/api/revoices/${revoice.id}`), params({ id: revoice.id })));
    expect(status).toBe(200);
    expect(body.midi?.id).toBe(midi.id);
    expect(body.render?.original_filename).toBe("piano.wav");
  });

  it("does not follow a reference into another user's rows", async () => {
    const theirMidi = seedMidi(world.db, USER_B, seedFile(world.db, USER_B).id);
    const theirRender = seedFile(world.db, USER_B);
    const revoice = seedRevoice(world.db, USER_A, seedFile(world.db, USER_A).id, { midi_id: theirMidi.id, render_file_id: theirRender.id });
    const { status, body } = await call<RevoiceResponse>(GET(get(`/api/revoices/${revoice.id}`), params({ id: revoice.id })));
    expect(status).toBe(200);
    expect(body.midi).toBeNull();
    expect(body.render).toBeNull();
  });

  it("404s another user's re-voice", async () => {
    const theirs = seedRevoice(world.db, USER_B, seedFile(world.db, USER_B).id);
    expect((await GET(get(`/api/revoices/${theirs.id}`), params({ id: theirs.id }))).status).toBe(404);
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await GET(get("/api/revoices/x"), params({ id: "x" }))).status).toBe(400);
    const revoice = seedRevoice(world.db, USER_A, seedFile(world.db, USER_A).id);
    world.signOut();
    expect((await GET(get(`/api/revoices/${revoice.id}`), params({ id: revoice.id }))).status).toBe(401);
  });
});
