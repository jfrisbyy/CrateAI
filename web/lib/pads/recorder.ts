// Record mode: a one-bar count-in click, then pad hits captured against the
// audio clock relative to the record start, for a fixed number of bars or
// until stop. The grid math lives in recording.ts; this file owns the
// clock, the click scheduling and the timers.

import type { PadHitInput } from "@/lib/api/midi";
import { scheduleClick } from "./click";
import { barSeconds, beatSeconds, stepSeconds } from "./grid";
import { acceptsHit, finalizeTake, type RecordedHit, type RecordingSettings } from "./recording";

export type RecorderState = "idle" | "count-in" | "recording" | "done";

export interface RecorderSnapshot {
  state: RecorderState;
  settings: RecordingSettings | null;
  /** audio-clock times */
  recordStart: number | null;
  recordEnd: number | null;
  /** raw hits while armed or recording */
  hits: PadHitInput[];
  /** the finished take */
  take: { bars: number; hits: RecordedHit[] } | null;
}

export interface ArmOptions extends RecordingSettings {
  /** keep a quieter click going while recording (default true) */
  clickWhileRecording?: boolean;
}

const LOOKAHEAD_S = 0.3;
const SCHEDULE_EVERY_MS = 100;
const ARM_DELAY_S = 0.15;

export class PadRecorder {
  private state: RecorderState = "idle";
  private settings: RecordingSettings | null = null;
  private recordStart: number | null = null;
  private recordEnd: number | null = null;
  private hits: PadHitInput[] = [];
  private take: RecorderSnapshot["take"] = null;
  private listeners = new Set<() => void>();
  private timers: number[] = [];
  private clickTimer: number | null = null;
  private nextBeat = 0;
  private clickUntil: number | null = null;

  constructor(private readonly getContext: () => AudioContext) {}

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): RecorderSnapshot {
    return {
      state: this.state,
      settings: this.settings,
      recordStart: this.recordStart,
      recordEnd: this.recordEnd,
      hits: this.hits,
      take: this.take,
    };
  }

  /** Start the count-in now; recording begins one bar later. */
  arm(options: ArmOptions): void {
    this.clear();
    const ctx = this.getContext();
    if (ctx.state === "suspended") void ctx.resume();
    const settings: RecordingSettings = { bpm: options.bpm, beatsPerBar: options.beatsPerBar, bars: options.bars };
    const beat = beatSeconds(settings.bpm);
    const bar = barSeconds(settings.bpm, settings.beatsPerBar);
    const countInStart = ctx.currentTime + ARM_DELAY_S;
    this.settings = settings;
    this.recordStart = countInStart + bar;
    this.recordEnd = settings.bars === null ? null : this.recordStart + bar * settings.bars;
    this.state = "count-in";

    for (let i = 0; i < settings.beatsPerBar; i++) scheduleClick(ctx, countInStart + i * beat, i === 0);

    if (options.clickWhileRecording ?? true) {
      this.nextBeat = this.recordStart;
      this.clickUntil = this.recordEnd;
      this.scheduleClicks();
      this.clickTimer = window.setInterval(() => this.scheduleClicks(), SCHEDULE_EVERY_MS);
    }

    this.timers.push(
      window.setTimeout(
        () => {
          if (this.state === "count-in") {
            this.state = "recording";
            this.emit();
          }
        },
        Math.max(0, (this.recordStart - ctx.currentTime) * 1000),
      ),
    );
    if (this.recordEnd !== null) {
      // a little grace so a hit landing right at the end is still taken
      this.timers.push(window.setTimeout(() => this.stop(), Math.max(0, (this.recordEnd - ctx.currentTime) * 1000) + 60));
    }
    this.emit();
  }

  /** Register a pad trigger that happened at audio-clock time `atTime`. Returns true when it was taken. */
  hit(pad: number, chopFileId: string | null, atTime: number, velocity = 1): boolean {
    if (!this.settings || this.recordStart === null || (this.state !== "count-in" && this.state !== "recording")) return false;
    const timeS = atTime - this.recordStart;
    if (!acceptsHit(timeS, this.settings)) return false;
    this.hits = [...this.hits, { time_s: timeS, pad, chop_file_id: chopFileId, velocity }];
    this.emit();
    return true;
  }

  /** End the take (also called by the fixed-length timer). */
  stop(): void {
    if (this.state !== "count-in" && this.state !== "recording") return;
    const ctx = this.getContext();
    this.clearTimers();
    const settings = this.settings as RecordingSettings;
    const elapsed = this.recordStart === null ? 0 : Math.max(0, ctx.currentTime - this.recordStart);
    this.take = finalizeTake(this.hits, settings, this.recordEnd === null ? elapsed : this.recordEnd - (this.recordStart ?? 0));
    this.state = "done";
    this.emit();
  }

  /** Back to idle, dropping the take. */
  clear(): void {
    this.clearTimers();
    this.state = "idle";
    this.settings = null;
    this.recordStart = null;
    this.recordEnd = null;
    this.hits = [];
    this.take = null;
    this.emit();
  }

  /** Where the take is right now, for the moving readout: bar and step (0-based) or null when idle. */
  position(): { bar: number; step: number; countIn: boolean } | null {
    if (!this.settings || this.recordStart === null) return null;
    if (this.state !== "count-in" && this.state !== "recording") return null;
    const now = this.getContext().currentTime;
    const step = stepSeconds(this.settings.bpm);
    const perBar = this.settings.beatsPerBar * 4;
    const t = now - this.recordStart;
    if (t < 0) {
      const g = Math.floor((t + barSeconds(this.settings.bpm, this.settings.beatsPerBar)) / step);
      return { bar: 0, step: Math.max(0, Math.min(perBar - 1, g)), countIn: true };
    }
    const g = Math.floor(t / step);
    return { bar: Math.floor(g / perBar), step: g % perBar, countIn: false };
  }

  dispose(): void {
    this.clearTimers();
    this.listeners.clear();
  }

  private scheduleClicks(): void {
    if (!this.settings) return;
    const ctx = this.getContext();
    const beat = beatSeconds(this.settings.bpm);
    const horizon = ctx.currentTime + LOOKAHEAD_S;
    while (this.nextBeat < horizon) {
      if (this.clickUntil !== null && this.nextBeat >= this.clickUntil - 1e-6) {
        this.stopClicks();
        return;
      }
      const beatIndex = Math.round((this.nextBeat - (this.recordStart ?? 0)) / beat);
      scheduleClick(ctx, this.nextBeat, beatIndex % this.settings.beatsPerBar === 0, 0.25);
      this.nextBeat += beat;
    }
  }

  private stopClicks(): void {
    if (this.clickTimer !== null) {
      window.clearInterval(this.clickTimer);
      this.clickTimer = null;
    }
  }

  private clearTimers(): void {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    this.stopClicks();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
