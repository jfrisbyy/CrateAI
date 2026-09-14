// The three tools that reach the producer's own screen, against the in-memory
// doubles. No network, no browser.
//
// The properties under test are the ones the direction document asks for:
// a sentence moves the same control the mouse moves, the reply says it in the
// control's words, a failure is an answer, and the export is a job rather than
// a directive because it is one.

import { describe, expect, it } from "vitest";
import type { ExportSongRequest } from "@/lib/export/types";
import { fakeContext, fakeFile, fakeRegion, fakeSnapshot, fakeTrack, MemoryChatDb } from "./fakes";
import { runTool } from "./handlers";
import type { SessionSnapshot } from "./surfaces";

function ctxWith(snapshot: SessionSnapshot | null, files = [fakeFile({ id: "file-drums" })]) {
  const db = new MemoryChatDb(files);
  return { db, ctx: fakeContext(db, { session: snapshot, sessionFiles: files }) };
}

describe("session_control", () => {
  it("returns a directive carrying the parsed command and the line the control will say", async () => {
    const { ctx } = ctxWith(fakeSnapshot());
    const out = await runTool("session_control", { steps: ["solo the drums", "play"] }, ctx);
    expect(out.is_error).toBe(false);
    expect(out.card).toEqual({
      type: "directive",
      refused: [],
      steps: [
        { said: "solo the drums", bus: "session", command: { kind: "solo", target: "drums", on: true }, line: "soloed drums" },
        { said: "play", bus: "session", command: { kind: "play" }, line: "playing" },
      ],
    });
    expect(out.summary).toBe("soloed drums; playing");
    const text = JSON.parse(out.text) as { moved: Array<{ line: string }>; note: string };
    expect(text.moved.map((m) => m.line)).toEqual(["soloed drums", "playing"]);
    expect(text.note).toContain("Say the lines back as they read");
  });

  it("answers a step it cannot carry out with the control's own refusal, and still does the rest", async () => {
    const { ctx } = ctxWith(fakeSnapshot());
    const out = await runTool("session_control", { steps: ["mute the horns", "play"] }, ctx);
    expect(out.is_error).toBe(false);
    const card = out.card as { steps: unknown[]; refused: Array<{ note: string }> };
    expect(card.steps).toHaveLength(1);
    expect(card.refused[0]?.note).toBe("nothing in the session is called horns.");
    expect(out.summary).toContain("nothing in the session is called horns.");
  });

  it("is an error, with the vocabulary, when no step survives", async () => {
    const { ctx } = ctxWith(fakeSnapshot());
    const out = await runTool("session_control", { steps: ["mute the horns"] }, ctx);
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("nothing in the session is called horns.");
    expect(out.text).toContain("transport:");
    expect(out.card).toBeNull();
  });

  it("says there is no session rather than pretending to move something", async () => {
    const { ctx } = ctxWith(null);
    const out = await runTool("session_control", { steps: ["play"] }, ctx);
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("no session open");
  });

  it("refuses more than eight steps and an empty list at the schema, not in the session", async () => {
    const { ctx } = ctxWith(fakeSnapshot());
    expect((await runTool("session_control", { steps: [] }, ctx)).is_error).toBe(true);
    expect((await runTool("session_control", { steps: Array.from({ length: 9 }, () => "play") }, ctx)).is_error).toBe(true);
  });

  it("cannot be run inside a batch, because a batch's card never reaches the screen", async () => {
    const { ctx } = ctxWith(fakeSnapshot());
    const out = await runTool("batch", { operations: [{ tool: "session_control", input_json: '{"steps":["play"]}' }] }, ctx);
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("cannot contain session_control");
  });
});

describe("a directive survives the wire and the row", () => {
  it("round-trips through the NDJSON protocol as plain JSON, so a stored card renders again", async () => {
    const { encodeEvent, parseEvent } = await import("./protocol");
    const { ctx } = ctxWith(fakeSnapshot({ keyboardOpen: true, openFileId: "f1" }));
    const out = await runTool("session_control", { steps: ["solo the drums", "gate"] }, ctx);
    const line = encodeEvent({ type: "tool_result", id: "t1", name: "session_control", card: out.card, summary: out.summary });
    const back = parseEvent(line.trim());
    expect(back).toEqual({ type: "tool_result", id: "t1", name: "session_control", card: out.card, summary: out.summary });
    // and nothing in it is a function, so messages.tool_calls can hold it
    expect(JSON.parse(JSON.stringify(out.card))).toEqual(out.card);
  });
});

