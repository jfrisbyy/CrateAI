// Web Audio loop playback for the Loops tab. `raw` loops the region straight
// out of the decoded buffer; `rendered` loops a buffer produced by
// renderLoopPreview (crossfaded, zero-crossing snapped). Position is derived
// from the audio clock so the playhead overlay stays honest.

import { bufferFromChannels, getAudioContext } from "./decode";

export type LoopMode = "raw" | "rendered";

interface Active {
  source: AudioBufferSourceNode;
  gain: GainNode;
  startedAt: number;
  regionStart: number;
  regionLength: number;
}

const FADE_S = 0.006;

export class LoopPlayer {
  private active: Active | null = null;
  private listeners = new Set<() => void>();

  get isPlaying(): boolean {
    return this.active !== null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Loop [startS, endS) of `buffer` (raw). */
  playRaw(buffer: AudioBuffer, startS: number, endS: number): void {
    const ctx = getAudioContext();
    const start = Math.max(0, Math.min(startS, buffer.duration));
    const end = Math.max(start + 0.01, Math.min(endS, buffer.duration));
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = start;
    source.loopEnd = end;
    this.start(source, start, end - start, start);
  }

  /** Loop a rendered preview whole; `regionStart` positions the playhead on the source waveform. */
  playRendered(channels: Float32Array[], sampleRate: number, regionStart: number): void {
    const ctx = getAudioContext();
    const buffer = bufferFromChannels(channels, sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    this.start(source, regionStart, buffer.duration, 0);
  }

  private start(source: AudioBufferSourceNode, regionStart: number, regionLength: number, offset: number): void {
    const ctx = getAudioContext();
    this.stop();
    void ctx.resume();
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + FADE_S);
    source.connect(gain).connect(ctx.destination);
    source.start(now, offset);
    this.active = { source, gain, startedAt: now, regionStart, regionLength };
    this.emit();
  }

  stop(): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    try {
      a.gain.gain.cancelScheduledValues(now);
      a.gain.gain.setValueAtTime(a.gain.gain.value, now);
      a.gain.gain.linearRampToValueAtTime(0, now + FADE_S);
      a.source.stop(now + FADE_S + 0.002);
    } catch {
      // already stopped
    }
    this.emit();
  }

  /** Playhead position in source-file seconds, or null when idle. */
  position(): number | null {
    const a = this.active;
    if (!a || a.regionLength <= 0) return null;
    const elapsed = getAudioContext().currentTime - a.startedAt;
    return a.regionStart + (((elapsed % a.regionLength) + a.regionLength) % a.regionLength);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
