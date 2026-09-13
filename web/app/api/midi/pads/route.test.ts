import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { PadsMidiResponse } from "@/lib/api/midi";
import { POST } from "./route";

let world: World;

const hits = [
  { time_s: 0, pad: 0, chop_file_id: null, velocity: 0.9 },
  { time_s: 0.5, pad: 1, chop_file_id: null, velocity: 0.7 },
];

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/midi/pads", () => {
  it("writes the .mid under the caller's derived prefix and inserts the row", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<PadsMidiResponse>(POST(post("/api/midi/pads", { file_id: file.id, bpm: 92, bars: 2, hits })));
    expect(status).toBe(201);
    expect(body.midi.user_id).toBe(USER_A);
    expect(body.midi.storage_path.startsWith(`derived/${USER_A}/${file.id}/midi/pads-`)).toBe(true);
    expect(world.db.objects.has(body.midi.storage_path)).toBe(true);
    expect(body.midi.download_url).toContain(body.midi.storage_path);
  });

  it("404s another user's file and writes no object", async () => {
    const theirs = seedFile(world.db, USER_B);
    const { status } = await call(POST(post("/api/midi/pads", { file_id: theirs.id, bpm: 92, bars: 2, hits })));
    expect(status).toBe(404);
    expect(world.db.rows("midi")).toHaveLength(0);
    expect([...world.db.objects.keys()].some((p) => p.includes("/midi/pads-"))).toBe(false);
  });

  it("503s without a service-role key, because users cannot write under derived/", async () => {
    world.setServiceRole(false);
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<{ error: string }>(POST(post("/api/midi/pads", { file_id: file.id, bpm: 92, bars: 2, hits })));
    expect(status).toBe(503);
    expect(body.error).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("400s a malformed body", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await POST(rawPost("/api/midi/pads", "{"))).status).toBe(400);
    expect((await POST(post("/api/midi/pads", { file_id: file.id, bpm: 92, bars: 2, hits: [] }))).status).toBe(400);
    expect((await POST(post("/api/midi/pads", { file_id: file.id, bpm: 4000, bars: 2, hits }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await POST(post("/api/midi/pads", { file_id: file.id, bpm: 92, bars: 2, hits }))).status).toBe(401);
  });
});
