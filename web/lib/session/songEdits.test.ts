// The loop the shell actually runs: an edit becomes a reconcile plan, the plan
// becomes engine calls, and the edit goes on the undo stack.
//
// The provider that does this in the browser is thin on purpose, but the
// composition is where a mistake would hide — an undo that puts the region
// back in the state but not in the engine, a run of nudges that fills the
// stack, a committed lane that undo cannot remove. So the composition is
// modelled here, over the real engine and a fake backend.

import { describe as group, expect, it } from "vitest";
import {
  arrangementOf,
  duplicateRegion,
  ephemeralOf,
  moveRegion,
  nudgeRegion,
  sameArrangement,
  trimHead,
  type Arrangement,
} from "./arrangement";
import { SessionEngine, START_LEAD_S } from "./engine";
import { FakeBackend, ManualClock, ManualTicker } from "./fakes";
import { canUndo, initHistory, present, record, redo, undo, type History } from "./history";
import { planReconcile } from "./reconcile";
import type { Grid } from "./snap";
import type { SessionTempo } from "./time";
import type { SessionRegion, SessionTrack } from "./types";

const NINETY: SessionTempo = { bpm: 90, beatsPerBar: 4 };
const BAR = (60 / 90) * 4;
const BARS: Grid = { tempo: NINETY, snap: "bar" };

function track(id: string, partial: Partial<SessionTrack> = {}): SessionTrack {
  return { id, name: id, gain: 1, muted: false, soloed: false, fileId: null, origin: "candidate", provenance: null, ...partial };
}

function region(id: string, partial: Partial<SessionRegion> = {}): SessionRegion {
  return { id, trackId: "drums", sourceId: "drums.wav", startS: 0, durationS: BAR * 4, offsetS: 8, gain: 1, ...partial };
}

/** The shell's edit loop, with the same calls in the same order. */
class Song {
  readonly clock = new ManualClock(1000);
  readonly backend = new FakeBackend(this.clock);
  readonly ticker = new ManualTicker();
  readonly engine = new SessionEngine({ backend: this.backend, ticker: this.ticker, lookaheadS: 0.25 });
  history: History<Arrangement>;

  constructor(initial: Arrangement) {
    this.history = initHistory(initial, "empty");
    this.apply(initial);
    this.history = record(this.history, initial, "opened", { at: 0 });
  }

  get arrangement(): Arrangement {
    return arrangementOf(this.engine.snapshot());
  }

  private apply(next: Arrangement): void {
    const live = this.engine.snapshot();
    const plan = planReconcile(arrangementOf(live), next, { playing: live.transport.playing, positionS: this.engine.position(), loop: live.transport.loop });
    if (plan.empty) return;
    if (plan.tracks) this.engine.setTracks([...plan.tracks, ...ephemeralOf(live).tracks]);
    for (const lane of plan.lanes) this.engine.setTrackRegions(lane.trackId, lane.regions);
  }

  edit(next: Arrangement, label: string, options: { coalesceKey?: string; at?: number } = {}): void {
    if (sameArrangement(present(this.history), next)) return;
    this.apply(next);
    this.history = record(this.history, next, label, { coalesceKey: options.coalesceKey ?? null, at: options.at ?? 0 });
  }

  undo(): void {
    if (!canUndo(this.history)) return;
    this.history = undo(this.history);
    this.apply(present(this.history));
  }

  redo(): void {
    this.history = redo(this.history);
    this.apply(present(this.history));
  }
}

function newSong(): Song {
  return new Song({ tracks: [track("drums"), track("bass")], regions: [region("d1"), region("b1", { trackId: "bass", sourceId: "bass.wav", durationS: BAR * 8 })] });
}

