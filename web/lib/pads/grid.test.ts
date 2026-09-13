import { describe, expect, it } from "vitest";
import { barSeconds, barsCovering, beatTimes, countInSeconds, placeHit, stepSeconds, stepsPerBar } from "./grid";

describe("grid arithmetic", () => {
  it("derives step, bar and count-in lengths from the tempo", () => {
    expect(stepSeconds(120)).toBeCloseTo(0.125, 12);
    expect(barSeconds(90)).toBeCloseTo(60 / 90 * 4, 12);
    expect(barSeconds(90, 3)).toBeCloseTo(2, 12);
    expect(countInSeconds(120)).toBeCloseTo(2, 12);
    expect(stepsPerBar()).toBe(16);
    expect(stepsPerBar(3)).toBe(12);
    expect(() => stepSeconds(0)).toThrow();
  });

  it("places hits on the nearest 16th with the offset in ms, positive when late", () => {
    // 90 BPM: beat 0.6667 s, 16th 0.16667 s, bar 2.6667 s
    const step = 60 / 90 / 4;
    const onTheOne = placeHit(0, 90);
    expect(onTheOne).toEqual({ bar: 0, step: 0, global_step: 0, offset_ms: 0 });

    const late = placeHit(step * 6 + 0.02, 90);
    expect(late.bar).toBe(0);
    expect(late.step).toBe(6);
    expect(late.offset_ms).toBeCloseTo(20, 6);

    const early = placeHit(step * 6 - 0.015, 90);
    expect(early.step).toBe(6);
    expect(early.offset_ms).toBeCloseTo(-15, 6);

    const bar2 = placeHit(step * 16 * 2 + step * 3 + 0.004, 90);
    expect(bar2.bar).toBe(2);
    expect(bar2.step).toBe(3);
    expect(bar2.global_step).toBe(35);
    expect(bar2.offset_ms).toBeCloseTo(4, 6);
  });

  it("follows the meter for steps per bar", () => {
    const step = 60 / 120 / 4;
    const waltz = placeHit(step * 12, 120, 3);
    expect(waltz).toEqual({ bar: 1, step: 0, global_step: 12, offset_ms: 0 });
  });

  it("never returns a negative step for an early first hit", () => {
    const hit = placeHit(-0.03, 120);
    expect(hit.global_step).toBe(0);
    expect(hit.offset_ms).toBeCloseTo(-30, 6);
  });

  it("counts whole bars covering a length", () => {
    expect(barsCovering(0, 120)).toBe(1);
    expect(barsCovering(2, 120)).toBe(1);
    expect(barsCovering(2.001, 120)).toBe(2);
    expect(barsCovering(7.9, 120)).toBe(4);
  });

  it("lists beat times for the click", () => {
    expect(beatTimes(10, 120, 1)).toEqual([10, 10.5, 11, 11.5]);
    expect(beatTimes(0, 60, 2, 3)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
