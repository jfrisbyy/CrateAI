// The pads as an instrument: what a key press starts, what a key release
// cuts, and what each voice sounds like.
//
// Two axes, both the producer's choice (PRODUCT_DIRECTION, Surface 4):
//
//   trigger  one-shot  the whole slice plays out, holding changes nothing
//            gate      sounds while the key is down, cut on release
//   play     chop      each key a different slice
//            note      the same slice transposed, rate = 2 ** (semitones / 12)
//
// A release is a 2 ms fade, never a hard stop: cutting a waveform at an
// arbitrary sample is a click, and a producer hunting a chop by tapping
// between two keys hears every one of them.
//
// The Web Audio nodes live behind PadBackend (backend.ts), so everything here
// runs and is asserted in node.

import type { PadBackend, PadLoadStatus, PadVoiceSpec } from "./backend";
import { WebAudioPadBackend } from "./webAudioPads";
import { rateForSemitones } from "./note";

/** Fade in on every voice: a slice rarely starts on a zero crossing. */
export const PAD_FADE_S = 0.003;
/** The key-up fade. Short enough to feel like a cut, long enough not to click. */
export const PAD_RELEASE_S = 0.002;

export type BufferStatus = PadLoadStatus;

export interface NoteOnOptions {
  velocity?: number;
  /** one-shot ignores the key release; gate is cut by it */
  trigger?: "one-shot" | "gate";
  /** note mode: semitones from the root. Ignored in chop mode (0). */
  semitones?: number;
}

export interface StartedVoice {
  /** the audio-clock time the voice started: what the recorder stamps the hit with */
  at: number;
  voiceId: number;
  /** how long it will sound if nothing releases it */
  durationS: number;
}

export class PadEngine {
  private readonly backend: PadBackend;
  private pending = new Map<string, Promise<number>>();
  private errors = new Map<string, string>();
  private durations = new Map<string, number>();
  private voicesByPad = new Map<number, Set<number>>();
  private padOfVoice = new Map<number, number>();
  private listeners = new Set<() => void>();
  private nextVoiceId = 1;
  private offEnded: () => void;

  constructor(backend?: PadBackend) {
    this.backend = backend ?? new WebAudioPadBackend();
    this.offEnded = this.backend.onEnded((voiceId) => this.forgetVoice(voiceId));
  }

  /** The audio clock the recorder and the click read. */
  get context(): AudioContext {
    const ctx = (this.backend as { context?: AudioContext }).context;
    if (!ctx) throw new Error("This pad backend has no AudioContext.");
    return ctx;
  }

  now(): number {
    return this.backend.now();
  }

