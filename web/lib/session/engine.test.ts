// The engine, driven by a clock and a ticker the test steps by hand. Every
// case here is one a producer would notice in a session: a repeat that drifts,
// a mute that restarts the drums, an A/B that stops the song, a lane that never
// arrives because its audio was still decoding when the bar came round.

import { describe as group, expect, it } from "vitest";
import { SessionEngine, START_LEAD_S } from "./engine";
import { FakeBackend, ManualClock, ManualTicker } from "./fakes";
import type { SessionRegion, SessionTrack } from "./types";

function track(id: string, partial: Partial<SessionTrack> = {}): SessionTrack {
  return { id, name: id, gain: 1, muted: false, soloed: false, fileId: null, origin: "file", provenance: null, ...partial };
}

function region(id: string, partial: Partial<SessionRegion> = {}): SessionRegion {
  return { id, trackId: "drums", sourceId: "drums.wav", startS: 0, durationS: 4, offsetS: 0, gain: 1, ...partial };
}

function setup(options: { loop?: { startS: number; endS: number } | null } = {}) {
  const clock = new ManualClock(1000);
  const backend = new FakeBackend(clock);
  const ticker = new ManualTicker();
  const engine = new SessionEngine({ backend, ticker, lookaheadS: 0.25 });
  if (options.loop !== undefined) engine.setLoop(options.loop);
  return { clock, backend, ticker, engine };
}

/** Run the transport forward exactly `seconds`, ticking every 60 ms the way the interval does. */
function run(clock: ManualClock, ticker: ManualTicker, seconds: number, stepMs = 60): void {
  const step = stepMs / 1000;
  let left = seconds;
  while (left > 1e-9) {
    const dt = Math.min(step, left);
    clock.advance(dt);
    ticker.step();
    left -= dt;
  }
}

group("transport", () => {
  it("starts stopped at zero and derives the playhead from the clock", () => {
    const { clock, engine } = setup();
    expect(engine.isPlaying).toBe(false);
    expect(engine.position()).toBe(0);
    engine.play();
    expect(engine.isPlaying).toBe(true);
    clock.advance(1 + START_LEAD_S);
    expect(engine.position()).toBeCloseTo(1, 9);
    clock.advance(2);
    expect(engine.position()).toBeCloseTo(3, 9);
  });

  it("pauses where it is and resumes from there", () => {
    const { clock, engine, backend } = setup();
    engine.play();
    clock.advance(2 + START_LEAD_S);
    engine.pause();
    expect(backend.stops).toContain("*");
    expect(engine.position()).toBeCloseTo(2, 9);
    clock.advance(10); // the clock runs on; the paused playhead does not
    expect(engine.position()).toBeCloseTo(2, 9);
    engine.play();
    clock.advance(1 + START_LEAD_S);
    expect(engine.position()).toBeCloseTo(3, 9);
  });

  it("stop returns to the loop start, or to zero without one", () => {
    const { clock, engine } = setup();
    engine.play();
    clock.advance(5);
    engine.stop();
    expect(engine.position()).toBe(0);
    engine.setLoop({ startS: 8, endS: 12 });
    engine.play();
    clock.advance(1);
    engine.stop();
    expect(engine.position()).toBe(8);
  });

  it("seeks while playing without stopping the transport", () => {
    const { clock, engine, backend } = setup();
    engine.setTracks([track("drums")]);
    engine.setTrackRegions("drums", [region("r", { durationS: 60 })]);
    engine.play();
    clock.advance(1);
    backend.clear();
    engine.seek(30);
    expect(engine.isPlaying).toBe(true);
    expect(backend.stops).toContain("*"); // the old sources go
    expect(backend.started).toHaveLength(1); // and the new position is scheduled at once
    expect(backend.started[0]?.offsetS).toBeCloseTo(30, 6);
    expect(backend.started[0]?.joined).toBe(true);
  });

  it("keeps the playhead inside the locators when they move under it", () => {
    const { clock, engine } = setup();
    engine.play();
    clock.advance(20);
    engine.setLoop({ startS: 4, endS: 8 });
    expect(engine.position()).toBeCloseTo(4, 6); // 20 s was outside; it comes home to the loop
    engine.setLoop({ startS: 0, endS: 16 });
    expect(engine.position()).toBeCloseTo(4, 6); // still inside: left where it was
  });
});

