// Test doubles for the pads: a clock a test steps by hand and a backend that
// records what it was asked to do. Mirrors lib/session/fakes.ts — the point of
// both is that every timing decision is asserted in node, in milliseconds,
// with no browser anywhere.

import type { PadBackend, PadVoiceSpec } from "./backend";

export interface StartedSpec extends PadVoiceSpec {
  /** clock time the backend was asked to start it */
  at: number;
}

export interface ReleasedVoice {
  voiceId: number;
  fadeS: number;
  at: number;
}

export class FakePadBackend implements PadBackend {
  clock = 0;
  started: StartedSpec[] = [];
  released: ReleasedVoice[] = [];
  stopped: number[] = [];
  resumes = 0;
  disposed = false;
  latencyS = 0;
  /** fileId -> duration seconds; a file not here is "not decoded" */
  private ready = new Map<string, number>();
  private live = new Set<number>();
  private ended = new Set<(voiceId: number) => void>();
  private loaders = new Map<string, (duration: number) => void>();

  constructor(ready: Record<string, number> = {}) {
    for (const [fileId, duration] of Object.entries(ready)) this.ready.set(fileId, duration);
  }

  /** Pretend a file decoded, with this length. */
  makeReady(fileId: string, durationS: number): void {
    this.ready.set(fileId, durationS);
    this.loaders.get(fileId)?.(durationS);
    this.loaders.delete(fileId);
  }

  advance(seconds: number): void {
    this.clock += seconds;
  }

  now(): number {
    return this.clock;
  }

  resume(): void {
    this.resumes++;
  }

  isReady(fileId: string): boolean {
    return this.ready.has(fileId);
  }

  durationOf(fileId: string): number | null {
    return this.ready.get(fileId) ?? null;
  }

  load(fileId: string, getUrl: () => Promise<string>): Promise<number> {
    const known = this.ready.get(fileId);
    if (known !== undefined) return getUrl().then(() => known);
    return getUrl().then(
      () =>
        new Promise<number>((resolve) => {
          this.loaders.set(fileId, resolve);
        }),
    );
  }

  start(spec: PadVoiceSpec): boolean {
    if (!this.ready.has(spec.fileId)) return false;
    this.started.push({ ...spec, at: this.clock });
    this.live.add(spec.voiceId);
    return true;
  }

  release(voiceId: number, fadeS: number): void {
    if (!this.live.has(voiceId)) return;
    this.released.push({ voiceId, fadeS, at: this.clock });
    this.live.delete(voiceId);
    for (const fn of this.ended) fn(voiceId);
  }

  stop(voiceId: number): void {
    if (!this.live.has(voiceId)) return;
    this.stopped.push(voiceId);
    this.live.delete(voiceId);
    for (const fn of this.ended) fn(voiceId);
  }

  stopAll(): void {
    for (const id of [...this.live]) this.stop(id);
  }

  /** A voice reaching its own end, as the browser's `onended` would report it. */
  finish(voiceId: number): void {
    if (!this.live.has(voiceId)) return;
    this.live.delete(voiceId);
    for (const fn of this.ended) fn(voiceId);
  }

  onEnded(handler: (voiceId: number) => void): () => void {
    this.ended.add(handler);
    return () => {
      this.ended.delete(handler);
    };
  }

  outputLatencyS(): number {
    return this.latencyS;
  }

  forget(fileId: string): void {
    this.ready.delete(fileId);
  }

  dispose(): void {
    this.disposed = true;
    this.stopAll();
    this.ready.clear();
  }

  sounding(): number[] {
    return [...this.live];
  }
}
