// Mute, solo and gain: what each lane's gain node should be set to.
//
// The rule a producer expects and every DAW implements: solo is exclusive
// across the session, mute wins over solo on the same lane, and neither
// changes what is scheduled. Muting does not stop a source, it turns its lane
// down — so unmuting four bars later drops back in on the beat instead of
// restarting the region. That is the whole reason mute lives here and not in
// the scheduler.

import type { SessionTrack } from "./types";

/** Anything soloed puts the session in solo mode. */
export function anySoloed(tracks: readonly SessionTrack[]): boolean {
  return tracks.some((t) => t.soloed && !t.muted);
}

/** Should this lane be heard, given the state of the rest of the session? */
export function audible(track: SessionTrack, soloMode: boolean): boolean {
  if (track.muted) return false;
  return soloMode ? track.soloed : true;
}

export const MAX_GAIN = 4;

export function clampGain(gain: number): number {
  if (!Number.isFinite(gain)) return 1;
  return Math.min(MAX_GAIN, Math.max(0, gain));
}

/** The number the lane's gain node carries: its own gain, or zero when it is not heard. */
export function trackGain(track: SessionTrack, soloMode: boolean): number {
  return audible(track, soloMode) ? clampGain(track.gain) : 0;
}

/** Every lane's node value in one pass, so the backend can be re-synced whenever anything changes. */
export function mixOf(tracks: readonly SessionTrack[]): Map<string, number> {
  const soloMode = anySoloed(tracks);
  const out = new Map<string, number>();
  for (const track of tracks) out.set(track.id, trackGain(track, soloMode));
  return out;
}

/** Solo is a toggle on one lane, not a radio button: two lanes can be soloed together. */
export function toggleSolo(tracks: readonly SessionTrack[], trackId: string): SessionTrack[] {
  return tracks.map((t) => (t.id === trackId ? { ...t, soloed: !t.soloed } : t));
}

export function toggleMute(tracks: readonly SessionTrack[], trackId: string): SessionTrack[] {
  return tracks.map((t) => (t.id === trackId ? { ...t, muted: !t.muted } : t));
}

export function clearSolo(tracks: readonly SessionTrack[]): SessionTrack[] {
  return tracks.map((t) => (t.soloed ? { ...t, soloed: false } : t));
}

const MIN_DB = -60;

/** Linear gain from decibels; -60 dB and below is silence. */
export function gainFromDb(db: number): number {
  if (!Number.isFinite(db) || db <= MIN_DB) return 0;
  return clampGain(10 ** (db / 20));
}

/** Decibels from linear gain; silence reads as -60, which is what the fader shows. */
export function dbFromGain(gain: number): number {
  if (!Number.isFinite(gain) || gain <= 0) return MIN_DB;
  return Math.max(MIN_DB, 20 * Math.log10(gain));
}
