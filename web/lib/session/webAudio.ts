// The browser half of the transport, and the only file here that touches Web
// Audio. Deliberately thin: it owns nodes, not decisions. Every question of
// what sounds and when is answered in schedule.ts before anything gets here.
//
// The graph is three deep and no deeper:
//
//     AudioBufferSourceNode -> piece gain -> track gain -> master -> output
//
// The piece gain carries the region's trim and a 2 ms fade at each end. The
// fade is not taste, it is the click: a region cut at a loop locator or at a
// seek almost never lands on a zero crossing, and 2 ms is short enough to be
// inaudible on a transient and long enough to remove the edge. The loop
// preview renderer (lib/audio/renderLoop.ts) crossfades properly when it is
// making a file; this is playback, where the material has to stay where the
// producer put it.

import { getAudioContext } from "@/lib/audio/decode";
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
}

export class WebAudioBackend implements TransportBackend {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly trackNodes = new Map<string, GainNode>();
  private readonly live = new Set<Live>();

  constructor(
    private readonly cache: DecodeCache<AudioBuffer>,
    ctx?: AudioContext,
  ) {
    this.ctx = ctx ?? getAudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(this.ctx.destination);
  }

  now(): number {
    return this.ctx.currentTime;
  }

  resume(): void | Promise<void> {
    if (this.ctx.state === "suspended") return this.ctx.resume();
  }

  ensureTrack(trackId: string): GainNode {
    const existing = this.trackNodes.get(trackId);
    if (existing) return existing;
    const gain = this.ctx.createGain();
    gain.gain.value = 1;
    gain.connect(this.master);
    this.trackNodes.set(trackId, gain);
    return gain;
  }

  removeTrack(trackId: string): void {
    const node = this.trackNodes.get(trackId);
    if (!node) return;
    this.trackNodes.delete(trackId);
    try {
      node.disconnect();
    } catch {
      // already gone
    }
  }

  setTrackGain(trackId: string, gain: number): void {
    const node = this.ensureTrack(trackId);
    ramp(node.gain, gain, this.ctx.currentTime);
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
    const rate = play.rate > 0 ? play.rate : 1;
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
    source.connect(gain).connect(this.ensureTrack(play.trackId));

    const entry: Live = { source, gain, trackId: play.trackId };
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

  /** Release the graph. The AudioContext is shared with the loop preview, so it is not closed here. */
  dispose(): void {
    this.stopAll();
    for (const trackId of [...this.trackNodes.keys()]) this.removeTrack(trackId);
    try {
      this.master.disconnect();
    } catch {
      // already gone
    }
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
