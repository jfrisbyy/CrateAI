// Musical time, not pixel time. These are the assertions that a drag, a
// keyboard nudge and a sentence all land on the same division, and that a
// session with no measured tempo says so instead of inventing bars.

import { describe as group, expect, it } from "vitest";
import {
  divisionSeconds,
  FREE_GRID,
  nudgeSeconds,
  positionLabel,
  rulerTicks,
  snapCeil,
  snapFloor,
  snapLabel,
  snapTime,
  snapUnitFrom,
  snaps,
  SNAP_UNITS,
  type Grid,
} from "./snap";
import type { SessionTempo } from "./time";

const NINETY: SessionTempo = { bpm: 90, beatsPerBar: 4 };
// 90 BPM four-four: a beat is 0.6667 s, a bar is 2.6667 s, a sixteenth 0.16667 s.
const BAR = (60 / 90) * 4;
const BEAT = 60 / 90;

function grid(snap: Grid["snap"], tempo: SessionTempo | null = NINETY): Grid {
  return { tempo, snap };
}

group("the divisions", () => {
  it("is the session's bar, beat, eighth and sixteenth", () => {
    expect(divisionSeconds(grid("bar"))).toBeCloseTo(BAR, 9);
    expect(divisionSeconds(grid("beat"))).toBeCloseTo(BEAT, 9);
    expect(divisionSeconds(grid("eighth"))).toBeCloseTo(BEAT / 2, 9);
    expect(divisionSeconds(grid("sixteenth"))).toBeCloseTo(BEAT / 4, 9);
  });

  it("has no division when the producer turned snapping off", () => {
    expect(divisionSeconds(grid("off"))).toBeNull();
    expect(snaps(grid("off"))).toBe(false);
  });

  it("has no division when the session has no measured tempo, and does not invent one", () => {
    expect(divisionSeconds(grid("bar", null))).toBeNull();
    expect(divisionSeconds(grid("sixteenth", { bpm: 0, beatsPerBar: 4 }))).toBeNull();
    expect(divisionSeconds(grid("bar", { bpm: 90, beatsPerBar: 0 }))).toBeNull();
    expect(snaps(grid("bar", null))).toBe(false);
  });

  it("names every unit it offers", () => {
    for (const unit of SNAP_UNITS) expect(snapLabel(unit).length).toBeGreaterThan(0);
  });
});

group("snapping", () => {
  it("takes a second to the nearest division", () => {
    expect(snapTime(2.5, grid("bar"))).toBeCloseTo(BAR, 9); // nearer bar 2 than bar 1
    expect(snapTime(1.2, grid("bar"))).toBe(0);
    expect(snapTime(0.4, grid("beat"))).toBeCloseTo(BEAT, 9);
    expect(snapTime(0.3, grid("beat"))).toBe(0);
  });

  it("leaves the second alone with snapping off, so free placement is really free", () => {
    expect(snapTime(2.5, grid("off"))).toBe(2.5);
    expect(snapTime(2.5, FREE_GRID)).toBe(2.5);
    expect(snapTime(2.5, grid("bar", null))).toBe(2.5);
  });

  it("floors and ceils to a division for the edges that may not cross one", () => {
    expect(snapFloor(3, grid("bar"))).toBeCloseTo(BAR, 9);
    expect(snapCeil(3, grid("bar"))).toBeCloseTo(BAR * 2, 9);
    // already on a division: both leave it alone
    expect(snapFloor(BAR, grid("bar"))).toBeCloseTo(BAR, 9);
    expect(snapCeil(BAR, grid("bar"))).toBeCloseTo(BAR, 9);
  });

  it("keeps the sign and survives nonsense", () => {
    expect(snapTime(Number.NaN, grid("bar"))).toBeNaN();
    expect(snapTime(-1.2, grid("bar"))).toBe(-0); // callers clamp to the timeline, not this
  });
});

group("the keyboard's step", () => {
  it("is the snap division when there is one", () => {
    expect(nudgeSeconds(grid("bar"))).toBeCloseTo(BAR, 9);
    expect(nudgeSeconds(grid("sixteenth"))).toBeCloseTo(BEAT / 4, 9);
  });

  it("falls back to a sixteenth with snapping off, so an arrow key still does something", () => {
    expect(nudgeSeconds(grid("off"))).toBeCloseTo(BEAT / 4, 9);
  });

  it("falls back to a tenth of a second when there is no tempo at all", () => {
    expect(nudgeSeconds(grid("off", null))).toBe(0.1);
  });
});

