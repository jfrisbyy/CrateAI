// Zoom and scroll over a several-minute song. The two properties that decide
// whether the timeline is usable: zooming holds the music still under the
// pointer, and only what is on screen is ever drawn.

import { describe as group, expect, it } from "vitest";
import {
  clampViewport,
  clampZoom,
  DEFAULT_PX_PER_S,
  handleWidthPx,
  inView,
  MAX_PX_PER_S,
  MIN_PX_PER_S,
  minTickSpacingS,
  regionsInView,
  scrollBy,
  scrollTo,
  scrollToShow,
  scrollableSeconds,
  timeToX,
  visibleSeconds,
  visibleSpan,
  xToTime,
  zoomBy,
  zoomToFit,
  type Viewport,
} from "./viewport";
import type { SessionRegion } from "./types";

function view(overrides: Partial<Viewport> = {}): Viewport {
  return { pxPerSecond: 50, scrollS: 0, widthPx: 1000, ...overrides };
}

function region(id: string, startS: number, durationS: number): SessionRegion {
  return { id, trackId: "t1", sourceId: "f1", startS, durationS, offsetS: 0, gain: 1 };
}

group("pixels and seconds", () => {
  it("converts both ways and round-trips", () => {
    const v = view({ scrollS: 12 });
    expect(timeToX(12, v)).toBe(0);
    expect(timeToX(14, v)).toBe(100);
    expect(xToTime(100, v)).toBe(14);
    expect(xToTime(timeToX(37.25, v), v)).toBeCloseTo(37.25, 9);
  });

  it("knows how much of the song is on screen", () => {
    expect(visibleSeconds(view())).toBe(20);
    expect(visibleSpan(view({ scrollS: 5 }))).toEqual({ fromS: 5, toS: 25 });
  });
});

group("zoom", () => {
  it("holds the second under the pointer still", () => {
    const v = view({ scrollS: 30 });
    const anchorX = 400;
    const anchorS = xToTime(anchorX, v);
    const zoomed = zoomBy(v, 2, anchorX, 600);
    expect(xToTime(anchorX, zoomed)).toBeCloseTo(anchorS, 9);
    expect(zoomed.pxPerSecond).toBe(100);
  });

  it("comes back to the same place after zooming in and out again", () => {
    const v = view({ scrollS: 30 });
    const there = zoomBy(v, 1.6, 400, 600);
    const back = zoomBy(there, 1 / 1.6, 400, 600);
    expect(back.pxPerSecond).toBeCloseTo(v.pxPerSecond, 9);
    expect(back.scrollS).toBeCloseTo(v.scrollS, 9);
  });

  it("stops at the ends rather than going to a pixel a second or a second a pixel", () => {
    expect(clampZoom(0)).toBe(DEFAULT_PX_PER_S);
    expect(clampZoom(Number.NaN)).toBe(DEFAULT_PX_PER_S);
    expect(zoomBy(view({ pxPerSecond: MAX_PX_PER_S }), 4, 0, 600).pxPerSecond).toBe(MAX_PX_PER_S);
    expect(zoomBy(view({ pxPerSecond: MIN_PX_PER_S }), 0.25, 0, 600).pxPerSecond).toBe(MIN_PX_PER_S);
  });

  it("fits a whole song on screen, and a long one only as far as the zoom goes", () => {
    const fitted = zoomToFit(view(), 240);
    expect(fitted.scrollS).toBe(0);
    expect(visibleSeconds(fitted)).toBeGreaterThanOrEqual(240);
    // 8 hours would need less than 2 px a second; the zoom floor wins and says so
    expect(zoomToFit(view(), 60 * 60 * 8).pxPerSecond).toBe(MIN_PX_PER_S);
  });

  it("fits an empty song without dividing by zero", () => {
    expect(Number.isFinite(zoomToFit(view(), 0).pxPerSecond)).toBe(true);
    expect(Number.isFinite(zoomToFit(view({ widthPx: 0 }), 0).pxPerSecond)).toBe(true);
  });
});