group("scheduling", () => {
  it("starts each region once, however many ticks pass over it", () => {
    const { clock, ticker, engine, backend } = setup();
    engine.setTracks([track("drums"), track("bass")]);
    engine.setTrackRegions("drums", [region("d1", { trackId: "drums", sourceId: "a", durationS: 8 })]);
    engine.setTrackRegions("bass", [region("b1", { trackId: "bass", sourceId: "b", durationS: 8 })]);
    engine.play();
    run(clock, ticker, 4);
    expect(backend.forRegion("d1")).toHaveLength(1);
    expect(backend.forRegion("b1")).toHaveLength(1);
    expect(backend.started.map((p) => p.durationS)).toEqual([8, 8]);
  });

  it("schedules ahead of the playhead, never behind it", () => {
    const { clock, ticker, engine, backend } = setup();
    engine.setTracks([track("drums")]);
    engine.setTrackRegions("drums", [region("a", { startS: 0, durationS: 1 }), region("b", { startS: 1, durationS: 1 }), region("c", { startS: 2, durationS: 1 })]);
    engine.play();
    run(clock, ticker, 3);
    for (const play of backend.started) {
      expect(play.whenWall).toBeGreaterThanOrEqual(play.calledAt);
      expect(play.whenWall - play.calledAt).toBeLessThanOrEqual(0.25 + 1e-9);
    }
    expect(backend.started.map((p) => p.regionId)).toEqual(["a", "b", "c"]);
  });

  it("repeats a loop at exactly the loop length, pass after pass", () => {
    const { clock, ticker, engine, backend } = setup({ loop: { startS: 0, endS: 2 } });
    engine.setTracks([track("drums")]);
    engine.setTrackRegions("drums", [region("r", { durationS: 2 })]);
    engine.play();
    run(clock, ticker, 8.5);
    const starts = backend.forRegion("r").map((p) => p.whenWall);
    expect(starts.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeCloseTo(2, 9);
    }
    expect(backend.forRegion("r").map((p) => p.pass)).toEqual(starts.map((_, i) => i));
    // every repeat plays the same samples from the same place
    expect(new Set(backend.forRegion("r").map((p) => p.offsetS))).toEqual(new Set([0]));
  });

  it("cuts a region that outlasts the loop and starts its head again on the next pass", () => {
    const { clock, ticker, engine, backend } = setup({ loop: { startS: 0, endS: 1 } });
    engine.setTracks([track("pad")]);
    engine.setTrackRegions("pad", [region("long", { trackId: "pad", durationS: 30, offsetS: 5 })]);
    engine.play();
    run(clock, ticker, 3.5);
    const plays = backend.forRegion("long");
    expect(plays.length).toBeGreaterThanOrEqual(3);
    expect(plays.every((p) => p.durationS <= 1 + 1e-9)).toBe(true);
    expect(plays.every((p) => Math.abs(p.offsetS - 5) < 1e-9)).toBe(true); // always from the same place in the record
  });

  it("does nothing at all while paused", () => {
    const { clock, ticker, engine, backend } = setup();
    engine.setTracks([track("drums")]);
    engine.setTrackRegions("drums", [region("r")]);
    run(clock, ticker, 2);
    expect(backend.started).toEqual([]);
  });
});