describe("read_session", () => {
  it("reads one bar with its lineage", async () => {
    const { ctx } = ctxWith(fakeSnapshot());
    const out = await runTool("read_session", { bar: 1 }, ctx);
    expect(out.text).toContain("bar 1: Drums (Masquerade, drums)");
    expect(out.card).toMatchObject({ type: "session", lanes: 1, regions: 1, bpm: 92 });
  });

  it("reads the whole session when nothing is named", async () => {
    const { ctx } = ctxWith(fakeSnapshot());
    expect((await runTool("read_session", {}, ctx)).summary).toBe("1 lanes, 1 regions");
  });

  it("says there is no session when there is none", async () => {
    const { ctx } = ctxWith(null);
    expect((await runTool("read_session", { bar: 1 }, ctx)).is_error).toBe(true);
  });
});

describe("export_song", () => {
  it("queues an export job carrying the song, and says what will be in the zip", async () => {
    const { db, ctx } = ctxWith(fakeSnapshot());
    const out = await runTool("export_song", {}, ctx);
    expect(out.is_error).toBe(false);
    expect(db.jobs).toHaveLength(1);
    const job = db.jobs[0];
    expect(job?.kind).toBe("export");
    const params = job?.params as unknown as ExportSongRequest;
    expect(params.format).toBe("flac");
    expect(params.song.name).toBe("Midnight Flip");
    expect(params.song.bpm).toBe(92);
    expect(params.song.tracks).toHaveLength(1);
    expect(params.song.tracks[0]?.regions[0]?.file_id).toBe("file-drums");
    const text = JSON.parse(out.text) as { queued: boolean; zip: string; lanes: number; tempo_map: boolean };
    expect(text.queued).toBe(true);
    expect(text.zip).toContain("Midnight-Flip_92bpm");
    expect(text.lanes).toBe(1);
    expect(text.tempo_map).toBe(true);
    expect(out.card).toMatchObject({ type: "job", kind: "export" });
  });

  it("takes the format and names the lanes it held back", async () => {
    const snapshot = fakeSnapshot({
      arrangement: {
        tracks: [fakeTrack("t1", "Drums", "file-drums"), fakeTrack("t2", "Horns", "file-drums", { muted: true })],
        regions: [fakeRegion("r1", "t1", "file-drums"), fakeRegion("r2", "t2", "file-drums")],
      },
    });
    const { ctx } = ctxWith(snapshot);
    const out = await runTool("export_song", { format: "wav" }, ctx);
    const text = JSON.parse(out.text) as { not_exported: Array<{ name: string; reason: string }> };
    expect(text.not_exported).toEqual([{ name: "Horns", reason: "muted" }]);
  });

  it("refuses an empty timeline before any compute is spent", async () => {
    const { db, ctx } = ctxWith(fakeSnapshot({ arrangement: { tracks: [], regions: [] } }));
    const out = await runTool("export_song", {}, ctx);
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("nothing on the timeline");
    expect(db.jobs).toHaveLength(0);
  });

  it("refuses a song built from a record this library cannot open, and writes no job", async () => {
    const { db, ctx } = ctxWith(fakeSnapshot(), []);
    const out = await runTool("export_song", {}, ctx);
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("not in this library");
    expect(db.jobs).toHaveLength(0);
  });

  it("attributes the key to the record it was measured on", async () => {
    const { db, ctx } = ctxWith(fakeSnapshot());
    await runTool("export_song", {}, ctx);
    const params = db.jobs[0]?.params as unknown as ExportSongRequest;
    expect(params.song.key).toMatchObject({ tonic: "F", mode: "minor" });
  });

  it("writes no key when the record was never analyzed, rather than guessing one", async () => {
    const { db, ctx } = ctxWith(fakeSnapshot(), [fakeFile({ id: "file-drums" }, null)]);
    await runTool("export_song", {}, ctx);
    const params = db.jobs[0]?.params as unknown as ExportSongRequest;
    expect(params.song.key).toBeNull();
  });
});
