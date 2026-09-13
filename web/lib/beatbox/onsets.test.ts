import { describe, expect, it } from "vitest";
import { dbOf, OnsetCounter, rmsOf } from "./onsets";

const FRAME_MS = 10;
const SILENCE = -70;

/** One hit: a jump then a fast decay, in dB per 10 ms frame. */
const HIT = [-8, -10, -14, -20, -28, -36, -44, -52, -60, -70];

function run(counter: OnsetCounter, levels: number[]): number[] {
  const hits: number[] = [];
  levels.forEach((db, i) => {
    if (counter.feedDb(db, i * FRAME_MS)) hits.push(i * FRAME_MS);
  });
  return hits;
}

function silence(ms: number): number[] {
  return Array.from({ length: Math.round(ms / FRAME_MS) }, () => SILENCE);
}

describe("OnsetCounter", () => {
  it("counts separated hits once each", () => {
    const seq: number[] = [];
    for (let i = 0; i < 8; i++) seq.push(...silence(200), ...HIT);
    const counter = new OnsetCounter();
    const hits = run(counter, seq);
    expect(hits).toHaveLength(8);
    expect(counter.count).toBe(8);
  });

  it("merges two attacks inside the minimum gap", () => {
    const seq = [...silence(200), ...HIT.slice(0, 3), ...HIT.slice(0, 3), ...HIT];
    expect(run(new OnsetCounter({ minGapMs: 60 }), seq)).toHaveLength(1);
  });

  it("does not double-count a bump in the decay", () => {
    const bumpy = [-8, -12, -16, -14, -13, -20, -26, -32, -40, -50, -60, -70];
    const seq = [...silence(200), ...bumpy, ...silence(200), ...bumpy];
    expect(run(new OnsetCounter(), seq)).toHaveLength(2);
  });

  it("ignores levels under the floor and slow swells", () => {
    const quiet = [...silence(100), -50, -48, -47, -47, -48, -50, ...silence(100)];
    expect(run(new OnsetCounter({ minLevelDb: -45 }), quiet)).toHaveLength(0);
    const swell = Array.from({ length: 100 }, (_, i) => -70 + i * 0.6); // 0.6 dB per frame: 3 dB per 50 ms
    expect(run(new OnsetCounter(), swell)).toHaveLength(0);
  });

  it("re-arms only after the level falls away from the peak", () => {
    // a sustained tone: one rise, then flat, never re-counted
    const seq = [...silence(100), ...Array.from({ length: 60 }, () => -10), ...silence(100), ...HIT];
    expect(run(new OnsetCounter(), seq)).toHaveLength(2);
  });

  it("resets", () => {
    const counter = new OnsetCounter();
    run(counter, [...silence(100), ...HIT]);
    expect(counter.count).toBe(1);
    counter.reset();
    expect(counter.count).toBe(0);
    expect(run(counter, [...silence(100), ...HIT])).toHaveLength(1);
  });

  it("works from RMS frames too", () => {
    const counter = new OnsetCounter();
    let t = 0;
    const feed = (rms: number) => counter.feed(rms, (t += FRAME_MS));
    for (let i = 0; i < 20; i++) feed(0.0003);
    expect(feed(0.4)).toBe(true);
    expect(feed(0.3)).toBe(false);
    expect(counter.count).toBe(1);
  });
});

describe("rmsOf / dbOf", () => {
  it("measures a square wave and clamps silence", () => {
    expect(rmsOf(Float32Array.from([0.5, -0.5, 0.5, -0.5]))).toBeCloseTo(0.5, 9);
    expect(rmsOf(new Float32Array(0))).toBe(0);
    expect(dbOf(1)).toBeCloseTo(0, 9);
    expect(dbOf(0)).toBeCloseTo(-120, 9);
  });
});
