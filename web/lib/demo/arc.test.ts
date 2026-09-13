// The prototype's arc, driven through the real engine.
//
// The page cannot be clicked here, but everything the clicking does can be:
// `SessionProvider` is a thin wrapper over `SessionEngine`, so this file
// mirrors its three calls (commit, audition, A/B) against the same engine with
// a hand-stepped clock, using the demo's own candidates and the demo's own
// arithmetic. What it asserts is what the owner is being asked to listen for:
//
//   the bed loops exactly, pass after pass, with no drift;
//   a candidate lands *under* it without the bed being touched;
//   the next candidate takes over on the same bar, and the bed still is not;
//   a lane still decoding joins in progress the moment its samples land;
//   muting moves a gain node and stops nothing.
//
// If the demo sounds wrong in a browser and this file is green, the fault is
// in the browser half (webAudio.ts) and not in the material or the scheduling.

import { describe, expect, it } from "vitest";
import { SessionEngine, START_LEAD_S } from "@/lib/session/engine";
import { FakeBackend, ManualClock, ManualTicker } from "@/lib/session/fakes";
import {
  AUDITION_TRACK_ID,
  auditionTrack,
  candidateLength,
  tileCandidate,
  trackFromCandidate,
  trackIdFor,
  type RackCandidate,
} from "@/lib/session/rack";
import type { TransportLoop } from "@/lib/session/types";
import { bedCandidate, buildDemoLibrary, demoCompatRack, DEMO_BARS, DEMO_BPM } from "./material";
import { barSeconds } from "./synth";

const SR = 44100;
const library = buildDemoLibrary(SR);
const bed = bedCandidate(library);
const rack = demoCompatRack(library);
const BAR = barSeconds(DEMO_BPM);
const LOOP = DEMO_BARS * BAR;

function session() {
  const clock = new ManualClock(0);
  const backend = new FakeBackend(clock);
  const ticker = new ManualTicker();
  const engine = new SessionEngine({ backend, ticker });
  return { clock, backend, ticker, engine };
}

/** The span an audition or a commit fills. Mirrors SessionProvider.auditionSpan. */
function spanOf(engine: SessionEngine, candidate: RackCandidate): TransportLoop {
  const loop = engine.loop;
  if (loop && loop.endS - loop.startS > 0.02) return loop;
  return { startS: 0, endS: Math.max(0.25, candidateLength(candidate)) };
}

/** Mirrors SessionProvider.commit. */
function commit(engine: SessionEngine, candidate: RackCandidate): string {
  const span = spanOf(engine, candidate);
  if (!engine.loop) engine.setLoop(span);
  const trackId = trackIdFor(candidate);
  const { regions } = tileCandidate({ candidate, trackId, span });
  engine.addTrack(trackFromCandidate(candidate, trackId));
  engine.setTrackRegions(trackId, regions);
  if (!engine.isPlaying) engine.play();
  return trackId;
}

/** Mirrors SessionProvider.audition. */
function audition(engine: SessionEngine, candidate: RackCandidate): void {
  const span = spanOf(engine, candidate);
  if (!engine.loop) engine.setLoop(span);
  const { regions } = tileCandidate({ candidate, trackId: AUDITION_TRACK_ID, span });
  const existing = engine.snapshot().tracks.find((t) => t.id === AUDITION_TRACK_ID);
  if (!existing) engine.addTrack(auditionTrack(candidate));
  engine.setTrackRegions(AUDITION_TRACK_ID, regions);
  if (!engine.isPlaying) engine.play();
}

/** Run the transport for `seconds`, ticking the way the interval ticker would. */
function run(parts: ReturnType<typeof session>, seconds: number, stepMs = 60): void {
  const steps = Math.ceil((seconds * 1000) / stepMs);
  for (let i = 0; i < steps; i++) {
    parts.clock.advance(stepMs / 1000);
    parts.ticker.step();
  }
}

