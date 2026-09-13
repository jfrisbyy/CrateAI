// The browser half of the transport, and the only file here that touches Web
// Audio. Deliberately thin: it owns nodes, not decisions. Every question of
// what sounds and when is answered in schedule.ts before anything gets here,
// and every question of what a chain's parameters should be is answered in
// lib/processing/plan.ts before anything gets here.
//
// The graph, with the per-track corrective chain in it:
//
//     AudioBufferSourceNode -> piece gain -> [track chain] -> lane fader
//                                                                  |
//                              master gain -> [master chain] -> output
//
// The track chain is lib/processing/graph.ts, and it is a dry path and a
// processed path crossfaded against each other, so bypass is the real signal
// rather than a chain set flat. It sits between the piece gain and the lane's
// fader, which is where docs/HANDOFF_session_transport.md said it would go:
// post-trim so a region's own level is inside the processing, pre-fader so
// mute, solo and the balance are still the last word.
//
// The piece gain carries the region's trim and a 2 ms fade at each end. The
// fade is not taste, it is the click: a region cut at a loop locator or at a
// seek almost never lands on a zero crossing, and 2 ms is short enough to be
// inaudible on a transient and long enough to remove the edge. The loop
// preview renderer (lib/audio/renderLoop.ts) crossfades properly when it is
// making a file; this is playback, where the material has to stay where the
// producer put it.

import { getAudioContext } from "@/lib/audio/decode";
import { MasterProcessingStrip, TrackProcessingStrip } from "@/lib/processing/graph";
import { registerProcessingHost, releaseProcessingHost, type ProcessingHost } from "@/lib/processing/host";
import { initialBands, masterPlan, neutralPlan, trackPlan } from "@/lib/processing/plan";
import type { MasterProcessing, TrackProcessing } from "@/lib/processing/types";
import type { DecodeCache } from "./decodeCache";
import type { ScheduledPlay, SourceId, TransportBackend } from "./types";

/** Fade in and out of every scheduled piece, seconds. */
export const DECLICK_S = 0.002;
/** Gain ramps (a fader move, a mute) take this long, to keep them from clicking too. */
export const RAMP_S = 0.012;

interface Live {
  source: AudioBufferSourceNode;
  gain: GainNode;
  trackId: string;
  /** the region's own rate, before the lane's tune; kept so a retune can be a ramp */
  baseRate: number;
}

/** One lane: its corrective chain, then its fader. */
interface Lane {
  strip: TrackProcessingStrip;
  fader: GainNode;
}

export class WebAudioBackend implements TransportBackend, ProcessingHost {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly masterStrip: MasterProcessingStrip;
  private readonly lanes = new Map<string, Lane>();
  private readonly live = new Set<Live>();

  constructor(
    private readonly cache: DecodeCache<AudioBuffer>,
    ctx?: AudioContext,
  ) {
    this.ctx = ctx ?? getAudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.masterStrip = new MasterProcessingStrip(this.ctx);
    this.master.connect(this.masterStrip.input);
    this.masterStrip.output.connect(this.ctx.destination);
    // The controls reach the graph through here rather than through the
    // engine: a filter changes nothing about when a piece starts, so the
    // scheduler has no reason to know about one (lib/processing/host.ts).
    registerProcessingHost(this);
  }

  now(): number {
    return this.ctx.currentTime;
  }

  resume(): void | Promise<void> {
    if (this.ctx.state === "suspended") return this.ctx.resume();
  }

  ensureTrack(trackId: string): void {
    this.lane(trackId);
  }

  removeTrack(trackId: string): void {
    const lane = this.lanes.get(trackId);
    if (!lane) return;
    this.lanes.delete(trackId);
    lane.strip.dispose();
    try {
      lane.fader.disconnect();
    } catch {
      // already gone
    }
  }

  setTrackGain(trackId: string, gain: number): void {
    ramp(this.lane(trackId).fader.gain, gain, this.ctx.currentTime);
  }

  setMasterGain(gain: number): void {
    ramp(this.master.gain, gain, this.ctx.currentTime);
  }

  isReady(sourceId: SourceId): boolean {
    return this.cache.has(sourceId);
  }

