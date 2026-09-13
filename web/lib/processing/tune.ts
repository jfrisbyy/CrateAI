// Tuning, and being honest about what it is.
//
// There is no pitch shifter here. A track's tune multiplies the playback rate
// of every piece on that lane, so pitch and time move together exactly the way
// a sampler or a turntable does — and exactly the way a region's own `rate`
// already does when a break is fitted to a session (lib/session/types.ts).
// PRODUCT_DIRECTION is explicit that the phase vocoder is not good enough for
// the ratios this product asks for, so playback does not pretend to hold time
// while it moves pitch. Real pitch-with-time-held is a render on the compute
// side, and the lineage already has a field for it (`cents`).
//
// What this buys, which is the corrective case: a horn that came back a
// quarter-tone flat against the loop can be pulled into tune in one move, and
// the cost is that it eats its source a fraction of a percent faster.

import { clampTuneCents } from "./chain";

/** The rate multiplier for a number of cents. 1200 cents is an octave, which is a doubling. */
export function rateForCents(cents: number): number {
  if (!Number.isFinite(cents)) return 1;
  return 2 ** (clampTuneCents(cents) / 1200);
}

/** The cents a rate multiplier amounts to; what the region inspector shows for a resampled region. */
export function centsForRate(rate: number): number {
  if (!(rate > 0) || !Number.isFinite(rate)) return 0;
  return 1200 * Math.log2(rate);
}

/** A region's own rate and the lane's tune, combined. This is what reaches playbackRate. */
export function effectiveRate(regionRate: number, tuneCents: number): number {
  const base = Number.isFinite(regionRate) && regionRate > 0 ? regionRate : 1;
  return base * rateForCents(tuneCents);
}

/** Semitones as a producer would say them, from cents. */
export function describeTune(cents: number): string {
  const value = Math.round(clampTuneCents(cents));
  if (value === 0) return "in tune";
  const sign = value > 0 ? "+" : "";
  const semitones = value / 100;
  const whole = Math.abs(semitones) >= 1 && Number.isInteger(semitones);
  return whole ? `${sign}${semitones} ${Math.abs(semitones) === 1 ? "semitone" : "semitones"}` : `${sign}${value} cents`;
}

/**
 * How much longer or shorter a stretch of source becomes at this tune, as a
 * percentage. Said out loud wherever the tune is shown, because a producer
 * needs to know that tuning here moves time as well.
 */
export function timeCostPercent(cents: number): number {
  return (1 / rateForCents(cents) - 1) * 100;
}