describe("step one: the record goes in the song", () => {
  it("makes one lane, sets the locators to its own four bars and starts", () => {
    const parts = session();
    const trackId = commit(parts.engine, bed);
    expect(parts.engine.loop).toEqual({ startS: 0, endS: LOOP });
    expect(parts.engine.isPlaying).toBe(true);
    expect(parts.engine.regionsOf(trackId)).toHaveLength(1);
  });

  it("starts the bed on the downbeat of the record, not at the file's zero", () => {
    const parts = session();
    commit(parts.engine, bed);
    parts.ticker.step();
    const [first] = parts.backend.started;
    expect(first).toBeDefined();
    expect(first!.offsetS).toBeCloseTo(bed.audio.downbeatS, 9);
    expect(first!.whenWall).toBeCloseTo(START_LEAD_S, 9);
    expect(first!.sessionStartS).toBe(0);
  });

  it("loops for a hundred passes with the repeats exactly one loop apart", () => {
    const parts = session();
    const trackId = commit(parts.engine, bed);
    run(parts, LOOP * 100);
    const starts = parts.backend.forTrack(trackId).map((p) => p.whenWall);
    expect(starts.length).toBeGreaterThan(95);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeCloseTo(LOOP, 9);
    }
  });

  it("never starts the same piece twice, however the ticks fall", () => {
    const parts = session();
    commit(parts.engine, bed);
    // ticks late and irregular: 190 ms is past the 60 ms interval and inside the 250 ms lookahead
    run(parts, LOOP * 10, 190);
    const keys = parts.backend.started.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("step two: a candidate goes under it", () => {
  it("puts the drums on their own lane without touching the bed", () => {
    const parts = session();
    const bedTrack = commit(parts.engine, bed);
    run(parts, BAR);
    parts.backend.clear();

    audition(parts.engine, rack.candidates[0]!);
    run(parts, BAR);
    expect(parts.backend.stops).not.toContain("*");
    expect(parts.backend.stops).not.toContain(bedTrack);
    expect(parts.backend.forTrack(AUDITION_TRACK_ID).length).toBeGreaterThan(0);
  });

  it("joins where the playhead already is, not at the head of the break", () => {
    const parts = session();
    commit(parts.engine, bed);
    run(parts, BAR * 1.5);
    parts.backend.clear();
    const at = parts.engine.position();
    expect(at).toBeGreaterThan(BAR);
    audition(parts.engine, rack.candidates[0]!);
    const [first] = parts.backend.forTrack(AUDITION_TRACK_ID);
    expect(first).toBeDefined();
    expect(first!.joined).toBe(true);
    // a bar and a half into the song is a bar and a half into the break, times
    // the rate it is being resampled by to fit
    const candidate = rack.candidates[0]!;
    expect(first!.offsetS).toBeCloseTo(candidate.audio.downbeatS + at * candidate.fit!.rate, 6);
  });

  it("takes over on the same bar when the next row is pressed, and only that lane stops", () => {
    const parts = session();
    const bedTrack = commit(parts.engine, bed);
    audition(parts.engine, rack.candidates[0]!);
    run(parts, BAR * 2);
    parts.backend.clear();

    audition(parts.engine, rack.candidates[1]!);
    expect(parts.backend.stops).toEqual([AUDITION_TRACK_ID]);
    const [swapped] = parts.backend.forTrack(AUDITION_TRACK_ID);
    expect(swapped).toBeDefined();
    expect(swapped!.sourceId).toBe(rack.candidates[1]!.audio.fileId);
    expect(parts.backend.forTrack(bedTrack)).toHaveLength(0);
  });

  it("starts the new candidate cleanly from its own downbeat on the next pass", () => {
    const parts = session();
    commit(parts.engine, bed);
    audition(parts.engine, rack.candidates[0]!);
    run(parts, BAR);
    audition(parts.engine, rack.candidates[1]!);
    parts.backend.clear();
    run(parts, LOOP * 2);
    const fresh = parts.backend.forTrack(AUDITION_TRACK_ID).filter((p) => !p.joined);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh[0]!.offsetS).toBeCloseTo(rack.candidates[1]!.audio.downbeatS, 9);
  });

  it("lines every measured candidate up with the bed, pass after pass", () => {
    for (const candidate of rack.candidates.filter((c) => c.sourceBpm !== null)) {
      const parts = session();
      const bedTrack = commit(parts.engine, bed);
      audition(parts.engine, candidate);
      run(parts, LOOP * 4);
      const bedStarts = parts.backend.forTrack(bedTrack).filter((p) => !p.joined).map((p) => p.whenWall);
      const drumStarts = parts.backend
        .forTrack(AUDITION_TRACK_ID)
        .filter((p) => !p.joined && p.sessionStartS === 0)
        .map((p) => p.whenWall);
      expect(drumStarts.length, candidate.title).toBeGreaterThan(2);
      for (const at of drumStarts) {
        const nearest = bedStarts.reduce((best, b) => (Math.abs(b - at) < Math.abs(best - at) ? b : best), bedStarts[0]!);
        expect(Math.abs(nearest - at), candidate.title).toBeLessThan(1e-9);
      }
    }
  });

  it("re-triggers the unmeasured record early, which is what having no tempo costs", () => {
    const loose = rack.candidates.find((c) => c.sourceBpm === null)!;
    const plan = tileCandidate({ candidate: loose, trackId: "x", span: { startS: 0, endS: LOOP } });
    expect(plan.repeats).toBe(2);
    expect(plan.regions[1]!.startS).toBeLessThan(LOOP);
    expect(plan.regions[1]!.durationS).toBeLessThan(plan.cycleS);
  });
});

describe("a lane that is still decoding", () => {
  it("is reported as waiting rather than played, and joins the moment it lands", () => {
    const parts = session();
    parts.backend.allReady = false;
    parts.backend.ready.add(bed.audio.fileId);
    commit(parts.engine, bed);
    const candidate = rack.candidates[0]!;
    audition(parts.engine, candidate);
    run(parts, BAR);

    expect(parts.engine.snapshot().waiting).toContain(candidate.audio.fileId);
    expect(parts.backend.forTrack(AUDITION_TRACK_ID)).toHaveLength(0);

    // the decode lands a bar and a half in
    run(parts, BAR * 0.5);
    parts.backend.ready.add(candidate.audio.fileId);
    parts.engine.sourceReady(candidate.audio.fileId);
    const [joined] = parts.backend.forTrack(AUDITION_TRACK_ID);
    expect(joined).toBeDefined();
    expect(joined!.joined).toBe(true);
    expect(joined!.offsetS).toBeGreaterThan(candidate.audio.downbeatS);
    expect(parts.engine.snapshot().waiting).toEqual([]);
  });
});

describe("the mix", () => {
  it("mutes a lane by moving its gain node, stopping nothing", () => {
    const parts = session();
    const bedTrack = commit(parts.engine, bed);
    const drums = commit(parts.engine, rack.candidates[0]!);
    run(parts, BAR);
    parts.backend.clear();

    parts.engine.setMute(drums, true);
    expect(parts.backend.stops).toEqual([]);
    expect(parts.backend.trackGains.get(drums)).toBe(0);
    expect(parts.backend.trackGains.get(bedTrack)).toBe(1);

    parts.engine.setSolo(bedTrack, true);
    expect(parts.backend.trackGains.get(drums)).toBe(0);
    parts.engine.setMute(drums, false);
    expect(parts.backend.trackGains.get(drums)).toBe(0); // still silent: the bed is soloed
    parts.engine.setSolo(bedTrack, false);
    expect(parts.backend.trackGains.get(drums)).toBe(1);
    expect(parts.backend.stops).toEqual([]);
  });

  it("keeps both lanes playing through every one of it", () => {
    const parts = session();
    const bedTrack = commit(parts.engine, bed);
    const drums = commit(parts.engine, rack.candidates[2]!);
    parts.backend.clear();
    run(parts, LOOP * 3);
    expect(parts.backend.forTrack(bedTrack).length).toBeGreaterThan(2);
    expect(parts.backend.forTrack(drums).length).toBeGreaterThan(2);
  });
});
