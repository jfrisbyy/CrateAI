// The scheduler. Everything a producer would hear as wrong — a repeat that
// restarts instead of continuing, a double trigger, a lane that never comes in
// — is a property of these numbers, so they are asserted directly.

import { describe as group, expect, it } from "vitest";
import { contentEnd, planKey, planWindow, pieceFor, rateOf, regionEnd, sourcesOf } from "./schedule";
import { segmentsInWindow } from "./time";
import type { SessionRegion, TransportState } from "./types";

function region(partial: Partial<SessionRegion> & { id: string }): SessionRegion {
  return { trackId: "t1", sourceId: "s1", startS: 0, durationS: 4, offsetS: 0, gain: 1, ...partial };
}

function rolling(partial: Partial<TransportState> = {}): TransportState {
  return { playing: true, anchorS: 0, anchorWall: 100, loop: null, ...partial };
}

const NO_KEYS: ReadonlySet<string> = new Set();

group("pieceFor", () => {
  it("starts a region at its own start, from its own offset", () => {
    const t = rolling();
    const segment = segmentsInWindow(t, 100, 101)[0]!;
    const piece = pieceFor(region({ id: "r", startS: 0.5, durationS: 2, offsetS: 9 }), segment)!;
    expect(piece).toMatchObject({ whenWall: 100.5, offsetS: 9, durationS: 2, sessionStartS: 0.5, joined: false, pass: 0 });
  });

  it("joins a region already under the playhead at the right samples, not from the top", () => {
    // The window opens at session 1.5, half a second into a region that began at 1.0
    const t = rolling({ anchorS: 1.5 });
    const segment = segmentsInWindow(t, 100, 100.25)[0]!;
    const piece = pieceFor(region({ id: "r", startS: 1, durationS: 4, offsetS: 30 }), segment)!;
    expect(piece.offsetS).toBeCloseTo(30.5, 9);
    expect(piece.whenWall).toBe(100);
    expect(piece.joined).toBe(true);
  });

  it("advances the offset by the playback rate when a region is resampled", () => {
    const t = rolling({ anchorS: 2 });
    const segment = segmentsInWindow(t, 100, 100.25)[0]!;
    const piece = pieceFor(region({ id: "r", startS: 0, durationS: 8, offsetS: 10, rate: 1.5 }), segment)!;
    // two session seconds in, at 1.5x, is three seconds of the recording
    expect(piece.offsetS).toBeCloseTo(13, 9);
    expect(piece.rate).toBe(1.5);
  });

  it("is null when the region and the segment do not meet", () => {
    const t = rolling({ anchorS: 20 });
    const segment = segmentsInWindow(t, 100, 100.25)[0]!;
    expect(pieceFor(region({ id: "r", startS: 0, durationS: 4 }), segment)).toBeNull();
  });

  it("treats a missing, zero or nonsense rate as 1", () => {
    expect(rateOf(region({ id: "r" }))).toBe(1);
    expect(rateOf(region({ id: "r", rate: 0 }))).toBe(1);
    expect(rateOf(region({ id: "r", rate: Number.NaN }))).toBe(1);
    expect(rateOf(region({ id: "r", rate: 0.5 }))).toBe(0.5);
  });
});

