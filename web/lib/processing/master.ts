// The master bus: a level, and a limiter that is allowed to be gentle and
// nothing more.
//
// PRODUCT_DIRECTION draws the line here in one sentence: "An EQ that rescues a
// muddy horn so it can sit under a loop answers the first question. A
// mastering chain for release does not." A ceiling that stops four lanes
// stacked on top of each other from clipping the output is the first thing. A
// ratio of infinity, a makeup gain and a loudness readout would be the second,
// so there is no makeup gain in this file and there is no makeup gain on the
// bus — the limiter can only ever make the session quieter.
//
// The arithmetic that turns one ceiling and one release into the five
// parameters a DynamicsCompressorNode wants is here, pure, so the settings can
// be asserted without an AudioContext.

import { clamp, MAX_CEILING_DB, MAX_RELEASE_MS, MIN_CEILING_DB, MIN_RELEASE_MS, type LimiterSettings } from "./types";

/** Exactly the five numbers DynamicsCompressorNode takes, and nothing else. */
export interface CompressorSettings {
  thresholdDb: number;
  kneeDb: number;
  ratio: number;
  attackS: number;
  releaseS: number;
}

/**
 * Gentle, on purpose:
 *
 *   ratio 8, not 20. A brick wall is a mastering decision; this is a safety
 *   net that a producer should be able to leave on without it becoming the
 *   sound of the session.
 *
 *   a 4 dB knee, so it leans in rather than switching on. Audible limiting is
 *   worse than a stray peak when the question being answered is "does this
 *   fit".
 *
 *   3 ms of attack. Fast enough to catch a stacked transient, slow enough to
 *   let the transient through, which is the whole difference between a limiter
 *   that protects a mix and one that flattens it.
 */
export function limiterSettings(limiter: LimiterSettings): CompressorSettings {
  const thresholdDb = clamp(limiter.ceilingDb, MIN_CEILING_DB, MAX_CEILING_DB);
  const releaseMs = clamp(limiter.releaseMs, MIN_RELEASE_MS, MAX_RELEASE_MS);
  return { thresholdDb, kneeDb: 4, ratio: 8, attackS: 0.003, releaseS: releaseMs / 1000 };
}

/** What a node should be set to when the limiter is off but stays wired in: transparent. */
export const OPEN_COMPRESSOR: CompressorSettings = { thresholdDb: 0, kneeDb: 0, ratio: 1, attackS: 0.003, releaseS: 0.25 };

/** The line under the master control. Never claims a loudness it has not measured. */
export function describeLimiter(limiter: LimiterSettings): string {
  if (!limiter.enabled) return "off";
  const { thresholdDb, ratio, releaseS } = limiterSettings(limiter);
  return `holding peaks at ${thresholdDb} dB, ${ratio}:1, ${Math.round(releaseS * 1000)} ms release`;
}
