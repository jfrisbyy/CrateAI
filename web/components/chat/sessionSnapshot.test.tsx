// Packing the open session for a turn.
//
// The property that matters most here is a negative one: the browser sends
// controls, never measurements. A tempo, a key or a bandwidth in the chat's
// answer has to have come off a report row on the server, so none of them may
// leave through this function.

import { describe, expect, it } from "vitest";
import { editTrack, setBand } from "@/lib/processing/chain";
import type { ProcessingState } from "@/lib/processing/types";
import { fakeRegion, fakeTrack } from "@/lib/chat/fakes";
import type { RackCandidate } from "@/lib/session/rack";
import { buildSessionSnapshot, type SnapshotInput } from "./sessionSnapshot";

const emptyProcessing: ProcessingState = { tracks: {}, master: { limiter: { enabled: false, ceilingDb: -1, releaseMs: 150 }, bypassed: true } };

function input(partial: Partial<SnapshotInput> = {}): SnapshotInput {
  return {
    tracks: [fakeTrack("t1", "Drums", "file-drums")],
    regions: [fakeRegion("r1", "t1", "file-drums")],
    tempo: { bpm: 92, beatsPerBar: 4 },
    playing: false,
    positionS: 0,
    loop: null,
    masterGain: 1,
    snap: "bar",
    selectedRegionId: null,
    undoLabel: null,
    redoLabel: null,
    processing: emptyProcessing,
    focusTrackId: null,
    auditioning: null,
    openFileId: null,
    songName: "Midnight Flip",
    ...partial,
  };
}

const candidate = (rank: number): RackCandidate => ({
  id: `c${rank}`,
  title: "In The Shade — the break",
  kind: "loop",
  audio: { fileId: "file-break", startS: 0, endS: 8, downbeatS: 0.3 },
  reason: "vocal-free, 0.86",
  confidence: 0.86,
  confidenceReason: null,
  measurements: [],
  provenance: { fileId: "file-break", fileName: "In The Shade", parentFileId: null, stem: null, separationModel: null, separationModelLabel: null, startS: 0, endS: 8, kind: "original" },
  peaks: null,
  fileDurationS: 180,
  sourceBpm: 95.4,
  fit: null,
  rank,
});

describe("buildSessionSnapshot", () => {
  it("carries the song, the transport and the producer's own grid", () => {
    const snapshot = buildSessionSnapshot(input({ playing: true, positionS: 4.2, loop: { startS: 0, endS: 10 }, snap: "sixteenth", selectedRegionId: "r1" }));
    expect(snapshot.arrangement.tracks.map((t) => t.name)).toEqual(["Drums"]);
    expect(snapshot.arrangement.regions).toHaveLength(1);
    expect(snapshot.tempo).toEqual({ bpm: 92, beatsPerBar: 4 });
    expect(snapshot.playing).toBe(true);
    expect(snapshot.positionS).toBe(4.2);
    expect(snapshot.loop).toEqual({ startS: 0, endS: 10 });
    expect(snapshot.snap).toBe("sixteenth");
    expect(snapshot.selectedRegionId).toBe("r1");
    expect(snapshot.songName).toBe("Midnight Flip");
  });

  it("sends no measured value of its own: no bpm, key or bandwidth per record", () => {
    const wire = JSON.stringify(buildSessionSnapshot(input()));
    const parsed = JSON.parse(wire) as Record<string, unknown>;
    expect(Object.keys(parsed)).not.toContain("bandwidth");
    expect(Object.keys(parsed)).not.toContain("vitals");
    // the only tempo on the wire is the session's own grid, which is a control
    expect(wire.match(/"bpm"/g) ?? []).toHaveLength(1);
  });

  it("says what each chain reads, in the dock's words, and leaves the empty ones out", () => {
    const withEq = editTrack({ ...emptyProcessing }, "t1", (p) => setBand(p, "lo", { frequency: 250, gainDb: -4, enabled: true }));
    const snapshot = buildSessionSnapshot(input({ processing: withEq }));
    expect(snapshot.chains).toHaveLength(1);
    expect(snapshot.chains[0]?.trackId).toBe("t1");
    expect(snapshot.chains[0]?.line).toContain("250");
    expect(buildSessionSnapshot(input()).chains).toEqual([]);
  });

  it("says whether the limiter is on, in the master strip's words, with no loudness claim", () => {
    expect(buildSessionSnapshot(input()).master).toContain("limiter off");
    const limiting: ProcessingState = { tracks: {}, master: { limiter: { enabled: true, ceilingDb: -1, releaseMs: 150 }, bypassed: false } };
    const line = buildSessionSnapshot(input({ processing: limiting })).master;
    expect(line).toContain("holding peaks at -1 dB");
    expect(line).not.toMatch(/loud|LUFS/i);
  });

  it("reports the candidate that is sounding, and says the rest of the rack is not listed here", () => {
    const snapshot = buildSessionSnapshot(input({ auditioning: candidate(3) }));
    expect(snapshot.rack).toMatchObject({ listed: false, auditioning: 3 });
    expect(snapshot.rack?.rows[0]).toMatchObject({ index: 3, title: "In The Shade — the break", reason: "vocal-free, 0.86" });
  });

  it("has no rack at all when nothing is auditioning", () => {
    expect(buildSessionSnapshot(input()).rack).toBeNull();
  });

  it("only claims the keyboard is reachable on a file's surface", () => {
    expect(buildSessionSnapshot(input()).keyboardOpen).toBe(false);
    expect(buildSessionSnapshot(input({ openFileId: "f1" })).keyboardOpen).toBe(true);
  });

  it("packs an empty session as an empty song rather than as no session", () => {
    const snapshot = buildSessionSnapshot(input({ tracks: [], regions: [], tempo: null }));
    expect(snapshot.arrangement.tracks).toEqual([]);
    expect(snapshot.tempo).toBeNull();
  });

  it("never sends a negative playhead", () => {
    expect(buildSessionSnapshot(input({ positionS: -3 })).positionS).toBe(0);
  });

  it("is a copy, so a later edit in the browser cannot change what was sent", () => {
    const tracks = [fakeTrack("t1", "Drums", "file-drums")];
    const snapshot = buildSessionSnapshot(input({ tracks }));
    tracks.push(fakeTrack("t2", "Horns", "file-horns"));
    expect(snapshot.arrangement.tracks).toHaveLength(1);
  });

  it("produces a snapshot the route's schema accepts", async () => {
    const { sessionSnapshotSchema } = await import("@/lib/chat/surfaces");
    const parsed = sessionSnapshotSchema.safeParse(JSON.parse(JSON.stringify(buildSessionSnapshot(input({ auditioning: candidate(1) })))));
    expect(parsed.success).toBe(true);
  });
});
