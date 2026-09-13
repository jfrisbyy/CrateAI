// The playhead and the loop, which are the same arithmetic seen twice.

import { describe as group, expect, it } from "vitest";
import { activeLoop, barAt, barToSeconds, clampToLoop, loopApplies, loopForBars, passAt, positionAt, secondsPerBar, segmentsInWindow, wallForPosition } from "./time";
import type { TransportState } from "./types";

function rolling(partial: Partial<TransportState> = {}): TransportState {
  return { playing: true, anchorS: 0, anchorWall: 100, loop: null, ...partial };
}

group("positionAt", () => {
  it("sits on the anchor while paused, whatever the clock says", () => {
    const t = rolling({ playing: false, anchorS: 12.5 });
    expect(positionAt(t, 1e6)).toBe(12.5);
  });

  it("advances one second per second from the anchor", () => {
    const t = rolling({ anchorS: 4, anchorWall: 100 });
    expect(positionAt(t, 100)).toBe(4);
    expect(positionAt(t, 101.25)).toBe(5.25);
  });

  it("holds at the anchor before the start lead-in has elapsed", () => {
    const t = rolling({ anchorS: 4, anchorWall: 100.03 });
    expect(positionAt(t, 100)).toBe(4);
  });

  it("wraps at the end locator and lands exactly on the start locator", () => {
    const t = rolling({ anchorS: 8, loop: { startS: 8, endS: 12 } });
    expect(positionAt(t, 100)).toBe(8);
    expect(positionAt(t, 103.999)).toBeCloseTo(11.999, 9);
    expect(positionAt(t, 104)).toBeCloseTo(8, 12);
    expect(positionAt(t, 104.5)).toBeCloseTo(8.5, 9);
  });

  it("does not drift over a thousand passes", () => {
    const t = rolling({ anchorS: 8, loop: { startS: 8, endS: 12 } });
    // A tick-by-tick playhead would have accumulated error by here; this one is derived.
    expect(positionAt(t, 100 + 4000 + 1.5)).toBeCloseTo(9.5, 9);
    expect(passAt(t, 100 + 4000 + 1.5)).toBe(1000);
  });

  it("plays into the loop from before it, then wraps", () => {
    const t = rolling({ anchorS: 2, loop: { startS: 8, endS: 12 } });
    expect(positionAt(t, 105)).toBe(7); // still before the loop
    expect(positionAt(t, 110)).toBe(12 - 4 + 0); // 2 + 10 = 12 -> wraps to 8
    expect(positionAt(t, 111)).toBeCloseTo(9, 9);
    expect(passAt(t, 111)).toBe(1);
  });

  it("runs straight through when the playhead starts past the end locator", () => {
    const t = rolling({ anchorS: 20, loop: { startS: 8, endS: 12 } });
    expect(loopApplies(t)).toBe(false);
    expect(positionAt(t, 110)).toBe(30);
    expect(passAt(t, 110)).toBe(0);
  });

  it("ignores locators that are inverted, missing or hair-thin", () => {
    expect(activeLoop(rolling({ loop: { startS: 12, endS: 8 } }))).toBeNull();
    expect(activeLoop(rolling({ loop: { startS: 8, endS: 8.001 } }))).toBeNull();
    expect(activeLoop(rolling({ loop: null }))).toBeNull();
    expect(positionAt(rolling({ anchorS: 0, loop: { startS: 12, endS: 8 } }), 110)).toBe(10);
  });
});

group("segmentsInWindow", () => {
  it("is one segment when nothing wraps", () => {
    const t = rolling({ anchorS: 0 });
    const segments = segmentsInWindow(t, 100, 100.25);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ pass: 0, startWall: 100, endWall: 100.25, startS: 0, endS: 0.25 });
  });

  it("is empty while paused and for an empty window", () => {
    expect(segmentsInWindow(rolling({ playing: false }), 100, 101)).toEqual([]);
    expect(segmentsInWindow(rolling(), 100, 100)).toEqual([]);
  });

  it("splits at the loop boundary, and the pieces tile the window exactly", () => {
    const t = rolling({ anchorS: 8, loop: { startS: 8, endS: 12 } });
    const segments = segmentsInWindow(t, 103.9, 104.2);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ pass: 0, startWall: 103.9, endWall: 104 });
    expect(segments[0]?.endS).toBeCloseTo(12, 9);
    expect(segments[1]).toMatchObject({ pass: 1, startWall: 104, endWall: 104.2 });
    expect(segments[1]?.startS).toBeCloseTo(8, 9);
    expect(segments[1]?.endS).toBeCloseTo(8.2, 9);
    // contiguous, no gap, no overlap
    expect(segments[0]?.endWall).toBe(segments[1]?.startWall);
  });

  it("covers a window longer than the loop with one segment per pass", () => {
    const t = rolling({ anchorS: 0, loop: { startS: 0, endS: 0.1 } });
    const segments = segmentsInWindow(t, 100, 100.25);
    expect(segments.map((s) => s.pass)).toEqual([0, 1, 2]);
    const covered = segments.reduce((sum, s) => sum + (s.endWall - s.startWall), 0);
    expect(covered).toBeCloseTo(0.25, 9);
    for (const s of segments) expect(s.endS - s.startS).toBeCloseTo(s.endWall - s.startWall, 12);
  });

  it("every segment maps clock to session at one second per second", () => {
    const t = rolling({ anchorS: 7.3, loop: { startS: 4, endS: 11 } });
    for (const s of segmentsInWindow(t, 100, 130)) {
      expect(positionAt(t, s.startWall)).toBeCloseTo(s.startS, 9);
      expect(s.endS - s.startS).toBeCloseTo(s.endWall - s.startWall, 9);
    }
  });
});

