import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, params, post, rawPost, seedFile, seedMidi, USER_A, USER_B, type World } from "@/lib/testing";
import type { MidiListResponse } from "@/lib/api/midi";
import type { JobResponse } from "@/lib/api/types";
import { GET, POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/files/[id]/midi", () => {
  it("lists the file's MIDI with a signed download URL each", async () => {
    const file = seedFile(world.db, USER_A);
    const midi = seedMidi(world.db, USER_A, file.id);
    const { status, body } = await call<MidiListResponse>(GET(get(`/api/files/${file.id}/midi`), params({ id: file.id })));
    expect(status).toBe(200);
    expect(body.midi).toHaveLength(1);
    expect(body.midi[0]?.download_url).toContain(midi.storage_path);
    expect(body.midi[0]?.filename).toBe("drums.mid");
  });

  it("shows nothing for another user's file", async () => {
    const theirs = seedFile(world.db, USER_B);
    seedMidi(world.db, USER_B, theirs.id);
    const { body } = await call<MidiListResponse>(GET(get(`/api/files/${theirs.id}/midi`), params({ id: theirs.id })));
    expect(body.midi).toEqual([]);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await GET(get(`/api/files/${file.id}/midi`), params({ id: file.id }))).status).toBe(401);
  });
});

describe("POST /api/files/[id]/midi", () => {
  it("queues the extraction", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<JobResponse>(POST(post(`/api/files/${file.id}/midi`, { kind: "drums" }), params({ id: file.id })));
    expect(status).toBe(201);
    expect(body.job).toMatchObject({ kind: "midi", file_id: file.id });
    expect(body.job.params).toEqual({ kind: "drums" });
    expect(world.dispatched).toEqual([body.job.id]);
  });

  it("409s a file with no report", async () => {
    const file = seedFile(world.db, USER_A, { report: null, status: "queued" });
    expect((await POST(post(`/api/files/${file.id}/midi`, { kind: "drums" }), params({ id: file.id }))).status).toBe(409);
  });

  it("404s another user's file and queues nothing", async () => {
    const theirs = seedFile(world.db, USER_B);
    expect((await POST(post(`/api/files/${theirs.id}/midi`, { kind: "drums" }), params({ id: theirs.id }))).status).toBe(404);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("400s an unknown kind and a malformed body", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await POST(post(`/api/files/${file.id}/midi`, { kind: "bassline" }), params({ id: file.id }))).status).toBe(400);
    expect((await POST(rawPost(`/api/files/${file.id}/midi`, "{"), params({ id: file.id }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await POST(post(`/api/files/${file.id}/midi`, { kind: "drums" }), params({ id: file.id }))).status).toBe(401);
  });
});
