// The bar ruler and the grid behind the lanes. Two things worth asserting in
// markup rather than by eye: the labels really are bar numbers at the right
// pixels, and a session with no measured tempo gets a ruler in seconds instead
// of bars nobody counted.

import { renderToStaticMarkup } from "react-dom/server";
import { describe as group, expect, it } from "vitest";
import type { SessionTempo } from "@/lib/session/time";
import { laneGridStyle, TimelineRuler } from "./TimelineRuler";

const NINETY: SessionTempo = { bpm: 90, beatsPerBar: 4 };
const BAR = (60 / 90) * 4;

group("the ruler", () => {
  it("labels the bars, at the pixel the bar starts on", () => {
    const html = renderToStaticMarkup(<TimelineRuler fromS={0} toS={16} tempo={NINETY} minSpacingS={1.5} pxPerSecond={50} widthPx={800} loop={null} />);
    expect(html).toContain(">1<");
    expect(html).toContain(">2<");
    // bar 2 begins one bar in: 2.667 s at 50 px a second
    expect(html).toContain(`left:${BAR * 50}px`);
  });

  it("draws the locators as a band a producer can see the loop in", () => {
    const html = renderToStaticMarkup(<TimelineRuler fromS={0} toS={30} tempo={NINETY} minSpacingS={1.5} pxPerSecond={50} widthPx={800} loop={{ startS: BAR * 8, endS: BAR * 16 }} />);
    expect(html).toContain("bg-pad/25");
    expect(html).toContain(`left:${BAR * 8 * 50}px`);
  });

  it("rules in seconds when the session has no tempo, rather than inventing bars", () => {
    const html = renderToStaticMarkup(<TimelineRuler fromS={0} toS={30} tempo={null} minSpacingS={4} pxPerSecond={50} widthPx={800} loop={null} />);
    expect(html).toContain("0:05");
    expect(html).not.toContain(">1<");
  });
});

group("the grid behind the lanes", () => {
  it("is two repeating gradients, not a line per division", () => {
    const style = laneGridStyle(50, NINETY);
    expect(String(style.backgroundImage)).toContain("repeating-linear-gradient");
    // a bar is 2.667 s, so 133.3 px at this zoom
    expect(String(style.backgroundImage)).toContain(`${BAR * 50}px`);
  });

  it("drops the beat layer when the beats are too close together to read", () => {
    const wide = String(laneGridStyle(50, NINETY).backgroundImage).split("repeating-linear-gradient").length - 1;
    const tight = String(laneGridStyle(6, NINETY).backgroundImage).split("repeating-linear-gradient").length - 1;
    expect(wide).toBe(2);
    expect(tight).toBe(1);
  });

  it("draws no grid at all without a tempo, and none when a bar is under a pixel", () => {
    expect(laneGridStyle(50, null)).toEqual({});
    expect(laneGridStyle(0.1, NINETY)).toEqual({});
  });
});
