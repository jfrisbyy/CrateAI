import { describe as group, expect, it } from "vitest";
import type { Peaks } from "@/lib/types/db";
import { markerX, spanBox, wavePath } from "./peaks";

function peaks(values: Array<[number, number]>): Peaks {
  return { version: 1, points: values.length, min: values.map((v) => v[0]), max: values.map((v) => v[1]) };
}

group("wavePath", () => {
  it("draws a closed path across the full width", () => {
    const { path, columns } = wavePath(peaks([[-1, 1], [-0.5, 0.5], [-0.2, 0.2]]), 100, 40);
    expect(columns).toBe(3);
    expect(path.startsWith("M 0 0")).toBe(true);
    expect(path.endsWith("Z")).toBe(true);
    expect(path).toContain("100 "); // the last column is at the right edge
  });

  it("resamples a long peak array down to the columns it can draw", () => {
    const many = peaks(Array.from({ length: 4000 }, (_, i) => [-(i % 10) / 10, (i % 10) / 10] as [number, number]));
    const { columns, path } = wavePath(many, 300, 40, 120);
    expect(columns).toBe(120);
    expect(path.split("L").length - 1).toBe(2 * 120 - 1);
  });

  it("keeps a hair of ink for silence so the row still has a shape", () => {
    const { path } = wavePath(peaks([[0, 0], [0, 0]]), 100, 40);
    expect(path).not.toContain("NaN");
    expect(path).toContain("19.76"); // just off the centre line, not on it
  });

  it("draws a flat line rather than nothing when a file has no stored peaks", () => {
    expect(wavePath(null, 100, 40).columns).toBe(0);
    expect(wavePath(null, 100, 40).path).toContain("M 0 ");
    expect(wavePath({ version: 1, points: 0, min: [], max: [] }, 100, 40).path).toContain("Z");
  });

  it("draws nothing into a box with no room", () => {
    expect(wavePath(peaks([[-1, 1]]), 0, 40).path).toBe("");
  });
});

group("spanBox", () => {
  it("puts the region where it belongs in the file", () => {
    expect(spanBox(30, 60, 120, 400)).toEqual({ x: 100, width: 100 });
  });

  it("never disappears, however short the region", () => {
    expect(spanBox(10, 10.001, 600, 300).width).toBe(1);
  });

  it("clamps a region that runs past the end of the file", () => {
    expect(spanBox(-5, 200, 100, 100)).toEqual({ x: 0, width: 100 });
  });

  it("covers the whole width when the duration is unknown", () => {
    expect(spanBox(0, 10, null, 250)).toEqual({ x: 0, width: 250 });
  });
});

group("markerX", () => {
  it("places a moment along the row", () => {
    expect(markerX(30, 120, 400)).toBe(100);
    expect(markerX(1000, 120, 400)).toBe(400);
    expect(markerX(5, null, 400)).toBe(0);
  });
});
