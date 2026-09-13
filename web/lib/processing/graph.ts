// The node layer, and the only file in this folder that touches Web Audio.
//
// It owns nodes and makes no decisions: every value it sets comes off a
// TrackPlan or a MasterPlan that plan.ts worked out, and everything it does
// with those values is a ramp. That is the same split the transport uses
// (lib/session/webAudio.ts is "thin: it owns nodes, not decisions"), and it is
// the only way any of this is checkable without a browser.
//
// Per track:
//
//     pieces -> input ----------------> dry ------\
//                 \                                +--> output -> the lane's fader
//                  -> trim -> 7 biquads -> wet ---/
//
// Three things that shape are for:
//
//   Bypass is real. The dry path never goes through a filter, so A/B is the
//   processed signal against the actual signal, not against a chain set flat.
//   The swap is an 8 ms crossfade: instant to a producer, and short enough
//   that the two correlated paths cannot audibly comb on the way past.
//
//   Nothing is ever re-wired. The strip is built once and then only ramped,
//   so turning a band on mid-bar cannot click and cannot drop a buffer.
//
//   A disabled band is exactly unity. plan.ts types it peaking/0 dB (b == a),
//   and the pass filters ramp their corner out to a neutral end before taking
//   that type, so nothing is lost off the top or the bottom of a chain whose
//   filters are switched off.

import { NEUTRAL_HIGHPASS_HZ, type BandPlan, type MasterPlan, type TrackPlan } from "./plan";
import type { BandId } from "./types";

/** How long a parameter takes to reach a new value. Short enough to feel instant, long enough not to click. */
export const PARAM_RAMP_S = 0.015;
/** The A/B crossfade. */
export const BYPASS_RAMP_S = 0.008;

export class TrackProcessingStrip {
  /** where the scheduled pieces connect */
  readonly input: GainNode;
  /** what connects to the lane's fader */
  readonly output: GainNode;

  private readonly ctx: BaseAudioContext;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly trim: GainNode;
  private readonly filters = new Map<BandId, BiquadFilterNode>();
  private readonly neutralTimers = new Map<BandId, ReturnType<typeof setTimeout>>();
  private plan: TrackPlan | null = null;

  constructor(ctx: BaseAudioContext, bands: readonly BandPlan[]) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.trim = ctx.createGain();
    this.input.gain.value = 1;
    this.output.gain.value = 1;
    this.trim.gain.value = 1;
    // Dry open, wet shut: an untouched lane is the signal itself.
    this.dry.gain.value = 1;
    this.wet.gain.value = 0;

    this.input.connect(this.dry).connect(this.output);
    let tail: AudioNode = this.input.connect(this.trim);
    for (const band of bands) {
      const filter = ctx.createBiquadFilter();
      // Built neutral: peaking at 0 dB is a mathematical pass-through.
      filter.type = "peaking";
      filter.frequency.value = band.neutralFrequency;
      filter.Q.value = band.q;
      filter.gain.value = 0;
      this.filters.set(band.id, filter);
      tail = tail.connect(filter);
    }
    tail.connect(this.wet).connect(this.output);
  }

  /** The playback rate multiplier the lane's pieces should carry (the tune). */
  get rate(): number {
    return this.plan?.rate ?? 1;
  }

  apply(plan: TrackPlan): void {
    const now = this.ctx.currentTime;
    rampLinear(this.trim.gain, plan.trimGain, now, PARAM_RAMP_S);
    rampLinear(this.dry.gain, plan.dryGain, now, BYPASS_RAMP_S);
    rampLinear(this.wet.gain, plan.wetGain, now, BYPASS_RAMP_S);

    for (const band of plan.bands) {
      const filter = this.filters.get(band.id);
      if (!filter) continue;
      const timer = this.neutralTimers.get(band.id);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.neutralTimers.delete(band.id);
      }

      if (band.enabled) {
        if (filter.type !== band.kind) {
          // Coming out of neutral: take the shape at the harmless end of the
          // sweep, then ramp the corner in, or an 80 Hz high-pass appears in
          // one block and that is a click.
          filter.type = band.kind;
          setNow(filter.frequency, band.neutralFrequency, now);
        }
        rampExponential(filter.frequency, band.frequency, now, PARAM_RAMP_S);
        rampLinear(filter.Q, band.q, now, PARAM_RAMP_S);
        rampLinear(filter.gain, band.gainDb, now, PARAM_RAMP_S);
        continue;
      }

      rampLinear(filter.gain, 0, now, PARAM_RAMP_S);
      if (band.kind === "highpass" || band.kind === "lowpass") {
        rampExponential(filter.frequency, band.neutralFrequency, now, PARAM_RAMP_S);
        // Once the corner is out of the way, take the exactly-unity shape, so a
        // switched-off high-pass costs the bottom end nothing at all.
        const handle = setTimeout(() => {
          this.neutralTimers.delete(band.id);
          if (this.plan?.bands.find((b) => b.id === band.id)?.enabled) return;
          filter.type = "peaking";
        }, Math.ceil(PARAM_RAMP_S * 1000) + 20);
        this.neutralTimers.set(band.id, handle);
      }
    }

    this.plan = plan;
  }

  dispose(): void {
    for (const timer of this.neutralTimers.values()) clearTimeout(timer);
    this.neutralTimers.clear();
    for (const node of [this.input, this.output, this.dry, this.wet, this.trim, ...this.filters.values()]) {
      try {
        node.disconnect();
      } catch {
        // already gone
      }
    }
    this.filters.clear();
  }
}

