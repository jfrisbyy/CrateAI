import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, params, patch, rawPost, seedMidi, USER_A, USER_B, type World } from "@/lib/testing";
import type { TranscriptionResponse } from "@/lib/api/beatbox";
import { PATCH } from "./route";

let world: World;

const notes = { hits: [{ class: "kick" }, { class: "snare" }, { class: "hat" }], meta: { bpm: 92 } };

beforeEach(() => {
  world = createWorld();
});

describe("PATCH /api/beatbox/transcriptions/[midiId]", () => {
  it("stores the class corrections on the row", async () => {
    const midi = seedMidi(world.db, USER_A, null, { kind: "beatbox", notes });
    const corrections = [{ hit_index: 1, corrected_class: "hat" }];
    const { status, body } = await call<TranscriptionResponse>(
      PATCH(patch(`/api/beatbox/transcriptions/${midi.id}`, { corrections }), params({ midiId: midi.id })),
    );
    expect(status).toBe(200);
    const stored = body.midi.notes as { corrections: unknown; hits: unknown[] };
    expect(stored.corrections).toEqual(corrections);
    expect(stored.hits).toHaveLength(3);
  });

  it("404s a MIDI row that is not a beatbox transcription, and another user's", async () => {
    const drums = seedMidi(world.db, USER_A, null, { kind: "drums", notes });
    expect((await PATCH(patch(`/api/beatbox/transcriptions/${drums.id}`, { corrections: [] }), params({ midiId: drums.id }))).status).toBe(404);

    const theirs = seedMidi(world.db, USER_B, null, { kind: "beatbox", notes });
    const res = await PATCH(patch(`/api/beatbox/transcriptions/${theirs.id}`, { corrections: [{ hit_index: 0, corrected_class: "kick" }] }), params({ midiId: theirs.id }));
    expect(res.status).toBe(404);
    expect(world.db.find("midi", theirs.id)?.notes).toEqual(notes);
  });

  it("400s a hit index past the last hit and a repeated index", async () => {
    const midi = seedMidi(world.db, USER_A, null, { kind: "beatbox", notes });
    const past = await PATCH(patch(`/api/beatbox/transcriptions/${midi.id}`, { corrections: [{ hit_index: 9, corrected_class: "kick" }] }), params({ midiId: midi.id }));
    expect(past.status).toBe(400);
    const twice = await PATCH(
      patch(`/api/beatbox/transcriptions/${midi.id}`, { corrections: [{ hit_index: 0, corrected_class: "kick" }, { hit_index: 0, corrected_class: "hat" }] }),
      params({ midiId: midi.id }),
    );
    expect(twice.status).toBe(400);
  });

  it("400s a malformed body and a malformed id", async () => {
    const midi = seedMidi(world.db, USER_A, null, { kind: "beatbox", notes });
    expect((await PATCH(rawPost(`/api/beatbox/transcriptions/${midi.id}`, "{"), params({ midiId: midi.id }))).status).toBe(400);
    expect((await PATCH(patch("/api/beatbox/transcriptions/x", { corrections: [] }), params({ midiId: "x" }))).status).toBe(400);
    const badClass = await PATCH(patch(`/api/beatbox/transcriptions/${midi.id}`, { corrections: [{ hit_index: 0, corrected_class: "Kick!" }] }), params({ midiId: midi.id }));
    expect(badClass.status).toBe(400);
  });

  it("401s with no session", async () => {
    const midi = seedMidi(world.db, USER_A, null, { kind: "beatbox", notes });
    world.signOut();
    expect((await PATCH(patch(`/api/beatbox/transcriptions/${midi.id}`, { corrections: [] }), params({ midiId: midi.id }))).status).toBe(401);
  });
});
