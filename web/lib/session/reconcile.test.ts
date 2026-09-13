// What an edit does to audio that is already scheduled.
//
// Two halves. The first asserts the plan — which lanes the engine is handed,
// which it is not, and which of them have something sounding that stopping
// will interrupt. The second drives the real engine over a fake backend and a
// hand-stepped clock, and lands an edit *inside the 250 ms lookahead window*:
// the exact case where a moved region could be started twice, or started at
// the place it used to be, or silently dropped for the rest of the pass.

import { describe as group, expect, it } from "vitest";
import { moveRegion, setTrackMute, trimTail, type Arrangement } from "./arrangement";
import { SessionEngine, START_LEAD_S } from "./engine";
import { FakeBackend, ManualClock, ManualTicker } from "./fakes";
import { changedRegionIds, describeReconcile, flightWindows, inFlight, NOTHING_TO_DO, planReconcile, touchesFlight } from "./reconcile";
import type { Grid } from "./snap";
import type { SessionRegion, SessionTrack } from "./types";

const FREE: Grid = { tempo: null, snap: "off" };

function track(id: string, partial: Partial<SessionTrack> = {}): SessionTrack {
  return { id, name: id, gain: 1, muted: false, soloed: false, fileId: null, origin: "candidate", provenance: null, ...partial };
}

function region(id: string, partial: Partial<SessionRegion> = {}): SessionRegion {
  return { id, trackId: "drums", sourceId: "drums.wav", startS: 0, durationS: 4, offsetS: 0, gain: 1, ...partial };
}

function song(): Arrangement {
  return {
    tracks: [track("drums"), track("bass")],
    regions: [region("d1", { startS: 0, durationS: 8 }), region("d2", { startS: 32, durationS: 8 }), region("b1", { trackId: "bass", sourceId: "bass.wav", startS: 0, durationS: 40 })],
  };
}

const PLAYING = { playing: true, positionS: 2, lookaheadS: 0.25, loop: null };
const STOPPED = { playing: false, positionS: 0, lookaheadS: 0.25, loop: null };

group("what is already in the audio thread's hands", () => {
  it("is nothing at all when the transport is stopped", () => {
    expect(flightWindows(STOPPED)).toEqual([]);
    expect(inFlight(song().regions, STOPPED)).toEqual([]);
  });

  it("is the playhead out to the lookahead horizon", () => {
    expect(flightWindows(PLAYING)).toEqual([[2, 2.25]]);
    expect(inFlight(song().regions, PLAYING).sort()).toEqual(["b1", "d1"]);
  });

  it("wraps at the end locator, so the top of the loop is in flight at the bottom of it", () => {
    const atTheEnd = { playing: true, positionS: 15.9, lookaheadS: 0.25, loop: { startS: 0, endS: 16 } };
    const windows = flightWindows(atTheEnd);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual([15.9, 16]);
    expect(windows[1]?.[0]).toBe(0);
    expect(windows[1]?.[1]).toBeCloseTo(0.15, 9);
    // d1 runs 0-8: it is not under the playhead at 15.9, but its head is already scheduled
    expect(inFlight([region("d1", { startS: 0, durationS: 8 })], atTheEnd)).toEqual(["d1"]);
  });

  it("does not wrap once the playhead is past the end locator", () => {
    const past = { playing: true, positionS: 20, lookaheadS: 0.25, loop: { startS: 0, endS: 16 } };
    expect(flightWindows(past)).toEqual([[20, 20.25]]);
  });

  it("never claims a whole pass is in flight when the loop is shorter than the lookahead", () => {
    const tiny = { playing: true, positionS: 0.9, lookaheadS: 0.25, loop: { startS: 0, endS: 1 } };
    const windows = flightWindows(tiny);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toEqual([0.9, 1]);
    expect(windows[1]?.[1]).toBeCloseTo(0.15, 9);
    // and never longer than the loop itself, however long the lookahead is
    expect(flightWindows({ playing: true, positionS: 0.05, lookaheadS: 4, loop: { startS: 0, endS: 0.1 } })[1]?.[1]).toBeCloseTo(0.1, 9);
  });
});

