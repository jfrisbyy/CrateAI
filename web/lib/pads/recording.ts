// The pure part of record mode: which hits count, where they land on the
// grid, and how long the recording is. The browser recorder (recorder.ts)
// feeds this with audio-clock times; tests feed it numbers.

import type { PadHitInput } from "@/lib/api/midi";
import { barSeconds, barsCovering, placeHit, stepSeconds, stepsPerBar, type HitPlacement } from "./grid";

/**
 * A hit as played. `length_s` is how long the key was held, which only gate
 * mode has an opinion about; a one-shot hit leaves it out and the slice's own
 * length is the answer. It rides alongside the MIDI payload rather than in it:
 * `/api/midi/pads` takes `PadHitInput` and is not this seam's to change.
 */
export interface TakeHit extends PadHitInput {
  /** seconds the key was held (gate mode); absent for a one-shot */
  length_s?: number;
  /** note mode: semitones from the root the slice was transposed by */
  semitones?: number;
}

export interface RecordedHit extends TakeHit {
  placement: HitPlacement;
  /** true when the hit came a hair before the record start or after a fixed length's end and was folded into the loop */
  wrapped: boolean;
}

/** A finished take: the bars it covers and every hit placed on the grid. */
export interface Take {
  bars: number;
  hits: RecordedHit[];
}

export interface RecordingSettings {
  bpm: number;
  beatsPerBar: number;
  /** null: record until stop */
  bars: number | null;
}

/**
 * Accept a hit at `timeS` (seconds from the record start)? Hits are taken
 * from half a 16th before the first step (an early "one"), and, for a fixed
 * length, until the end.
 */
export function acceptsHit(timeS: number, settings: RecordingSettings): boolean {
  const halfStep = stepSeconds(settings.bpm) / 2;
  if (timeS < -halfStep) return false;
  if (settings.bars === null) return true;
  return timeS < barSeconds(settings.bpm, settings.beatsPerBar) * settings.bars;
}

/** Bars of a finished take: the chosen length, or the whole bars the hits (or the elapsed time) cover. */
export function takeBars(hits: readonly TakeHit[], settings: RecordingSettings, elapsedS: number): number {
  if (settings.bars !== null) return settings.bars;
  const last = hits.reduce((m, h) => Math.max(m, h.time_s), 0);
  return barsCovering(Math.max(last + stepSeconds(settings.bpm), elapsedS), settings.bpm, settings.beatsPerBar);
}

/**
 * Place every hit on the grid of a `bars`-long take. A hit that rounds to
 * the step just past the end (an early downbeat of the next repeat) is folded
 * onto bar 0 step 0 with its early offset, so a looped pattern keeps its feel.
 */
export function placeTake(hits: readonly TakeHit[], settings: RecordingSettings, bars: number): RecordedHit[] {
  const totalSteps = bars * stepsPerBar(settings.beatsPerBar);
  const length = barSeconds(settings.bpm, settings.beatsPerBar) * bars;
  return [...hits]
    .sort((a, b) => a.time_s - b.time_s)
    .map((h) => {
      let placement = placeHit(h.time_s, settings.bpm, settings.beatsPerBar);
      let time = h.time_s;
      let wrapped = false;
      if (placement.global_step >= totalSteps) {
        time = h.time_s - length;
        placement = placeHit(time, settings.bpm, settings.beatsPerBar);
        wrapped = true;
      } else if (h.time_s < 0) {
        wrapped = true;
      }
      return { ...h, time_s: time, placement, wrapped };
    });
}

export function finalizeTake(hits: readonly TakeHit[], settings: RecordingSettings, elapsedS: number): Take {
  const bars = takeBars(hits, settings, elapsedS);
  return { bars, hits: placeTake(hits, settings, bars) };
}
