// Test doubles for the transport. The engine takes its clock, its backend and
// its ticker from outside precisely so this file can exist: every timing rule
// in the transport is asserted in node, at exact times, with no audio hardware
// and no waiting.

import type { ScheduledPlay, SourceId, Ticker, TransportBackend } from "./types";

/** A clock a test moves by hand. Seconds, monotonic, never goes backwards. */
export class ManualClock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(seconds: number): number {
    this.t += Math.max(0, seconds);
    return this.t;
  }
  set(seconds: number): void {
    this.t = Math.max(this.t, seconds);
  }
}

/** A ticker the test steps: nothing happens until `step()` is called. */
export class ManualTicker implements Ticker {
  private fn: (() => void) | null = null;
  started = 0;
  stopped = 0;
  start(fn: () => void): void {
    this.fn = fn;
    this.started++;
  }
  stop(): void {
    this.fn = null;
    this.stopped++;
  }
  step(times = 1): void {
    for (let i = 0; i < times; i++) this.fn?.();
  }
  get running(): boolean {
    return this.fn !== null;
  }
}

export interface FakeStart extends ScheduledPlay {
  /** the clock reading when the backend was asked to start it */
  calledAt: number;
}

/**
 * A backend that records instead of sounding. `ready` is the set of decoded
 * sources: adding to it is a decode landing, and that is the whole of the
 * "a track is still decoding" case.
 */
export class FakeBackend implements TransportBackend {
  readonly started: FakeStart[] = [];
  readonly stops: string[] = [];
  readonly trackGains = new Map<string, number>();
  readonly tracks = new Set<string>();
  masterGain = 1;
  resumed = 0;
  /** sources whose samples are in memory; empty means nothing can play yet */
  ready = new Set<SourceId>();
  /** when set, every source is playable — the common case in a test */
  allReady = true;

  constructor(private readonly clock: ManualClock = new ManualClock(0)) {}

  now(): number {
    return this.clock.now();
  }
  resume(): void {
    this.resumed++;
  }
  ensureTrack(trackId: string): void {
    this.tracks.add(trackId);
  }
  removeTrack(trackId: string): void {
    this.tracks.delete(trackId);
    this.trackGains.delete(trackId);
  }
  setTrackGain(trackId: string, gain: number): void {
    this.trackGains.set(trackId, gain);
  }
  setMasterGain(gain: number): void {
    this.masterGain = gain;
  }
  isReady(sourceId: SourceId): boolean {
    return this.allReady || this.ready.has(sourceId);
  }
  start(play: ScheduledPlay): boolean {
    if (!this.isReady(play.sourceId)) return false;
    this.started.push({ ...play, calledAt: this.clock.now() });
    return true;
  }
  stopAll(): void {
    this.stops.push("*");
  }
  stopTrack(trackId: string): void {
    this.stops.push(trackId);
  }

  /** Everything started for one lane, in the order it was scheduled. */
  forTrack(trackId: string): FakeStart[] {
    return this.started.filter((p) => p.trackId === trackId);
  }
  forRegion(regionId: string): FakeStart[] {
    return this.started.filter((p) => p.regionId === regionId);
  }
  clear(): void {
    this.started.length = 0;
    this.stops.length = 0;
  }
}

/** A decoded source of `durationS` seconds, for the cache tests. */
export function fakeDecoded(durationS: number, sampleRate = 44100, channels = 2) {
  const frames = Math.round(durationS * sampleRate);
  return { buffer: { durationS, frames }, bytes: frames * channels * 4, durationS, sampleRate, channels };
}
