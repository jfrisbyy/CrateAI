import { describe, expect, it } from "vitest";
import { LATENCY_TARGET_MS, LatencyStats, describeLatency, latencySample } from "./latency";

describe("key to sound", () => {
  it("adds the three parts: the event reaching us, the schedule, and the output", () => {
    const sample = latencySample({ eventTimeStampMs: 1000, handledAtMs: 1003.5, scheduleAheadS: 0, outputLatencyS: 0.011 });
    expect(sample.inputMs).toBe(3.5);
    expect(sample.scheduleMs).toBe(0);
    expect(sample.outputMs).toBe(11);
    expect(sample.totalMs).toBe(14.5);
    expect(sample.partial).toBe(false);
  });

  it("reports an unusable event timestamp as unknown rather than as zero", () => {
    const behind = latencySample({ eventTimeStampMs: 5000, handledAtMs: 1000, outputLatencyS: 0.01 });
    expect(behind.inputMs).toBeNull();
    expect(behind.partial).toBe(true);
    expect(behind.totalMs).toBe(10);
    const stale = latencySample({ eventTimeStampMs: 0, handledAtMs: 10_000, outputLatencyS: 0.01 });
    expect(stale.inputMs).toBeNull();
  });

  it("counts a lookahead when there is one, because a scheduled pad is a late pad", () => {
    const sample = latencySample({ eventTimeStampMs: 0, handledAtMs: 2, scheduleAheadS: 0.025, outputLatencyS: 0.005 });
    expect(sample.totalMs).toBe(32);
  });

  it("summarises what a producer feels: the median and the 95th, not the mean", () => {
    const stats = new LatencyStats();
    for (const ms of [8, 9, 10, 11, 12, 13, 14, 60]) {
      stats.add(latencySample({ eventTimeStampMs: 0, handledAtMs: ms, outputLatencyS: 0 }));
    }
    expect(stats.count).toBe(8);
    expect(stats.percentile(0.5)).toBe(11);
    expect(stats.percentile(0.95)).toBe(60);
    expect(stats.worst()).toBe(60);
  });

  it("says nothing at all before anything is measured", () => {
    const stats = new LatencyStats();
    expect(stats.percentile(0.5)).toBeNull();
    expect(describeLatency(stats.summary())).toBe("No key-to-sound measurement yet; play a pad.");
  });

  it("names the 20 ms line either way", () => {
    const good = new LatencyStats();
    good.add(latencySample({ eventTimeStampMs: 0, handledAtMs: 3, outputLatencyS: 0.008 }));
    expect(describeLatency(good.summary())).toContain("inside the 20 ms");
    const bad = new LatencyStats();
    bad.add(latencySample({ eventTimeStampMs: 0, handledAtMs: 30, outputLatencyS: 0.02 }));
    expect(describeLatency(bad.summary())).toContain("past the 20 ms");
    expect(LATENCY_TARGET_MS).toBe(20);
  });

  it("keeps a bounded window so a long session does not grow without end", () => {
    const stats = new LatencyStats(10);
    for (let i = 0; i < 50; i++) stats.add(latencySample({ eventTimeStampMs: 0, handledAtMs: i, outputLatencyS: 0 }));
    expect(stats.count).toBe(10);
    expect(stats.worst()).toBe(49);
    stats.reset();
    expect(stats.count).toBe(0);
  });
});