  /**
   * One piece, one source node. A piece whose start has already gone past
   * (a tick that arrived late, a decode that landed mid-region) is trimmed to
   * the clock instead of being dropped: the lane joins in progress at the
   * right sample rather than waiting for the next pass.
   */
  start(play: ScheduledPlay): boolean {
    const decoded = this.cache.get(play.sourceId);
    if (!decoded) return false;
    const buffer = decoded.buffer;
    const lane = this.lane(play.trackId);
    const baseRate = play.rate > 0 ? play.rate : 1;
    // The lane's tune is a rate, not a filter: it resamples, so pitch and time
    // move together the way a sampler does (lib/processing/tune.ts).
    const rate = baseRate * lane.strip.rate;
    const now = this.ctx.currentTime;
    let when = play.whenWall;
    let offset = play.offsetS;
    let duration = play.durationS;
    if (when < now) {
      const late = now - when;
      if (late >= duration) return true; // wholly in the past; count it as done
      when = now;
      offset += late * rate;
      duration -= late;
    }
    if (offset >= buffer.duration) return true; // past the end of the audio; nothing to play
    // `duration` is session seconds; a resampled region eats the buffer faster.
    duration = Math.min(duration, (buffer.duration - offset) / rate);
    if (duration <= 0) return true;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    if (rate !== 1) source.playbackRate.value = rate;
    const gain = this.ctx.createGain();
    const level = Math.max(0, play.gain);
    const fade = Math.min(DECLICK_S, duration / 2);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, when + fade);
    gain.gain.setValueAtTime(level, when + duration - fade);
    gain.gain.linearRampToValueAtTime(0, when + duration);
    source.connect(gain).connect(lane.strip.input);

    const entry: Live = { source, gain, trackId: play.trackId, baseRate };
    source.onended = () => {
      this.live.delete(entry);
      try {
        gain.disconnect();
      } catch {
        // already gone
      }
    };
    this.live.add(entry);
    // start(when, offset) and stop(at) are both in context time, which is the
    // one interpretation every engine agrees on; start()'s third argument is
    // not (it is in buffer seconds, and a resampled region would need scaling).
    source.start(when, offset);
    source.stop(when + duration);
    return true;
  }

  stopAll(): void {
    for (const entry of [...this.live]) this.kill(entry);
  }

  stopTrack(trackId: string): void {
    for (const entry of [...this.live]) if (entry.trackId === trackId) this.kill(entry);
  }

  // --- the processing host --------------------------------------------------
  // Parameters only. Nothing here re-schedules anything, and nothing here
  // decides a value: the plan arrives worked out.

  sampleRate(): number {
    return this.ctx.sampleRate;
  }

  setTrackProcessing(trackId: string, processing: TrackProcessing | null): void {
    const lane = this.lane(trackId);
    const plan = processing ? trackPlan(processing, this.ctx.sampleRate) : neutralPlan();
    const previousRate = lane.strip.rate;
    lane.strip.apply(plan);
    // A tune is the one parameter that lives on the source nodes rather than
    // in the chain, so it is ramped onto whatever is already in flight instead
    // of being waited for. Pieces scheduled after this pick it up in `start`.
    if (plan.rate !== previousRate) {
      const now = this.ctx.currentTime;
      for (const entry of this.live) {
        if (entry.trackId !== trackId) continue;
        ramp(entry.source.playbackRate, entry.baseRate * plan.rate, now);
      }
    }
  }

  setMasterProcessing(master: MasterProcessing): void {
    this.masterStrip.apply(masterPlan(master));
  }

  limiterReduction(): number {
    return this.masterStrip.reduction();
  }

  /** Release the graph. The AudioContext is shared with the loop preview, so it is not closed here. */
  dispose(): void {
    releaseProcessingHost(this);
    this.stopAll();
    for (const trackId of [...this.lanes.keys()]) this.removeTrack(trackId);
    this.masterStrip.dispose();
    try {
      this.master.disconnect();
    } catch {
      // already gone
    }
  }

  private lane(trackId: string): Lane {
    const existing = this.lanes.get(trackId);
    if (existing) return existing;
    const fader = this.ctx.createGain();
    fader.gain.value = 1;
    fader.connect(this.master);
    const strip = new TrackProcessingStrip(this.ctx, initialBands(this.ctx.sampleRate));
    strip.output.connect(fader);
    const lane: Lane = { strip, fader };
    this.lanes.set(trackId, lane);
    return lane;
  }

  private kill(entry: Live): void {
    this.live.delete(entry);
    const now = this.ctx.currentTime;
    try {
      entry.gain.gain.cancelScheduledValues(now);
      entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
      entry.gain.gain.linearRampToValueAtTime(0, now + DECLICK_S);
      entry.source.stop(now + DECLICK_S + 0.002);
    } catch {
      // already stopped
    }
  }
}

function ramp(param: AudioParam, value: number, now: number): void {
  const target = Number.isFinite(value) ? Math.max(0, value) : 0;
  try {
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + RAMP_S);
  } catch {
    param.value = target;
  }
}