/**
 * The master bus. A level (which is the engine's own master gain, upstream of
 * this) and a limiter that can be crossfaded in and out the same way. There is
 * no makeup gain here on purpose: the bus can only ever make the session
 * quieter, which is the difference between a safety net and a mastering chain.
 */
export class MasterProcessingStrip {
  readonly input: GainNode;
  readonly output: GainNode;

  private readonly ctx: BaseAudioContext;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private readonly compressor: DynamicsCompressorNode;

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.input = ctx.createGain();
    this.output = ctx.createGain();
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.compressor = ctx.createDynamicsCompressor();
    this.input.gain.value = 1;
    this.output.gain.value = 1;
    this.dry.gain.value = 1;
    this.wet.gain.value = 0;
    this.input.connect(this.dry).connect(this.output);
    this.input.connect(this.compressor).connect(this.wet).connect(this.output);
  }

  apply(plan: MasterPlan): void {
    const now = this.ctx.currentTime;
    rampLinear(this.dry.gain, plan.dryGain, now, BYPASS_RAMP_S);
    rampLinear(this.wet.gain, plan.wetGain, now, BYPASS_RAMP_S);
    setNow(this.compressor.threshold, plan.compressor.thresholdDb, now);
    setNow(this.compressor.knee, plan.compressor.kneeDb, now);
    setNow(this.compressor.ratio, plan.compressor.ratio, now);
    setNow(this.compressor.attack, plan.compressor.attackS, now);
    setNow(this.compressor.release, plan.compressor.releaseS, now);
  }

  /** How much the limiter is holding back right now, dB. Read on a frame; never stored. */
  reduction(): number {
    return this.compressor.reduction;
  }

  dispose(): void {
    for (const node of [this.input, this.output, this.dry, this.wet, this.compressor]) {
      try {
        node.disconnect();
      } catch {
        // already gone
      }
    }
  }
}

function bounded(param: AudioParam, value: number): number {
  if (!Number.isFinite(value)) return param.value;
  return Math.min(param.maxValue, Math.max(param.minValue, value));
}

/** Gains and Qs: a straight line. Never a step — a stepped parameter is a click. */
function rampLinear(param: AudioParam, value: number, now: number, seconds: number): void {
  const target = bounded(param, value);
  try {
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + seconds);
  } catch {
    param.value = target;
  }
}

/** Frequencies: a ratio, because an octave is an octave wherever it is. */
function rampExponential(param: AudioParam, value: number, now: number, seconds: number): void {
  const target = Math.max(NEUTRAL_HIGHPASS_HZ / 10, bounded(param, value));
  try {
    param.cancelScheduledValues(now);
    param.setValueAtTime(Math.max(NEUTRAL_HIGHPASS_HZ / 10, param.value), now);
    param.exponentialRampToValueAtTime(target, now + seconds);
  } catch {
    param.value = target;
  }
}

/** For the parameters that are settings rather than signal: the compressor's shape, a filter's type change. */
function setNow(param: AudioParam, value: number, now: number): void {
  const target = bounded(param, value);
  try {
    param.cancelScheduledValues(now);
    param.setValueAtTime(target, now);
  } catch {
    param.value = target;
  }
}