group("the mix does not interrupt the music", () => {
  it("mutes and solos by moving gain nodes, not by stopping sources", () => {
    const { clock, ticker, engine, backend } = setup();
    engine.setTracks([track("drums"), track("bass")]);
    engine.setTrackRegions("drums", [region("d", { trackId: "drums", sourceId: "a", durationS: 60 })]);
    engine.setTrackRegions("bass", [region("b", { trackId: "bass", sourceId: "b", durationS: 60 })]);
    engine.play();
    run(clock, ticker, 1);
    backend.clear();

    engine.setMute("bass", true);
    expect(backend.trackGains.get("bass")).toBe(0);
    engine.setSolo("drums", true);
    expect(backend.trackGains.get("drums")).toBe(1);
    engine.setGain("drums", 0.5);
    expect(backend.trackGains.get("drums")).toBe(0.5);

    // nothing was stopped and nothing was restarted: the drums keep running
    expect(backend.stops).toEqual([]);
    expect(backend.started).toEqual([]);

    engine.setMute("bass", false);
    engine.setSolo("drums", false);
    expect(backend.trackGains.get("bass")).toBe(1);
    expect(backend.stops).toEqual([]);
  });

  it("puts the master on the bus", () => {
    const { engine, backend } = setup();
    engine.setMasterGain(0.7);
    expect(backend.masterGain).toBe(0.7);
  });
});

group("auditioning against the session", () => {
  it("swaps one lane's material without touching the rest or stopping the transport", () => {
    const { clock, ticker, engine, backend } = setup({ loop: { startS: 0, endS: 4 } });
    engine.setTracks([track("song"), track("audition")]);
    engine.setTrackRegions("song", [region("song-r", { trackId: "song", sourceId: "song.wav", durationS: 4 })]);
    engine.setTrackRegions("audition", [region("cand1", { trackId: "audition", sourceId: "one.wav", durationS: 4, offsetS: 2 })]);
    engine.play();
    run(clock, ticker, 1.5); // a second and a half into the bar
    backend.clear();

    // the producer presses the next candidate
    engine.setTrackRegions("audition", [region("cand2", { trackId: "audition", sourceId: "two.wav", durationS: 4, offsetS: 7 })]);

    expect(engine.isPlaying).toBe(true);
    expect(backend.stops).toEqual(["audition"]); // only the audition lane was silenced
    const joined = backend.forRegion("cand2");
    expect(joined).toHaveLength(1);
    expect(joined[0]?.joined).toBe(true);
    // it comes in where the bar already is, not from its own start
    const at = 1.5 - START_LEAD_S;
    expect(joined[0]?.sessionStartS).toBeCloseTo(at, 6);
    expect(joined[0]?.offsetS).toBeCloseTo(7 + at, 6);
    expect(joined[0]?.durationS).toBeCloseTo(4 - at, 6);
    // and the song lane was not re-scheduled
    expect(backend.forRegion("song-r")).toHaveLength(0);
  });

  it("keeps the swapped lane in step on the next pass of the loop", () => {
    const { clock, ticker, engine, backend } = setup({ loop: { startS: 0, endS: 4 } });
    engine.setTracks([track("audition")]);
    engine.setTrackRegions("audition", [region("cand1", { trackId: "audition", sourceId: "one.wav", durationS: 4 })]);
    engine.play();
    run(clock, ticker, 1.5);
    engine.setTrackRegions("audition", [region("cand2", { trackId: "audition", sourceId: "two.wav", durationS: 4, offsetS: 3 })]);
    backend.clear();
    run(clock, ticker, 4);
    const next = backend.forRegion("cand2");
    expect(next.length).toBeGreaterThanOrEqual(1);
    expect(next[0]?.joined).toBe(false); // the next pass starts it properly, from its downbeat
    expect(next[0]?.offsetS).toBeCloseTo(3, 9);
    expect(next[0]?.durationS).toBeCloseTo(4, 9);
  });

  it("removes a lane without disturbing the others", () => {
    const { clock, ticker, engine, backend } = setup();
    engine.setTracks([track("song"), track("audition")]);
    engine.setTrackRegions("song", [region("s", { trackId: "song", sourceId: "a", durationS: 60 })]);
    engine.setTrackRegions("audition", [region("c", { trackId: "audition", sourceId: "b", durationS: 60 })]);
    engine.play();
    run(clock, ticker, 1);
    backend.clear();
    engine.removeTrack("audition");
    expect(backend.stops).toEqual(["audition"]);
    expect(backend.tracks.has("audition")).toBe(false);
    expect(backend.started).toEqual([]);
    expect(engine.regionsOf("audition")).toEqual([]);
  });
});