  /** What the output adds between a start and the sound, seconds; 0 when the browser will not say. */
  outputLatencyS(): number {
    return this.backend.outputLatencyS();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  status(fileId: string): BufferStatus | null {
    if (this.backend.isReady(fileId)) return "ready";
    if (this.pending.has(fileId)) return "loading";
    if (this.errors.has(fileId)) return "error";
    return null;
  }

  errorFor(fileId: string): string | null {
    return this.errors.get(fileId) ?? null;
  }

  durationOf(fileId: string): number | null {
    return this.backend.durationOf(fileId) ?? this.durations.get(fileId) ?? null;
  }

  /** Fetch (via `getUrl`, a signed URL) and decode once; concurrent calls share the promise. */
  load(fileId: string, getUrl: () => Promise<string>): Promise<number> {
    const ready = this.backend.durationOf(fileId);
    if (ready !== null && this.backend.isReady(fileId)) return Promise.resolve(ready);
    const inFlight = this.pending.get(fileId);
    if (inFlight) return inFlight;
    const promise = this.backend.load(fileId, getUrl);
    this.pending.set(fileId, promise);
    this.errors.delete(fileId);
    this.emit();
    promise
      .then((duration) => {
        this.durations.set(fileId, duration);
        this.pending.delete(fileId);
        this.emit();
      })
      .catch((err: unknown) => {
        this.pending.delete(fileId);
        this.errors.set(fileId, err instanceof Error ? err.message : String(err));
        this.emit();
      });
    return promise;
  }

  /** Drop a failed decode so a retry really retries. */
  forget(fileId: string): void {
    this.errors.delete(fileId);
    this.durations.delete(fileId);
    this.backend.forget(fileId);
    this.emit();
  }

  /**
   * Start `fileId` on `pad`. In gate mode the voice waits for `noteOff`; in
   * one-shot it plays out. Returns null when the samples are not in memory —
   * a pad that has not decoded is silent, never late.
   */
  noteOn(pad: number, fileId: string, options: NoteOnOptions = {}): StartedVoice | null {
    const sourceDurationS = this.backend.durationOf(fileId);
    if (sourceDurationS === null || !this.backend.isReady(fileId)) return null;
    this.backend.resume();
    const rate = rateForSemitones(options.semitones ?? 0);
    const gate = options.trigger === "gate";
    const voiceId = this.nextVoiceId++;
    const spec: PadVoiceSpec = {
      voiceId,
      pad,
      fileId,
      gain: Math.max(0, Math.min(1, options.velocity ?? 1)),
      rate,
      attackS: PAD_FADE_S,
      releaseS: PAD_FADE_S,
      sourceDurationS,
      gate,
    };
    const at = this.backend.now();
    if (!this.backend.start(spec)) return null;
    let set = this.voicesByPad.get(pad);
    if (!set) {
      set = new Set();
      this.voicesByPad.set(pad, set);
    }
    set.add(voiceId);
    this.padOfVoice.set(voiceId, pad);
    this.emit();
    return { at, voiceId, durationS: sourceDurationS / rate };
  }

  /**
   * The key came up. Gate voices fade out over PAD_RELEASE_S; one-shot voices
   * are left alone, which is the whole difference between the two modes.
   * Returns how many voices were cut.
   */
  noteOff(pad: number, options: { trigger?: "one-shot" | "gate" } = {}): number {
    if (options.trigger === "one-shot") return 0;
    const set = this.voicesByPad.get(pad);
    if (!set || set.size === 0) return 0;
    let cut = 0;
    for (const voiceId of [...set]) {
      this.backend.release(voiceId, PAD_RELEASE_S);
      cut++;
    }
    return cut;
  }

  /**
   * Release every sounding voice with the same short fade: the window lost
   * focus, the tab went to the background, the producer pressed stop. Without
   * this a gate note hangs the moment someone alt-tabs mid-hold.
   */
  releaseAll(): number {
    let cut = 0;
    for (const set of this.voicesByPad.values()) {
      for (const voiceId of [...set]) {
        this.backend.release(voiceId, PAD_RELEASE_S);
        cut++;
      }
    }
    return cut;
  }

  /** Phase 3's one-shot tap, unchanged: the audio-clock time, or null when the buffer is not ready. */
  trigger(pad: number, fileId: string, velocity = 1): number | null {
    return this.noteOn(pad, fileId, { velocity, trigger: "one-shot" })?.at ?? null;
  }

  isLit(pad: number): boolean {
    return (this.voicesByPad.get(pad)?.size ?? 0) > 0;
  }

  litPads(): number[] {
    return [...this.voicesByPad.entries()].filter(([, set]) => set.size > 0).map(([pad]) => pad);
  }

  voiceCount(): number {
    return this.padOfVoice.size;
  }

  stopAll(): void {
    this.backend.stopAll();
    this.voicesByPad.clear();
    this.padOfVoice.clear();
    this.emit();
  }

  /**
   * Stop everything and drop the decoded audio. The engine stays usable: in
   * development React mounts, unmounts and remounts effects, so a disposed
   * engine may be asked to load again.
   */
  dispose(): void {
    this.stopAll();
    this.errors.clear();
    this.durations.clear();
    this.offEnded();
    this.backend.dispose();
    this.offEnded = this.backend.onEnded((voiceId) => this.forgetVoice(voiceId));
  }

  private forgetVoice(voiceId: number): void {
    const pad = this.padOfVoice.get(voiceId);
    if (pad === undefined) return;
    this.padOfVoice.delete(voiceId);
    const set = this.voicesByPad.get(pad);
    set?.delete(voiceId);
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