group("the words for a division", () => {
  it("understands what a producer types", () => {
    expect(snapUnitFrom("bars")).toBe("bar");
    expect(snapUnitFrom("beat")).toBe("beat");
    expect(snapUnitFrom("quarters")).toBe("beat");
    expect(snapUnitFrom("16ths")).toBe("sixteenth");
    expect(snapUnitFrom("1/16")).toBe("sixteenth");
    expect(snapUnitFrom("1/8")).toBe("eighth");
    expect(snapUnitFrom("off")).toBe("off");
    expect(snapUnitFrom("free")).toBe("off");
    expect(snapUnitFrom("horns")).toBeNull();
  });
});

group("the ruler", () => {
  it("draws a labelled line on every bar when they fit", () => {
    const ticks = rulerTicks(0, BAR * 4, NINETY, 1.5);
    const bars = ticks.filter((t) => t.kind === "bar");
    expect(bars.map((t) => t.label)).toEqual(["1", "2", "3", "4"]);
    expect(bars[0]?.atS).toBe(0);
    expect(bars[1]?.atS).toBeCloseTo(BAR, 9);
  });

  it("adds beats and sixteenths only when they are far enough apart to see", () => {
    const coarse = rulerTicks(0, BAR * 2, NINETY, 1.5);
    expect(coarse.some((t) => t.kind === "beat")).toBe(false);
    const fine = rulerTicks(0, BAR * 2, NINETY, 0.6);
    expect(fine.some((t) => t.kind === "beat")).toBe(true);
    expect(fine.some((t) => t.kind === "sixteenth")).toBe(false);
    const finest = rulerTicks(0, BAR * 2, NINETY, 0.1);
    expect(finest.some((t) => t.kind === "sixteenth")).toBe(true);
  });

  it("never draws two lines on the same second", () => {
    const ticks = rulerTicks(0, BAR * 4, NINETY, 0.1);
    const seconds = ticks.map((t) => t.atS.toFixed(6));
    expect(new Set(seconds).size).toBe(seconds.length);
  });

  it("labels every second bar, then every fourth, as the song is zoomed out", () => {
    const two = rulerTicks(0, BAR * 16, NINETY, BAR * 1.5).filter((t) => t.kind === "bar");
    expect(two.map((t) => t.label)).toEqual(["1", "3", "5", "7", "9", "11", "13", "15"]);
    const four = rulerTicks(0, BAR * 16, NINETY, BAR * 3).filter((t) => t.kind === "bar");
    expect(four.map((t) => t.label)).toEqual(["1", "5", "9", "13"]);
  });

  it("stays in order and inside the window when the window does not start at zero", () => {
    const ticks = rulerTicks(BAR * 5.5, BAR * 9, NINETY, 1.5);
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      expect(tick.atS).toBeGreaterThanOrEqual(BAR * 5.5 - 1e-9);
      expect(tick.atS).toBeLessThan(BAR * 9);
    }
    expect([...ticks].sort((a, b) => a.atS - b.atS)).toEqual(ticks);
    expect(ticks[0]?.label).toBe("7"); // bar 7 starts at 6 bars in, the first one inside the window
  });

  it("rules in seconds when there is no tempo, rather than drawing bars that do not exist", () => {
    const ticks = rulerTicks(0, 30, null, 4);
    expect(ticks.every((t) => t.kind === "second")).toBe(true);
    expect(ticks.map((t) => t.atS)).toEqual([0, 5, 10, 15, 20, 25]);
  });

  it("draws nothing for an empty or backwards window", () => {
    expect(rulerTicks(10, 10, NINETY, 1)).toEqual([]);
    expect(rulerTicks(10, 4, NINETY, 1)).toEqual([]);
  });

  it("is bounded, so a whole song at full zoom cannot make a hundred thousand lines", () => {
    expect(rulerTicks(0, 60 * 8, NINETY, 0.01).length).toBeLessThanOrEqual(600);
  });
});

group("naming a position", () => {
  it("says the bar, and the beat inside it when it is not the one", () => {
    expect(positionLabel(0, NINETY)).toBe("bar 1");
    expect(positionLabel(BAR * 16, NINETY)).toBe("bar 17");
    expect(positionLabel(BAR * 16 + BEAT, NINETY)).toBe("bar 17.2");
  });

  it("falls back to the clock when the session has no bars", () => {
    expect(positionLabel(12.5, null)).toBe("12.50s");
  });
});