group("scroll", () => {
  it("never goes before bar 1", () => {
    expect(scrollBy(view(), -10, 600).scrollS).toBe(0);
    expect(scrollTo(view(), -5, 600).scrollS).toBe(0);
    expect(clampViewport(view({ scrollS: Number.NaN }), 600).scrollS).toBe(0);
  });

  it("leaves room past the end of the song, so a region can always be dragged somewhere new", () => {
    const v = view();
    expect(scrollableSeconds(120, v)).toBeGreaterThan(120);
    expect(scrollableSeconds(0, v)).toBe(visibleSeconds(v));
    const far = scrollTo(v, 10_000, 120);
    expect(far.scrollS).toBeLessThanOrEqual(scrollableSeconds(120, v) - visibleSeconds(v) + 1e-9);
    expect(far.scrollS).toBeGreaterThan(100);
  });

  it("follows the playhead only when it leaves the screen, and says so by identity", () => {
    const v = view({ scrollS: 0 }); // 0-20 s on screen
    expect(scrollToShow(v, 10, 600)).toBe(v); // already comfortably inside: nothing moves
    const moved = scrollToShow(v, 40, 600);
    expect(moved).not.toBe(v);
    expect(moved.scrollS).toBeCloseTo(40 - 20 * 0.15, 9);
    // and at the very start there is nowhere to scroll back to
    expect(scrollToShow(v, 1, 600)).toBe(v);
  });
});

group("drawing only what is on screen", () => {
  const regions = [region("a", 0, 8), region("b", 18, 4), region("c", 40, 4), region("d", 19.5, 100)];

  it("keeps a region that is partly on screen", () => {
    const v = view({ scrollS: 0 }); // 0-20 s
    expect(inView(regions[0] as SessionRegion, v)).toBe(true);
    expect(inView(regions[1] as SessionRegion, v)).toBe(true); // starts at 18, inside
    expect(inView(regions[2] as SessionRegion, v)).toBe(false);
  });

  it("keeps a region that starts before the screen and ends after it", () => {
    const v = view({ scrollS: 60 }); // 60-80 s; region d runs 19.5-119.5
    expect(inView(regions[3] as SessionRegion, v)).toBe(true);
  });

  it("culls to what is drawn, in timeline order", () => {
    const v = view({ scrollS: 0 });
    expect(regionsInView(regions, v).map((r) => r.id)).toEqual(["a", "b", "d"]);
    expect(regionsInView(regions, view({ scrollS: 100 })).map((r) => r.id)).toEqual(["d"]);
    expect(regionsInView(regions, view({ scrollS: 500 }))).toEqual([]);
  });

  it("culls four hundred regions down to what fits, which is the whole point", () => {
    const many = Array.from({ length: 400 }, (_, i) => region(`r${i}`, i * 2, 2));
    expect(regionsInView(many, view({ scrollS: 0 }))).toHaveLength(10);
    expect(many).toHaveLength(400);
  });

  it("pads the cull so a region being dragged in from off screen is already drawn", () => {
    const v = view({ scrollS: 0 });
    expect(inView(region("x", 22, 2), v)).toBe(false);
    expect(inView(region("x", 22, 2), v, 5)).toBe(true);
  });
});

group("the ruler's density, from the zoom", () => {
  it("asks for coarser ticks the further out the song is", () => {
    expect(minTickSpacingS(view({ pxPerSecond: 100 }))).toBeCloseTo(0.56, 9);
    expect(minTickSpacingS(view({ pxPerSecond: 4 }))).toBeCloseTo(14, 9);
  });

  it("keeps a trim handle grabbable without swallowing a narrow region", () => {
    expect(handleWidthPx(200)).toBe(8);
    expect(handleWidthPx(12)).toBe(3);
    expect(handleWidthPx(1)).toBe(2);
  });
});