group("planWindow", () => {
  it("plans nothing while the transport is paused", () => {
    const plan = planWindow({ transport: rolling({ playing: false }), regions: [region({ id: "r" })], fromWall: 100, toWall: 101, scheduled: NO_KEYS });
    expect(plan.plays).toEqual([]);
  });

  it("orders the plan by clock time", () => {
    const regions = [region({ id: "late", startS: 0.2 }), region({ id: "early", startS: 0.05 })];
    const plan = planWindow({ transport: rolling(), regions, fromWall: 100, toWall: 100.25, scheduled: NO_KEYS });
    expect(plan.plays.map((p) => p.regionId)).toEqual(["early", "late"]);
  });

  it("cuts a region at the loop locator and starts its head again on the next pass", () => {
    const transport = rolling({ anchorS: 0, loop: { startS: 0, endS: 2 } });
    const regions = [region({ id: "r", startS: 0, durationS: 8, offsetS: 0 })];
    const first = planWindow({ transport, regions, fromWall: 100, toWall: 100.25, scheduled: NO_KEYS });
    expect(first.plays).toHaveLength(1);
    expect(first.plays[0]).toMatchObject({ pass: 0, durationS: 2, offsetS: 0, key: planKey("r", 0) });

    // the window that straddles the wrap gets the head of the region again
    const second = planWindow({ transport, regions, fromWall: 101.9, toWall: 102.2, scheduled: new Set([planKey("r", 0)]) });
    expect(second.plays).toHaveLength(1);
    expect(second.plays[0]).toMatchObject({ pass: 1, offsetS: 0, sessionStartS: 0, key: planKey("r", 1) });
    expect(second.plays[0]?.whenWall).toBeCloseTo(102, 9);
    expect(second.plays[0]?.durationS).toBeCloseTo(2, 9);
  });

  it("never plans the same piece twice, however the ticks overlap", () => {
    const transport = rolling({ anchorS: 0, loop: { startS: 0, endS: 2 } });
    const regions = [region({ id: "r", startS: 0, durationS: 2 })];
    const scheduled = new Set<string>();
    const keys: string[] = [];
    // ticks every 60 ms across four passes of a two-second loop, each planning 250 ms ahead
    for (let i = 0; i < 140; i++) {
      const now = 100 + i * 0.06;
      const plan = planWindow({ transport, regions, fromWall: now, toWall: now + 0.25, scheduled });
      for (const play of plan.plays) {
        keys.push(play.key);
        scheduled.add(play.key);
      }
    }
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([planKey("r", 0), planKey("r", 1), planKey("r", 2), planKey("r", 3), planKey("r", 4)]);
  });

  it("survives a tick that arrives late without losing a repeat", () => {
    const transport = rolling({ anchorS: 0, loop: { startS: 0, endS: 0.5 } });
    const regions = [region({ id: "r", startS: 0, durationS: 0.5 })];
    const scheduled = new Set<string>();
    const starts: number[] = [];
    const passes: number[] = [];
    // ticks 190 ms apart: three times the nominal 60 ms and still inside the
    // 250 ms lookahead, which is the whole point of scheduling ahead
    for (const now of [100, 100.19, 100.38, 100.57, 100.76, 100.95]) {
      const plan = planWindow({ transport, regions, fromWall: now, toWall: now + 0.25, scheduled });
      for (const play of plan.plays) {
        passes.push(play.pass);
        starts.push(play.whenWall);
        scheduled.add(play.key);
      }
    }
    expect(passes).toEqual([0, 1, 2]);
    // every repeat is exactly one loop length after the last: no drift, no gap
    expect(starts[1]! - starts[0]!).toBeCloseTo(0.5, 9);
    expect(starts[2]! - starts[1]!).toBeCloseTo(0.5, 9);
  });

  it("schedules a region to its natural end, not to the edge of the lookahead", () => {
    const plan = planWindow({ transport: rolling(), regions: [region({ id: "r", startS: 0, durationS: 8 })], fromWall: 100, toWall: 100.25, scheduled: NO_KEYS });
    expect(plan.plays[0]?.durationS).toBe(8);
  });

  it("leaves a region that is not due yet for a later tick", () => {
    const plan = planWindow({ transport: rolling(), regions: [region({ id: "r", startS: 4 })], fromWall: 100, toWall: 100.25, scheduled: NO_KEYS });
    expect(plan.plays).toEqual([]);
  });

  it("reports a source that has not decoded instead of playing silence, and keeps no key for it", () => {
    const transport = rolling();
    const regions = [region({ id: "ready", sourceId: "a" }), region({ id: "waiting", sourceId: "b" })];
    const plan = planWindow({ transport, regions, fromWall: 100, toWall: 100.25, scheduled: NO_KEYS, isReady: (s) => s === "a" });
    expect(plan.plays.map((p) => p.regionId)).toEqual(["ready"]);
    expect(plan.waiting).toEqual(["b"]);
  });

  it("brings a late-decoding lane in mid-region once its samples land", () => {
    const transport = rolling({ anchorS: 0 });
    const regions = [region({ id: "r", sourceId: "b", startS: 0, durationS: 8, offsetS: 2 })];
    const scheduled = new Set<string>();
    const early = planWindow({ transport, regions, fromWall: 100, toWall: 100.25, scheduled, isReady: () => false });
    expect(early.plays).toEqual([]);
    // 1.4 s later the decode lands; the region joins where the playhead is, not from its start
    const late = planWindow({ transport, regions, fromWall: 101.4, toWall: 101.65, scheduled, isReady: () => true });
    expect(late.plays).toHaveLength(1);
    expect(late.plays[0]).toMatchObject({ joined: true, whenWall: 101.4 });
    expect(late.plays[0]?.offsetS).toBeCloseTo(3.4, 9);
    expect(late.plays[0]?.durationS).toBeCloseTo(6.6, 9);
  });

  it("plans every lane of a multitrack session off the one clock", () => {
    const transport = rolling();
    const regions = [
      region({ id: "drums", trackId: "t1", sourceId: "a", startS: 0 }),
      region({ id: "bass", trackId: "t2", sourceId: "b", startS: 0 }),
      region({ id: "keys", trackId: "t3", sourceId: "c", startS: 0 }),
    ];
    const plan = planWindow({ transport, regions, fromWall: 100, toWall: 100.25, scheduled: NO_KEYS });
    expect(plan.plays).toHaveLength(3);
    expect(new Set(plan.plays.map((p) => p.whenWall))).toEqual(new Set([100]));
  });
});

group("helpers", () => {
  it("reports the end of a region and of the material", () => {
    expect(regionEnd(region({ id: "r", startS: 2, durationS: 3 }))).toBe(5);
    expect(contentEnd([region({ id: "a", startS: 0, durationS: 4 }), region({ id: "b", startS: 8, durationS: 2 })])).toBe(10);
    expect(contentEnd([])).toBe(0);
  });

  it("lists each source once", () => {
    expect(sourcesOf([region({ id: "a", sourceId: "x" }), region({ id: "b", sourceId: "x" }), region({ id: "c", sourceId: "y" })])).toEqual(["x", "y"]);
  });
});