group("an edit reaches the engine and the stack together", () => {
  it("moves a region, and the engine is handed that lane and only that lane", () => {
    const song = newSong();
    song.backend.clear();
    song.edit(moveRegion(song.arrangement, "d1", BAR * 16, { grid: BARS }), "move");
    expect(song.arrangement.regions.find((r) => r.id === "d1")?.startS).toBeCloseTo(BAR * 16, 9);
    expect(song.backend.stops).toEqual(["drums"]);
  });

  it("puts it back exactly where it was, in the state and in the engine", () => {
    const song = newSong();
    const before = song.arrangement;
    song.edit(moveRegion(before, "d1", BAR * 16, { grid: BARS }), "move");
    song.undo();
    expect(sameArrangement(song.arrangement, before)).toBe(true);
    expect(song.engine.regionsOf("drums")[0]?.startS).toBe(0);
  });

  it("redoes it", () => {
    const song = newSong();
    song.edit(moveRegion(song.arrangement, "d1", BAR * 16, { grid: BARS }), "move");
    song.undo();
    song.redo();
    expect(song.arrangement.regions.find((r) => r.id === "d1")?.startS).toBeCloseTo(BAR * 16, 9);
  });

  it("undoes a head trim back to the same three numbers, not just the same start", () => {
    const song = newSong();
    const before = song.arrangement.regions.find((r) => r.id === "d1") as SessionRegion;
    song.edit(trimHead(song.arrangement, "d1", BAR, { grid: BARS }), "trim the start");
    const trimmed = song.arrangement.regions.find((r) => r.id === "d1") as SessionRegion;
    expect(trimmed.offsetS).toBeCloseTo(before.offsetS + BAR, 9);
    song.undo();
    const back = song.arrangement.regions.find((r) => r.id === "d1") as SessionRegion;
    expect(back.startS).toBe(before.startS);
    expect(back.offsetS).toBe(before.offsetS);
    expect(back.durationS).toBe(before.durationS);
  });

  it("records nothing when the drag ended where it started", () => {
    const song = newSong();
    const depth = song.history.past.length;
    song.edit(moveRegion(song.arrangement, "d1", 0, { grid: BARS }), "move");
    expect(song.history.past.length).toBe(depth);
  });

  it("collapses a run of arrow presses into one step", () => {
    const song = newSong();
    const before = song.arrangement;
    let at = 0;
    for (let i = 0; i < 8; i++) {
      at += 60;
      song.edit(nudgeRegion(song.arrangement, "d1", 1, { grid: BARS }), "nudge", { coalesceKey: "nudge:d1", at });
    }
    expect(song.arrangement.regions.find((r) => r.id === "d1")?.startS).toBeCloseTo(BAR * 8, 6);
    song.undo();
    expect(sameArrangement(song.arrangement, before)).toBe(true);
  });

  it("undoes a lane that was committed from the rack", () => {
    const song = newSong();
    const before = song.arrangement;
    const withHorns: Arrangement = {
      tracks: [...before.tracks, track("horns")],
      regions: [...before.regions, region("h1", { trackId: "horns", sourceId: "horns.wav", startS: BAR * 8 })],
    };
    song.edit(withHorns, "keep Horns");
    expect(song.arrangement.tracks.map((t) => t.id)).toEqual(["drums", "bass", "horns"]);
    song.undo();
    expect(song.arrangement.tracks.map((t) => t.id)).toEqual(["drums", "bass"]);
    expect(song.arrangement.regions.some((r) => r.id === "h1")).toBe(false);
    expect(song.engine.regionsOf("horns")).toEqual([]);
  });
});

group("editing while it is playing", () => {
  it("keeps the transport running through a whole run of edits", () => {
    const song = newSong();
    song.engine.play();
    song.ticker.step();
    song.clock.advance(1 + START_LEAD_S);
    song.backend.clear();

    song.edit(moveRegion(song.arrangement, "d1", BAR * 2, { grid: BARS }), "move");
    song.edit(duplicateRegion(song.arrangement, "d1", { grid: BARS }), "duplicate");
    song.edit(trimHead(song.arrangement, "d1", BAR * 3, { grid: BARS }), "trim the start");

    expect(song.engine.isPlaying).toBe(true);
    // never the whole session: only the lane that was edited
    expect(song.backend.stops.every((s) => s === "drums")).toBe(true);
    expect(song.backend.forTrack("bass")).toHaveLength(0);
  });

  it("plays the new material on this pass rather than waiting for the next", () => {
    const song = newSong();
    song.engine.play();
    song.ticker.step();
    song.clock.advance(0.5 + START_LEAD_S);
    song.backend.clear();
    // duplicate lands a copy at bar 5, which is seconds away; walk up to it
    song.edit(duplicateRegion(song.arrangement, "d1", { grid: BARS }), "duplicate");
    for (let i = 0; i < 200; i++) {
      song.clock.advance(0.06);
      song.ticker.step();
    }
    const copy = song.arrangement.regions.find((r) => r.id === "d1~2") as SessionRegion;
    const started = song.backend.forRegion("d1~2");
    expect(started).toHaveLength(1);
    expect(started[0]?.sessionStartS).toBeCloseTo(copy.startS, 6);
    expect(started[0]?.offsetS).toBe(copy.offsetS); // the copy plays the same audio
  });
});
