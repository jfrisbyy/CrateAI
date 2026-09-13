// What every parameter on the graph should be, given a chain.
//
// This is the layer that makes the node wiring decision-free. graph.ts walks a
// plan and ramps parameters; it never works out what a bypass means, what a
// disabled band should settle to, or what a tune does to a playback rate.
// That is all here, and it is all asserted in node, which is the only way any
// of it gets checked at all without a browser.
//
// Two rules the plan carries that are easy to get wrong in node code:
//
//   A disabled band must be *exactly* unity, not nearly. A peaking filter at
//   0 dB has b == a and is therefore a mathematical pass-through, so a
//   disabled slot is typed peaking/0 dB and costs the signal nothing. A
//   disabled high-pass parked at 10 Hz would still take a fraction of a dB off
//   the bottom, and a disabled low-pass parked at Nyquist takes nearly 2 dB off
//   the top octave — which on material the direction document cares about
//   (8–20 kHz air) is exactly the loss we are trying not to cause.
//
//   A pass filter has to arrive from somewhere. Switching a slot from unity to
//   an 80 Hz high-pass in one block is a step, and a step is a click. The plan
//   says where the frequency should come *from*, and the graph ramps it in.

import { activeBand, bandOf, defaultProcessing } from "./chain";
import { limiterSettings, OPEN_COMPRESSOR, type CompressorSettings } from "./master";
import { rateForCents } from "./tune";
import { BAND_IDS, type BandId, type BandKind, type MasterProcessing, type TrackProcessing } from "./types";

/** Where a pass filter sits when it is not doing anything, so it can ramp in and out. */
export const NEUTRAL_HIGHPASS_HZ = 10;

export interface BandPlan {
  id: BandId;
  /** the biquad type the node should be while the band is doing something */
  kind: BandKind;
  /** the type a neutralised slot settles to: exactly unity */
  neutralKind: "peaking";
  enabled: boolean;
  /** Hz the node should ramp to */
  frequency: number;
  /** Hz a pass filter ramps in from and out to; the same as `frequency` for the others */
  neutralFrequency: number;
  q: number;
  /** dB the node should ramp to; 0 whenever the band is disabled */
  gainDb: number;
}

export interface TrackPlan {
  /** linear, before the filters */
  trimGain: number;
  /** the dry path's gain: 1 when the chain is bypassed */
  dryGain: number;
  /** the processed path's gain: 1 when it is engaged */
  wetGain: number;
  bands: BandPlan[];
  /** what every piece on this lane multiplies its playback rate by */
  rate: number;
}

/** The plan for a lane with no chain at all: dry, unity, nothing in circuit. */
export function neutralPlan(): TrackPlan {
  return { trimGain: 1, dryGain: 1, wetGain: 0, bands: BAND_IDS.map(neutralBand), rate: 1 };
}

function neutralBand(id: BandId): BandPlan {
  const frequency = id === "hp" ? NEUTRAL_HIGHPASS_HZ : 1000;
  return { id, kind: id === "hp" ? "highpass" : id === "lp" ? "lowpass" : "peaking", neutralKind: "peaking", enabled: false, frequency, neutralFrequency: frequency, q: 0.707, gainDb: 0 };
}

export function trackPlan(processing: TrackProcessing, sampleRate: number): TrackPlan {
  const nyquist = Math.max(1000, sampleRate / 2);
  const bands = BAND_IDS.map((id) => {
    const band = bandOf(processing, id);
    const on = activeBand(band);
    const neutralFrequency = id === "hp" ? NEUTRAL_HIGHPASS_HZ : id === "lp" ? nyquist : band.frequency;
    return {
      id,
      kind: band.kind,
      neutralKind: "peaking",
      enabled: on,
      frequency: on ? band.frequency : neutralFrequency,
      neutralFrequency,
      q: band.q,
      gainDb: on ? band.gainDb : 0,
    } satisfies BandPlan;
  });
  // Bypass is a real crossfade between two paths, not a chain set flat: a
  // producer A/Bing has to hear the signal that never went through the filters.
  const bypassed = processing.bypassed;
  return {
    trimGain: bypassed ? 1 : 10 ** (processing.trimDb / 20),
    dryGain: bypassed ? 1 : 0,
    wetGain: bypassed ? 0 : 1,
    bands,
    // The tune still applies when the chain is bypassed. It is not part of the
    // filter path — it is the rate the samples are read at — so bypassing the
    // EQ to compare two curves must not also retune the lane underneath.
    rate: rateForCents(processing.tuneCents),
  };
}

export interface MasterPlan {
  dryGain: number;
  wetGain: number;
  compressor: CompressorSettings;
}

export function masterPlan(master: MasterProcessing): MasterPlan {
  const engaged = !master.bypassed && master.limiter.enabled;
  return {
    dryGain: engaged ? 0 : 1,
    wetGain: engaged ? 1 : 0,
    compressor: engaged ? limiterSettings(master.limiter) : OPEN_COMPRESSOR,
  };
}

/** Did anything about this plan change? Used to leave a graph alone rather than re-ramping it. */
export function samePlan(a: TrackPlan, b: TrackPlan): boolean {
  if (a.trimGain !== b.trimGain || a.dryGain !== b.dryGain || a.wetGain !== b.wetGain || a.rate !== b.rate) return false;
  return a.bands.every((band, i) => {
    const other = b.bands[i];
    if (!other) return false;
    return band.id === other.id && band.kind === other.kind && band.enabled === other.enabled && band.frequency === other.frequency && band.q === other.q && band.gainDb === other.gainDb;
  });
}

/**
 * The bands a strip is built with: the default chain's, at the running sample
 * rate, so the low-pass slot knows where its neutral end is before anything
 * has been asked of it.
 */
export function initialBands(sampleRate: number): BandPlan[] {
  return trackPlan(defaultProcessing(), sampleRate).bands;
}
