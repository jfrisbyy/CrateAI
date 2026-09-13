import { describe, expect, it } from "vitest";
import type { RackRequest } from "@/components/rack/rackEvents";
import type { Arrangement } from "@/lib/session/arrangement";
import { parseSessionCommand } from "@/lib/session/commands";
import type { Rack, RackCandidate } from "@/lib/session/rack";
import type { SessionRegion, SessionTrack } from "@/lib/session/types";
import { applySessionCommand, type CommandEnv } from "./applyCommand";
import type { SessionState } from "./SessionProvider";

// The command line, as the shell runs it. The parser has its own tests
// (lib/session/commands.test.ts); this asserts the other half — that a parsed
// command moves the control it names, and says plainly when it cannot.

function track(id: string, name: string): SessionTrack {
  return { id, name, gain: 1, muted: false, soloed: false, fileId: `${id}-file`, origin: "candidate", provenance: null };
}

function region(id: string, trackId: string, startS: number, durationS: number): SessionRegion {
  return { id, trackId, sourceId: `${trackId}-file`, startS, durationS, offsetS: 0, gain: 1 };
}

interface Calls {
  transport: string[];
  mute: Array<[string, boolean]>;
  solo: Array<[string, boolean]>;
  gain: Array<[string, number]>;
  loops: Array<{ startS: number; endS: number } | null>;
  edits: Array<{ label: string; arrangement: Arrangement }>;
  auditions: Array<RackCandidate | null>;
  commits: RackCandidate[];
  racks: RackRequest[];
  panels: string[];
  zooms: string[];
  songs: number;
  selections: Array<string | null>;
}

function harness(over: Partial<SessionState> = {}, arrangement?: Arrangement) {
  const calls: Calls = {
    transport: [], mute: [], solo: [], gain: [], loops: [], edits: [], auditions: [],
    commits: [], racks: [], panels: [], zooms: [], songs: 0, selections: [],
  };
  let current: Arrangement = arrangement ?? { tracks: [], regions: [] };
  const session = {
    tracks: current.tracks,
    regions: current.regions,
    playing: false,
    loop: null,
    masterGain: 1,
    waiting: [],
    position: () => 0,
    contentEndS: 0,
    tempo: null,
    setTempo: () => {},
    adoptTempo: () => {},
    play: () => calls.transport.push("play"),
    pause: () => calls.transport.push("pause"),
    toggle: () => calls.transport.push("toggle"),
    stop: () => calls.transport.push("stop"),
    seek: () => calls.transport.push("seek"),
    setLoop: (loop: { startS: number; endS: number } | null) => calls.loops.push(loop),
    setMute: (id: string, on: boolean) => calls.mute.push([id, on]),
    setSolo: (id: string, on: boolean) => calls.solo.push([id, on]),
    setGain: () => {},
    nudgeGain: (id: string, db: number) => calls.gain.push([id, db]),
    removeTrack: () => {},
    setMasterGain: () => {},
    auditioning: null,
    audition: async (c: RackCandidate | null) => {
      calls.auditions.push(c);
    },
    commit: async (c: RackCandidate) => {
      calls.commits.push(c);
    },
    corrections: [],
    arrangement: current,
    edit: (next: Arrangement, label: string) => {
      current = next;
      calls.edits.push({ label, arrangement: next });
    },
    undo: () => calls.transport.push("undo"),
    redo: () => calls.transport.push("redo"),
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
    snap: "bar" as const,
    setSnap: (unit: string) => calls.transport.push(`snap:${unit}`),
    selectedRegionId: null,
    selectRegion: (id: string | null) => calls.selections.push(id),
    grid: { tempo: null, snap: "bar" as const },
    warm: () => {},
    decodeStateOf: () => "idle" as const,
    decodeErrorOf: () => null,
    memory: { bytes: 0, maxBytes: 1, overBudget: false },
    error: null,
    clearError: () => {},
    ...over,
  } as unknown as SessionState;

  const env: CommandEnv = {
    session,
    rack: null,
    openFileId: null,
    showSong: () => {
      calls.songs++;
    },
    panel: (action) => calls.panels.push(action),
    openRack: (request) => calls.racks.push(request),
    zoom: (direction) => calls.zooms.push(direction),
  };
  /** Parse and apply in one step, the way the chat does. */
  const say = (text: string, patch: Partial<CommandEnv> = {}) => {
    const command = parseSessionCommand(text);
    if (!command) throw new Error(`"${text}" did not parse as a command`);
    return applySessionCommand(command, { ...env, ...patch });
  };
  return { calls, env, say, current: () => current };
}

