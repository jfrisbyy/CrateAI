import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, seedFile, seedMidi, USER_A, USER_B, type World } from "@/lib/testing";
import type { TranscriptionsResponse } from "@/lib/api/beatbox";
import { GET } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/beatbox/transcriptions", () => {
  it("lists the caller's beatbox MIDI with signed download URLs", async () => {
    const midi = seedMidi(world.db, USER_A, null, { kind: "beatbox", storage_path: `derived/${USER_A}/beatbox/take-1.mid` });
    seedMidi(world.db, USER_A, seedFile(world.db, USER_A).id, { kind: "drums" });
    const { status, body } = await call<TranscriptionsResponse>(GET());
    expect(status).toBe(200);
    expect(body.transcriptions).toHaveLength(1);
    expect(body.transcriptions[0]?.midi.id).toBe(midi.id);
    expect(body.transcriptions[0]?.download_url).toContain(midi.storage_path);
  });

  it("never lists another user's", async () => {
    seedMidi(world.db, USER_B, null, { kind: "beatbox", storage_path: `derived/${USER_B}/beatbox/take-1.mid` });
    const { body } = await call<TranscriptionsResponse>(GET());
    expect(body.transcriptions).toEqual([]);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await GET()).status).toBe(401);
  });
});
