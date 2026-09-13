import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, seedFile, seedMidi, USER_A, USER_B, type World } from "@/lib/testing";
import type { JobResponse } from "@/lib/api/types";
import type { ExportSongRequest } from "@/lib/export/types";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

function region(fileId: string, over: Partial<ExportSongRequest["song"]["tracks"][number]["regions"][number]> = {}) {
  return {
    id: "r1",
    file_id: fileId,
    start_s: 0,
    duration_s: 8,
    offset_s: 24.13,
    gain: 1,
    rate: 0.964,
    lineage_line: "Masquerade · drums · bars 9–16",
    lineage: null,
    source_bars: null,
    ...over,
  };
}

function body(fileId: string, over: Partial<ExportSongRequest> = {}): ExportSongRequest {
  return {
    song: {
      name: "Midnight Flip",
      bpm: 92,
      beats_per_bar: 4,
      key: { tonic: "F", mode: "minor", from_file_id: fileId, from_file_name: "Masquerade" },
      master_gain: 1,
      tracks: [
        { id: "t1", name: "Drums", position: 0, gain: 0.8, muted: false, soloed: false, provenance: "Masquerade, drums", regions: [region(fileId)] },
      ],
    },
    ...over,
  } as ExportSongRequest;
}

describe("POST /api/export/song", () => {
  it("queues an export job carrying the song and dispatches it", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body: res } = await call<JobResponse>(POST(post("/api/export/song", body(file.id))));
    expect(status).toBe(201);
    expect(res.job.kind).toBe("export");
    expect(res.job.file_id).toBeNull();
    expect(world.dispatched).toEqual([res.job.id]);
    const params = res.job.params as unknown as { song: { tracks: { regions: { file_id: string }[] }[] }; format: string };
    expect(params.format).toBe("flac");
    expect(params.song.tracks[0]!.regions[0]!.file_id).toBe(file.id);
  });

  it("defaults to lossless 24-bit FLAC at 44.1 kHz with muted lanes left out", async () => {
    const file = seedFile(world.db, USER_A);
    const { body: res } = await call<JobResponse>(POST(post("/api/export/song", body(file.id))));
    expect(res.job.params).toMatchObject({ format: "flac", bit_depth: 24, sample_rate: 44100, include_muted: false });
  });

  it("refuses a song that references a record the caller cannot open", async () => {
    const mine = seedFile(world.db, USER_A);
    const theirs = seedFile(world.db, USER_B, { id: "33333333-3333-4333-8333-333333333333" });
    const request = body(mine.id);
    request.song.tracks.push({
      id: "t2", name: "Stolen", position: 1, gain: 1, muted: false, soloed: false, provenance: null,
      regions: [region(theirs.id, { id: "r2" })],
    });
    const { status, body: res } = await call<{ error: string }>(POST(post("/api/export/song", request)));
    expect(status).toBe(404);
    expect(res.error).toContain("cannot open");
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("refuses MIDI the caller cannot open", async () => {
    const file = seedFile(world.db, USER_A);
    const theirMidi = seedMidi(world.db, USER_B, null, { id: "44444444-4444-4444-8444-444444444444" });
    const { status } = await call(POST(post("/api/export/song", body(file.id, { midi_ids: [theirMidi.id] }))));
    expect(status).toBe(404);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("keeps the caller's own MIDI in the job's params", async () => {
    const file = seedFile(world.db, USER_A);
    const midi = seedMidi(world.db, USER_A, file.id);
    const { body: res } = await call<JobResponse>(POST(post("/api/export/song", body(file.id, { midi_ids: [midi.id] }))));
    expect(res.job.params).toMatchObject({ midi_ids: [midi.id] });
  });

  it("409s when every lane is muted", async () => {
    const file = seedFile(world.db, USER_A);
    const request = body(file.id);
    request.song.tracks[0]!.muted = true;
    const { status, body: res } = await call<{ error: string }>(POST(post("/api/export/song", request)));
    expect(status).toBe(409);
    expect(res.error).toContain("muted");
  });

  it("413s a song that would blow the cap, with the arithmetic and something to do", async () => {
    const file = seedFile(world.db, USER_A);
    const request = body(file.id, { format: "wav", bit_depth: 24 });
    request.song.tracks = Array.from({ length: 20 }, (_, i) => ({
      id: `t${i}`, name: `L${i}`, position: i, gain: 1, muted: false, soloed: false, provenance: null,
      regions: [region(file.id, { id: `r${i}`, duration_s: 890 })],
    }));
    const { status, body: res } = await call<{ error: string }>(POST(post("/api/export/song", request)));
    expect(status).toBe(413);
    expect(res.error).toContain("cap is");
    expect(res.error).toContain("FLAC");
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("413s a song longer than the ceiling before looking at anything", async () => {
    const file = seedFile(world.db, USER_A);
    const request = body(file.id);
    request.song.tracks[0]!.regions = [region(file.id, { start_s: 890, duration_s: 100 })];
    const { status, body: res } = await call<{ error: string }>(POST(post("/api/export/song", request)));
    expect(status).toBe(413);
    expect(res.error).toContain("minutes");
  });

  it("400s a song with no lanes", async () => {
    const request = { song: { name: "x", bpm: 92, beats_per_bar: 4, key: null, master_gain: 1, tracks: [] } };
    expect((await call(POST(post("/api/export/song", request)))).status).toBe(400);
  });

  it("400s a region whose file id is not a library id", async () => {
    const request = body("not-a-uuid");
    expect((await call(POST(post("/api/export/song", request)))).status).toBe(400);
  });

  it("400s a region too short to be a sound", async () => {
    const file = seedFile(world.db, USER_A);
    const request = body(file.id);
    request.song.tracks[0]!.regions = [region(file.id, { duration_s: 0.001 })];
    expect((await call(POST(post("/api/export/song", request)))).status).toBe(400);
  });

  it("400s a format the renderer does not write", async () => {
    const file = seedFile(world.db, USER_A);
    const request = { ...body(file.id), format: "mp3" } as unknown as ExportSongRequest;
    expect((await call(POST(post("/api/export/song", request)))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await POST(post("/api/export/song", body(file.id)))).status).toBe(401);
  });

  it("still creates the job when compute is unreachable, so it can be retried", async () => {
    world = createWorld({ compute: false });
    const file = seedFile(world.db, USER_A);
    const { status, body: res } = await call<JobResponse>(POST(post("/api/export/song", body(file.id))));
    expect(status).toBe(201);
    expect(res.dispatch).toEqual({ ok: false, reason: "compute not configured" });
    expect(world.db.rows("jobs")).toHaveLength(1);
  });
});
