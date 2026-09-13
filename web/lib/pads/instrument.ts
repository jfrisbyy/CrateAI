// The instrument: a key press or a pad click in, a voice out.
//
// It owns the three things that are easy to get wrong and impossible to test
// in a browser-less repo if they live in a React effect:
//
//   - OS key repeat. A held key fires `keydown` again and again; a pad already
//     down ignores every one of them (held.ts), so gate mode does not machine-
//     gun and one-shot mode does not stutter.
//   - Lost focus. `releaseAll` on blur, on a hidden tab, on a layout change,
//     on unmount. Without it a gate note hangs the moment someone alt-tabs.
//   - Note mode. Every key plays the *same* slice at 2 ** (semitones / 12),
//     so which file a pad plays depends on the kit, not on the pad.
//
// No React, no DOM, no Web Audio: the hook feeds it events and a fake engine
// stands in for the real one in tests.

import { HeldPads } from "./held";
import { layoutOr, padForKeyIn } from "./layouts";
import { MAX_SIMULTANEOUS_KEYS, type PadKit } from "./kit";
import { semitonesForPad } from "./note";
import type { BufferStatus, NoteOnOptions, StartedVoice } from "./engine";

export interface InstrumentEngine {
  noteOn(pad: number, fileId: string, options?: NoteOnOptions): StartedVoice | null;
  noteOff(pad: number, options?: { trigger?: "one-shot" | "gate" }): number;
  releaseAll(): number;
  status(fileId: string): BufferStatus | null;
}

export interface InstrumentHit {
  /** 1-based pad */
  pad: number;
  fileId: string;
  /** audio-clock time the voice started */
  at: number;
  voiceId: number;
  /** 0 in chop mode */
  semitones: number;
  /** how long it sounds if nothing releases it */
  durationS: number;
  velocity: number;
}

export interface InstrumentRelease {
  pad: number;
  voiceId: number;
  /** audio-clock time the key came up */
  at: number;
  /** how long the key was down, seconds */
  heldS: number;
  /**
   * True when the release actually cut the note. Only then is `heldS` the
   * note's length: in one-shot the slice plays to its end whatever the key
   * does, so a take recorded in one-shot must not keep a hold time as a
   * length or every region would be as long as the producer's finger.
   */
  gate: boolean;
}

export type PressResult = "started" | "repeat" | "empty" | "not-ready" | "out-of-range";

export interface InstrumentDeps {
  engine: InstrumentEngine;
  /** the kit as it is right now; read on every press so a switch takes effect at once */
  kit: () => PadKit;
  /** which library file a pad plays, after the kit's order is applied; null when the pad is empty */
  fileForPad: (pad: number) => string | null;
  /** the audio clock, for the held time a release reports */
  now: () => number;
  onHit?: (hit: InstrumentHit) => void;
  onRelease?: (release: InstrumentRelease) => void;
  velocity?: number;
}

export class PadInstrument {
  private readonly held = new HeldPads();
  private startedAt = new Map<number, { at: number; voiceId: number }>();

  constructor(private readonly deps: InstrumentDeps) {}

  /** What a pad plays under the current kit: in note mode every key plays one slice. */
  fileFor(pad: number): string | null {
    const kit = this.deps.kit();
    if (kit.play !== "note") return this.deps.fileForPad(pad);
    return this.deps.fileForPad(kit.notePad ?? kit.rootPad);
  }

  /** Semitones from the root for a pad; always 0 in chop mode. */
  semitonesFor(pad: number): number {
    const kit = this.deps.kit();
    return kit.play === "note" ? semitonesForPad(pad, kit.rootPad) : 0;
  }

  press(pad: number, options: { repeat?: boolean } = {}): PressResult {
    const kit = this.deps.kit();
    const count = kit.order.length;
    if (!Number.isInteger(pad) || pad < 1 || (count > 0 && pad > count)) return "out-of-range";
    if (this.held.press(pad, options.repeat ?? false) === "repeat") return "repeat";
    const fileId = this.fileFor(pad);
    if (!fileId) {
      // The key is down even though nothing sounded, so its key-up is not a
      // stray and the polyphony readout stays honest.
      return "empty";
    }
    const semitones = this.semitonesFor(pad);
    const velocity = this.deps.velocity ?? 1;
    const voice = this.deps.engine.noteOn(pad, fileId, { velocity, trigger: kit.trigger, semitones });
    if (!voice) return "not-ready";
    this.startedAt.set(pad, { at: voice.at, voiceId: voice.voiceId });
    this.deps.onHit?.({ pad, fileId, at: voice.at, voiceId: voice.voiceId, semitones, durationS: voice.durationS, velocity });
    return "started";
  }

  /** The key came up. Returns true when the pad really was down. */
  release(pad: number): boolean {
    if (!this.held.release(pad)) return false;
    const kit = this.deps.kit();
    const started = this.startedAt.get(pad);
    this.startedAt.delete(pad);
    this.deps.engine.noteOff(pad, { trigger: kit.trigger });
    if (started) {
      const at = this.deps.now();
      this.deps.onRelease?.({ pad, voiceId: started.voiceId, at, heldS: Math.max(0, at - started.at), gate: kit.trigger === "gate" });
    }
    return true;
  }

  pressKey(key: string, options: { repeat?: boolean } = {}): PressResult {
    const pad = this.padForKey(key);
    return pad === null ? "out-of-range" : this.press(pad, options);
  }

  releaseKey(key: string): boolean {
    const pad = this.padForKey(key);
    return pad === null ? false : this.release(pad);
  }

  padForKey(key: string): number | null {
    return padForKeyIn(layoutOr(this.deps.kit().layoutId), key);
  }

  /**
   * Everything down, released: blur, a hidden tab, a stop, a layout change.
   * The engine is told even when we think nothing is held, because a voice
   * can outlive its key (a one-shot).
   */
  releaseAll(options: { engineToo?: boolean } = {}): number {
    const pads = this.held.releaseAll();
    const kit = this.deps.kit();
    const at = this.deps.now();
    for (const pad of pads) {
      const started = this.startedAt.get(pad);
      this.startedAt.delete(pad);
      this.deps.engine.noteOff(pad, { trigger: kit.trigger });
      if (started) this.deps.onRelease?.({ pad, voiceId: started.voiceId, at, heldS: Math.max(0, at - started.at), gate: kit.trigger === "gate" });
    }
    if (options.engineToo) this.deps.engine.releaseAll();
    return pads.length;
  }

  heldPads(): number[] {
    return this.held.held();
  }

  get heldCount(): number {
    return this.held.size;
  }

  /** True when as many keys are down as a laptop keyboard will report at once. */
  atPolyphonyCeiling(): boolean {
    return this.held.size >= MAX_SIMULTANEOUS_KEYS;
  }

  /** The most keys held at once since the last reset, so the readout can say it happened. */
  get peakHeld(): number {
    return this.held.peakHeld;
  }

  resetPeak(): void {
    this.held.resetPeak();
  }
}