function rackOf(candidates: RackCandidate[]): Rack {
  return { id: "r", title: "Rack", method: null, note: null, source: null, candidates, origin: "compat" };
}

function candidate(id: string, title: string, rank: number): RackCandidate {
  return {
    id, title, kind: "file", rank,
    audio: { fileId: `${id}-file`, startS: 0, endS: 4, downbeatS: 0 },
    reason: "because", confidence: 0.8, confidenceReason: null, measurements: [],
    provenance: { fileId: `${id}-file`, fileName: title, startS: 0, endS: 4, kind: "original", stem: null, separationModel: null, separationModelLabel: null, parentFileId: null },
    peaks: null, fileDurationS: 4, sourceBpm: null, fit: null,
  };
}

describe("the transport, by sentence", () => {
  it("plays, pauses and stops", () => {
    const h = harness();
    expect(h.say("play").ok).toBe(true);
    h.say("pause");
    h.say("stop");
    expect(h.calls.transport).toEqual(["play", "pause", "stop"]);
  });

  it("sets the locators in seconds and clears them", () => {
    const h = harness();
    h.say("loop 4s to 12s");
    h.say("loop off");
    expect(h.calls.loops).toEqual([{ startS: 4, endS: 12 }, null]);
  });

  it("refuses bars when nothing has been measured, and moves nothing", () => {
    const h = harness();
    const result = h.say("loop bars 9 to 16");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("no measured tempo");
    expect(h.calls.loops).toEqual([]);
  });

  it("turns bars into seconds once the session has a tempo", () => {
    const h = harness({ tempo: { bpm: 120, beatsPerBar: 4 } });
    expect(h.say("loop bars 1 to 3").ok).toBe(true);
    expect(h.calls.loops).toEqual([{ startS: 0, endS: 4 }]);
  });
});

describe("the mix, by sentence", () => {
  const tracks = [track("t1", "Drums"), track("t2", "Bass")];

  it("resolves a lane by name and moves only that lane", () => {
    const h = harness({ tracks });
    expect(h.say("solo the drums").ok).toBe(true);
    expect(h.calls.solo).toEqual([["t1", true]]);
  });

  it("says what is not there rather than guessing", () => {
    const h = harness({ tracks });
    const result = h.say("mute the horns");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("horns");
    expect(h.calls.mute).toEqual([]);
  });

  it("nudges a fader in decibels", () => {
    const h = harness({ tracks });
    h.say("turn the bass down");
    expect(h.calls.gain).toEqual([["t2", -3]]);
  });

  it("reaches every lane when the sentence means all of them", () => {
    const h = harness({ tracks });
    h.say("unmute everything");
    expect(h.calls.mute).toEqual([["t1", false], ["t2", false]]);
  });
});

describe("the rack, by sentence", () => {
  const rack = rackOf([candidate("a", "First", 1), candidate("b", "Second", 2)]);

  it("auditions the row the sentence names", () => {
    const h = harness();
    const result = h.say("play the second one under this", { rack });
    expect(result.text).toContain("Second");
    expect(h.calls.auditions.map((c) => c?.id)).toEqual(["b"]);
  });

  it("says so when the row is not there", () => {
    const h = harness();
    const result = h.say("play the fifth one", { rack });
    expect(result.ok).toBe(false);
    expect(h.calls.auditions).toEqual([]);
  });

  it("steps to the next row, and stops at the end of the rack", () => {
    const h = harness({ auditioning: rack.candidates[0] });
    expect(h.say("next", { rack }).text).toContain("Second");
    const h2 = harness({ auditioning: rack.candidates[1] });
    expect(h2.say("next", { rack }).ok).toBe(false);
  });

  it("keeps what is auditioning, and refuses when nothing is", () => {
    const c = rack.candidates[0];
    const h = harness({ auditioning: c });
    expect(h.say("keep it", { rack }).text).toContain("First");
    expect(h.calls.commits).toEqual([c]);
    expect(harness().say("keep it").ok).toBe(false);
  });

  it("opens a search rack from a sentence, and refuses a file rack with no file open", () => {
    const h = harness();
    h.say("rack drums");
    expect(h.calls.racks).toEqual([{ source: "search", query: "drums" }]);
    expect(h.say("hear what fits this").ok).toBe(false);
    const withFile = harness();
    withFile.say("hear what fits this", { openFileId: "f1" });
    expect(withFile.calls.racks).toEqual([{ source: "compat", fileId: "f1" }]);
  });
});