group("what changed", () => {
  it("names regions that moved, arrived or went away", () => {
    const before = song();
    expect(changedRegionIds(before, before)).toEqual([]);
    expect(changedRegionIds(before, moveRegion(before, "d2", 64, { grid: FREE }))).toEqual(["d2"]);
    expect(changedRegionIds(before, { ...before, regions: before.regions.filter((r) => r.id !== "b1") })).toEqual(["b1"]);
    expect(changedRegionIds(before, trimTail(before, "d1", 6, { grid: FREE }))).toEqual(["d1"]);
  });

  it("says whether the edit reaches audio the engine has already scheduled", () => {
    const before = song();
    // d2 is at bar 32; the playhead is at 2 s. Nothing of it is in flight.
    expect(touchesFlight(before, moveRegion(before, "d2", 64, { grid: FREE }), PLAYING)).toBe(false);
    // d1 is under the playhead
    expect(touchesFlight(before, trimTail(before, "d1", 6, { grid: FREE }), PLAYING)).toBe(true);
    expect(touchesFlight(before, trimTail(before, "d1", 6, { grid: FREE }), STOPPED)).toBe(false);
  });
});

group("the plan", () => {
  it("does nothing when nothing changed", () => {
    const before = song();
    expect(planReconcile(before, before, PLAYING)).toEqual(NOTHING_TO_DO);
    expect(describeReconcile(NOTHING_TO_DO)).toBe("nothing changed");
  });

  it("hands over only the lane that changed, so a drag on the drums cannot touch the bass", () => {
    const before = song();
    const plan = planReconcile(before, moveRegion(before, "d2", 64, { grid: FREE }), PLAYING);
    expect(plan.lanes.map((l) => l.trackId)).toEqual(["drums"]);
    expect(plan.tracks).toBeNull(); // the lane list itself did not change
    expect(plan.lanes[0]?.regions.map((r) => r.id)).toEqual(["d1", "d2"]);
  });

  it("says when a lane will be interrupted, and names the regions that were only bystanders", () => {
    const before = song();
    // moving d2, which is nowhere near the playhead, still stops the drums lane,
    // because a lane is the smallest thing the engine can replace. d1 is the
    // bystander: it re-joins in progress at the right sample.
    const plan = planReconcile(before, moveRegion(before, "d2", 64, { grid: FREE }), PLAYING);
    expect(plan.interrupts).toBe(true);
    expect(plan.lanes[0]?.bystanders).toEqual(["d1"]);
    expect(describeReconcile(plan)).toContain("re-joined in progress");
  });

  it("interrupts nothing when the lane is silent where the playhead is", () => {
    const before = song();
    const later = { playing: true, positionS: 20, lookaheadS: 0.25, loop: null };
    const plan = planReconcile(before, moveRegion(before, "d2", 64, { grid: FREE }), later);
    expect(plan.interrupts).toBe(false);
    expect(plan.lanes[0]?.bystanders).toEqual([]);
    expect(describeReconcile(plan)).toContain("nothing interrupted");
  });

  it("interrupts nothing at all when the transport is stopped", () => {
    const before = song();
    expect(planReconcile(before, trimTail(before, "d1", 6, { grid: FREE }), STOPPED).interrupts).toBe(false);
  });

  it("moves the mix without handing over any material, so a mute restarts nothing", () => {
    const before = song();
    const plan = planReconcile(before, setTrackMute(before, "drums", true), PLAYING);
    expect(plan.lanes).toEqual([]);
    expect(plan.tracks).not.toBeNull();
    expect(plan.interrupts).toBe(false);
    expect(plan.empty).toBe(false);
  });

  it("reports lanes that arrived and lanes that went away", () => {
    const before = song();
    const added: Arrangement = { tracks: [...before.tracks, track("horns")], regions: [...before.regions, region("h1", { trackId: "horns", sourceId: "horns.wav", startS: 8 })] };
    const plan = planReconcile(before, added, PLAYING);
    expect(plan.added).toEqual(["horns"]);
    expect(plan.lanes.map((l) => l.trackId)).toEqual(["horns"]);

    const removed: Arrangement = { tracks: before.tracks.filter((t) => t.id !== "bass"), regions: before.regions.filter((r) => r.trackId !== "bass") };
    const gone = planReconcile(before, removed, PLAYING);
    expect(gone.removed).toEqual(["bass"]);
    // the lane is not handed material; removing it already stops it
    expect(gone.lanes.map((l) => l.trackId)).toEqual([]);
  });

  it("notices a restack, because the lane list is what carries the order", () => {
    const before = song();
    const restacked: Arrangement = { tracks: [before.tracks[1] as SessionTrack, before.tracks[0] as SessionTrack], regions: before.regions };
    const plan = planReconcile(before, restacked, PLAYING);
    expect(plan.tracks?.map((t) => t.id)).toEqual(["bass", "drums"]);
    expect(plan.lanes).toEqual([]);
    expect(plan.interrupts).toBe(false);
  });
});