group("wallForPosition", () => {
  it("finds the clock time a session second is reached at", () => {
    const t = rolling({ anchorS: 8, loop: { startS: 8, endS: 12 } });
    expect(wallForPosition(t, 10, 100)).toBeCloseTo(102, 9);
    // the next pass of the same second
    expect(wallForPosition(t, 10, 103)).toBeCloseTo(106, 9);
  });

  it("is null for a position the transport will not reach", () => {
    const t = rolling({ anchorS: 8, loop: { startS: 8, endS: 12 } });
    expect(wallForPosition(t, 40, 100, 10)).toBeNull();
    expect(wallForPosition({ ...t, playing: false }, 10, 100)).toBeNull();
  });
});

group("clampToLoop", () => {
  it("keeps a position inside the locators and takes an outside one to the start", () => {
    const loop = { startS: 8, endS: 12 };
    expect(clampToLoop(9, loop)).toBe(9);
    expect(clampToLoop(2, loop)).toBe(8);
    expect(clampToLoop(12, loop)).toBe(8);
    expect(clampToLoop(2, null)).toBe(2);
  });
});

group("bars", () => {
  it("starts the session at bar 1, second zero", () => {
    const tempo = { bpm: 120, beatsPerBar: 4 };
    expect(secondsPerBar(tempo)).toBe(2);
    expect(barToSeconds(1, tempo)).toBe(0);
    expect(barToSeconds(9, tempo)).toBe(16);
    expect(barToSeconds(-3, tempo)).toBe(0);
  });

  it("turns 'loop bars 9 to 16' into locators", () => {
    expect(loopForBars(9, 16, { bpm: 90, beatsPerBar: 4 })).toEqual({ startS: (60 / 90) * 4 * 8, endS: (60 / 90) * 4 * 15 });
  });

  it("refuses rather than guessing when there is no tempo", () => {
    expect(loopForBars(9, 16, null)).toBeNull();
    expect(loopForBars(9, 16, { bpm: 0, beatsPerBar: 4 })).toBeNull();
    expect(loopForBars(16, 9, { bpm: 90, beatsPerBar: 4 })).toBeNull();
    expect(barAt(10, null)).toBeNull();
  });

  it("says which bar a second is in", () => {
    const tempo = { bpm: 120, beatsPerBar: 4 };
    expect(barAt(0, tempo)).toBe(1);
    expect(barAt(1.9, tempo)).toBe(1);
    expect(barAt(2, tempo)).toBe(2);
    expect(barAt(17, tempo)).toBe(9);
  });
});

// --- the wrap the prototype found ------------------------------------------
//
// A loop length that is not a round binary number — four bars at 92 BPM, which
// is what the demo session runs at — makes the wrap walls themselves sums of
// repeating fractions. Some of those sums land a float hair *short* of a whole
// number of passes, and the remainder then reads as very nearly a whole loop:
// the last nanosecond of pass n rather than the first of pass n + 1.
//
// The consequence was not a nanosecond. `segmentsInWindow` walks from one wrap
// to the next by adding `endS - position`, so a position a hair below the end
// locator advanced the cursor by 7e-15 of a second; the walk then marked time
// until its guard stopped it and the segment for the new pass was never
// produced. Every region on every lane missed that wrap, was noticed on the
// next 60 ms tick, and joined 6.5 ms into itself with its head cut off — once
// every few passes, for ever. On a drum break that is the attack of the kick
// on the one.
group("wrapping on a loop whose length is not a round number", () => {
  const length = 4 * ((60 / 92) * 4); // four bars at 92 BPM
  const t = rolling({ anchorS: 0, anchorWall: 0.03, loop: { startS: 0, endS: length } });

  it("reads an exact wrap wall as the start of the next pass, not the end of the last", () => {
    for (let pass = 1; pass <= 200; pass++) {
      const wall = 0.03 + pass * length;
      expect(positionAt(t, wall), `pass ${pass}`).toBeCloseTo(0, 9);
      expect(passAt(t, wall), `pass ${pass}`).toBe(pass);
    }
  });

  it("produces the segment after every wrap, so nothing is scheduled late", () => {
    for (let pass = 1; pass <= 200; pass++) {
      const wrap = 0.03 + pass * length;
      // a window that straddles the wrap, the way a 60 ms tick with a 250 ms
      // lookahead does
      const segments = segmentsInWindow(t, wrap - 0.05, wrap + 0.2);
      expect(segments.length, `pass ${pass}`).toBe(2);
      expect(segments[0]!.pass, `pass ${pass}`).toBe(pass - 1);
      expect(segments[1]!.pass, `pass ${pass}`).toBe(pass);
      expect(segments[1]!.startS, `pass ${pass}`).toBeCloseTo(0, 9);
      expect(segments[1]!.startWall - wrap, `pass ${pass}`).toBeLessThan(1e-9);
    }
  });

  it("tiles every window exactly, with no gap at the seam", () => {
    for (let pass = 1; pass <= 50; pass++) {
      const from = 0.03 + pass * length - 0.07;
      const segments = segmentsInWindow(t, from, from + 0.25);
      expect(segments[0]!.startWall).toBeCloseTo(from, 12);
      for (let i = 1; i < segments.length; i++) expect(segments[i]!.startWall).toBeCloseTo(segments[i - 1]!.endWall, 12);
      expect(segments[segments.length - 1]!.endWall).toBeCloseTo(from + 0.25, 12);
    }
  });

  it("never spins: a window is walked in one segment per pass, however long it is", () => {
    // exactly six passes, so the window ends on the sixth wrap
    expect(segmentsInWindow(t, 0.03, 0.03 + length * 6).length).toBe(6);
    // a hair past it, so the seventh has started
    expect(segmentsInWindow(t, 0.03, 0.03 + length * 6 + 0.01).length).toBe(7);
  });
});