group("a track that is still decoding", () => {
  it("is reported as waiting rather than played as silence", () => {
    const { clock, ticker, engine, backend } = setup();
    backend.allReady = false;
    engine.setTracks([track("drums")]);
    engine.setTrackRegions("drums", [region("r", { sourceId: "slow.wav", durationS: 30 })]);
    engine.play();
    run(clock, ticker, 0.5);
    expect(backend.started).toEqual([]);
    expect(engine.snapshot().waiting).toEqual(["slow.wav"]);
  });

  it("joins in progress the moment its samples land, at the right place in the bar", () => {
    const { clock, ticker, engine, backend } = setup();
    backend.allReady = false;
    engine.setTracks([track("drums")]);
    engine.setTrackRegions("drums", [region("r", { sourceId: "slow.wav", durationS: 30, offsetS: 1 })]);
    engine.play();
    run(clock, ticker, 2);
    expect(backend.started).toEqual([]);

    backend.ready.add("slow.wav");
    engine.sourceReady("slow.wav");

    expect(backend.started).toHaveLength(1);
    const play = backend.started[0]!;
    expect(play.joined).toBe(true);
    expect(play.sessionStartS).toBeCloseTo(2 - START_LEAD_S, 6);
    expect(play.offsetS).toBeCloseTo(1 + 2 - START_LEAD_S, 6);
    expect(engine.snapshot().waiting).toEqual([]);
  });

  it("retries on the next tick even if nothing tells it the decode landed", () => {
    const { clock, ticker, engine, backend } = setup();
    backend.allReady = false;
    engine.setTracks([track("drums")]);
    engine.setTrackRegions("drums", [region("r", { sourceId: "slow.wav", durationS: 30 })]);
    engine.play();
    run(clock, ticker, 1);
    backend.ready.add("slow.wav");
    run(clock, ticker, 0.12);
    expect(backend.started).toHaveLength(1);
  });
});

group("lifecycle", () => {
  it("runs the ticker only while playing", () => {
    const { engine, ticker } = setup();
    expect(ticker.running).toBe(false);
    engine.play();
    expect(ticker.running).toBe(true);
    engine.pause();
    expect(ticker.running).toBe(false);
    engine.play();
    engine.stop();
    expect(ticker.running).toBe(false);
  });

  it("takes a lane's material with it when the lane goes", () => {
    const { clock, ticker, engine, backend } = setup();
    engine.setTracks([track("a"), track("b")]);
    engine.setTrackRegions("a", [region("ra", { trackId: "a", sourceId: "x", durationS: 60 })]);
    engine.setTrackRegions("b", [region("rb", { trackId: "b", sourceId: "y", durationS: 60 })]);
    engine.play();
    run(clock, ticker, 0.5);
    backend.clear();
    engine.setTracks([track("b")]);
    run(clock, ticker, 2);
    expect(engine.regionsOf("a")).toEqual([]);
    expect(engine.sources()).toEqual(["y"]);
    expect(backend.forRegion("ra")).toHaveLength(0);
  });

  it("reports its sources so the cache knows what to hold", () => {
    const { engine } = setup();
    engine.setTracks([track("a"), track("b")]);
    engine.setTrackRegions("a", [region("r1", { trackId: "a", sourceId: "x" }), region("r2", { trackId: "a", sourceId: "x" })]);
    engine.setTrackRegions("b", [region("r3", { trackId: "b", sourceId: "y" })]);
    expect(engine.sources().sort()).toEqual(["x", "y"]);
  });

  it("tells its listeners when the session changes", () => {
    const { engine } = setup();
    const seen: number[] = [];
    const off = engine.subscribe((snapshot) => seen.push(snapshot.tracks.length));
    engine.setTracks([track("a")]);
    engine.addTrack(track("b"));
    off();
    engine.setTracks([]);
    expect(seen).toEqual([1, 2]);
  });

  it("releases everything on dispose", () => {
    const { engine, ticker, backend } = setup();
    engine.setTracks([track("a")]);
    engine.play();
    engine.dispose();
    expect(ticker.running).toBe(false);
    expect(backend.stops).toContain("*");
  });
});