describe("the song, by sentence", () => {
  const tracks = [track("t1", "Drums")];
  const arrangement: Arrangement = { tracks, regions: [region("r1", "t1", 0, 8)] };
  const tempo = { bpm: 120, beatsPerBar: 4 };

  it("puts the song on the panel", () => {
    const h = harness();
    h.say("show the song");
    expect(h.calls.songs).toBe(1);
  });

  it("moves a region to a bar, through the same edit the drag uses", () => {
    const h = harness({ tracks, arrangement, tempo, grid: { tempo, snap: "bar" } }, arrangement);
    expect(h.say("move the drums to bar 3").ok).toBe(true);
    expect(h.calls.edits).toHaveLength(1);
    expect(h.current().regions[0].startS).toBe(4);
  });

  it("refuses a bar when the session has no tempo, and changes nothing", () => {
    const h = harness({ tracks, arrangement }, arrangement);
    const result = h.say("move the drums to bar 3");
    expect(result.ok).toBe(false);
    expect(h.calls.edits).toEqual([]);
  });

  it("trims to a length in bars", () => {
    const h = harness({ tracks, arrangement, tempo, grid: { tempo, snap: "bar" } }, arrangement);
    h.say("trim the drums to 1 bar");
    expect(h.current().regions[0].durationS).toBe(2);
  });

  it("duplicates, and the copy lands after the original", () => {
    const h = harness({ tracks, arrangement, tempo, grid: { tempo, snap: "bar" } }, arrangement);
    h.say("duplicate the drums");
    expect(h.current().regions).toHaveLength(2);
  });

  it("deletes the selected region and drops the selection with it", () => {
    const h = harness({ tracks, arrangement, tempo, grid: { tempo, snap: "bar" }, selectedRegionId: "r1" }, arrangement);
    h.say("delete it");
    expect(h.current().regions).toEqual([]);
    expect(h.current().tracks).toEqual(tracks);
    expect(h.calls.selections).toEqual([null]);
  });

  it("names a lane rather than the selection when the sentence does, and takes the whole lane", () => {
    const h = harness({ tracks, arrangement, tempo, grid: { tempo, snap: "bar" } }, arrangement);
    h.say("delete the drums");
    expect(h.current().tracks).toEqual([]);
    expect(h.calls.selections).toEqual([]);
  });

  it("takes a lane out", () => {
    const h = harness({ tracks, arrangement, tempo }, arrangement);
    expect(h.say("remove the drums").ok).toBe(true);
    expect(h.current().tracks).toEqual([]);
  });

  it("will not undo what was never done", () => {
    const h = harness();
    expect(h.say("undo").ok).toBe(false);
    const can = harness({ canUndo: true });
    expect(can.say("undo").ok).toBe(true);
    expect(can.calls.transport).toEqual(["undo"]);
  });

  it("changes the grid and the zoom, and shows the song when it zooms", () => {
    const h = harness();
    h.say("snap to 16ths");
    h.say("zoom in");
    expect(h.calls.transport).toEqual(["snap:sixteenth"]);
    expect(h.calls.zooms).toEqual(["in"]);
    expect(h.calls.songs).toBe(1);
  });

  it("closes and goes back on the panel", () => {
    const h = harness();
    h.say("close the panel");
    h.say("go back");
    expect(h.calls.panels).toEqual(["close", "back"]);
  });
});