// --- against the real engine ---------------------------------------------------

function setup() {
  const clock = new ManualClock(1000);
  const backend = new FakeBackend(clock);
  const ticker = new ManualTicker();
  const engine = new SessionEngine({ backend, ticker, lookaheadS: 0.25 });
  return { clock, backend, ticker, engine };
}

/** Apply a plan the way the provider does: the lane list, then each changed lane. */
function apply(engine: SessionEngine, next: Arrangement, flight: { playing: boolean; positionS: number; lookaheadS?: number; loop?: { startS: number; endS: number } | null }): void {
  const snapshot = engine.snapshot();
  const plan = planReconcile({ tracks: snapshot.tracks, regions: snapshot.regions }, next, flight);
  if (plan.tracks) engine.setTracks(plan.tracks);
  for (const lane of plan.lanes) engine.setTrackRegions(lane.trackId, lane.regions);
}

group("an edit that lands inside the lookahead window", () => {
  it("re-plans the moved region at its new place, once, with the right offset", () => {
    const { clock, backend, ticker, engine } = setup();
    const before: Arrangement = { tracks: [track("drums")], regions: [region("d1", { startS: 0, durationS: 8 })] };
    apply(engine, before, { playing: false, positionS: 0 });
    engine.play();
    ticker.step();
    // d1 has been scheduled for the whole eight seconds
    expect(backend.forRegion("d1")).toHaveLength(1);
    expect(backend.forRegion("d1")[0]?.durationS).toBe(8);

    // two seconds in, drag it a second later. The playhead is at 2, the window
    // is 2 to 2.25, and the region under it is already in the audio thread.
    clock.advance(2 + START_LEAD_S);
    backend.clear();
    const moved = moveRegion(before, "d1", 1, { grid: FREE });
    apply(engine, moved, { playing: true, positionS: engine.position(), lookaheadS: 0.25 });

    expect(backend.stops).toEqual(["drums"]); // only this lane, and not the whole session
    const started = backend.forRegion("d1");
    expect(started).toHaveLength(1);
    const piece = started[0];
    // it joins in progress at the playhead rather than restarting from its head
    expect(piece?.joined).toBe(true);
    expect(piece?.sessionStartS).toBeCloseTo(2, 6);
    // and it plays the right samples: one second into the region, which now
    // starts a second later, is one second of audio
    expect(piece?.offsetS).toBeCloseTo(1, 6);
    expect(piece?.durationS).toBeCloseTo(7, 6);
  });

  it("does not start it twice when the next tick comes round", () => {
    const { clock, backend, ticker, engine } = setup();
    const before: Arrangement = { tracks: [track("drums")], regions: [region("d1", { startS: 0, durationS: 8 })] };
    apply(engine, before, { playing: false, positionS: 0 });
    engine.play();
    ticker.step();
    clock.advance(2 + START_LEAD_S);
    backend.clear();
    apply(engine, moveRegion(before, "d1", 1, { grid: FREE }), { playing: true, positionS: engine.position(), lookaheadS: 0.25 });
    for (let i = 0; i < 10; i++) {
      clock.advance(0.06);
      ticker.step();
    }
    expect(backend.forRegion("d1")).toHaveLength(1);
  });

  it("leaves every other lane's scheduled audio alone", () => {
    const { clock, backend, ticker, engine } = setup();
    const before: Arrangement = {
      tracks: [track("drums"), track("bass")],
      regions: [region("d1", { startS: 0, durationS: 8 }), region("b1", { trackId: "bass", sourceId: "bass.wav", startS: 0, durationS: 8 })],
    };
    apply(engine, before, { playing: false, positionS: 0 });
    engine.play();
    ticker.step();
    clock.advance(2 + START_LEAD_S);
    backend.clear();
    apply(engine, moveRegion(before, "d1", 1, { grid: FREE }), { playing: true, positionS: engine.position(), lookaheadS: 0.25 });
    expect(backend.stops).toEqual(["drums"]);
    expect(backend.forTrack("bass")).toHaveLength(0); // nothing re-started, because nothing changed
  });

  it("a trim of the tail inside the window shortens what is playing without moving it", () => {
    const { clock, backend, ticker, engine } = setup();
    const before: Arrangement = { tracks: [track("drums")], regions: [region("d1", { startS: 0, durationS: 8 })] };
    apply(engine, before, { playing: false, positionS: 0 });
    engine.play();
    ticker.step();
    clock.advance(2 + START_LEAD_S);
    backend.clear();
    apply(engine, trimTail(before, "d1", 4, { grid: FREE }), { playing: true, positionS: engine.position(), lookaheadS: 0.25 });
    const piece = backend.forRegion("d1")[0];
    expect(piece?.offsetS).toBeCloseTo(2, 6); // the same audio it was already playing
    expect(piece?.durationS).toBeCloseTo(2, 6); // stopping two seconds earlier than it would have
  });

  it("an edit beyond the lookahead is scheduled when the playhead reaches it, at its new place", () => {
    const { clock, backend, ticker, engine } = setup();
    const before: Arrangement = { tracks: [track("drums")], regions: [region("d1", { startS: 0, durationS: 1 }), region("d2", { startS: 4, durationS: 1 })] };
    apply(engine, before, { playing: false, positionS: 0 });
    engine.play();
    ticker.step();
    clock.advance(0.5 + START_LEAD_S);
    backend.clear();
    // d2 is three and a half seconds away: nothing of it is in flight
    apply(engine, moveRegion(before, "d2", 2, { grid: FREE }), { playing: true, positionS: engine.position(), lookaheadS: 0.25 });
    expect(backend.forRegion("d2")).toHaveLength(0);
    for (let i = 0; i < 40; i++) {
      clock.advance(0.06);
      ticker.step();
    }
    const started = backend.forRegion("d2");
    expect(started).toHaveLength(1);
    expect(started[0]?.sessionStartS).toBeCloseTo(2, 6);
    expect(started[0]?.joined).toBe(false); // it starts at its own head, on time
  });

  it("muting while playing moves a gain node and stops nothing", () => {
    const { clock, backend, ticker, engine } = setup();
    const before: Arrangement = { tracks: [track("drums")], regions: [region("d1", { startS: 0, durationS: 8 })] };
    apply(engine, before, { playing: false, positionS: 0 });
    engine.play();
    ticker.step();
    clock.advance(2 + START_LEAD_S);
    backend.clear();
    apply(engine, setTrackMute(before, "drums", true), { playing: true, positionS: engine.position(), lookaheadS: 0.25 });
    expect(backend.stops).toEqual([]);
    expect(backend.started).toEqual([]);
    expect(backend.trackGains.get("drums")).toBe(0);
  });
});
