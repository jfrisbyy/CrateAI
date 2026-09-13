// The only file in lib/pads that touches Web Audio.
//
// One AudioBufferSourceNode and one gain node per voice; the gain carries the
// fade in, the fade at the slice's natural end, and the 2 ms release a key-up
// asks for. Decoded buffers are kept per file id and shared by every voice.

import { getAudioContext } from "@/lib/audio/decode";
import type { PadBackend, PadVoiceSpec } from "./backend";

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** audio-clock time the voice is expected to end, before any release */
  endsAt: number;
}

export class WebAudioPadBackend implements PadBackend {
  private buffers = new Map<string, AudioBuffer>();
  private voices = new Map<number, Voice>();
  private ended = new Set<(voiceId: number) => void>();

  get context(): AudioContext {
    return getAudioContext();
  }

  now(): number {
    return this.context.currentTime;
  }

  resume(): void {
    const ctx = this.context;
    if (ctx.state === "suspended") void ctx.resume();
  }

  isReady(fileId: string): boolean {
    return this.buffers.has(fileId);
  }

  durationOf(fileId: string): number | null {
    return this.buffers.get(fileId)?.duration ?? null;
  }

  async load(fileId: string, getUrl: () => Promise<string>): Promise<number> {
    const url = await getUrl();
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not fetch the audio (${res.status}).`);
    const bytes = await res.arrayBuffer();
    const buffer = await this.context.decodeAudioData(bytes);
    this.buffers.set(fileId, buffer);
    return buffer.duration;
  }

  start(spec: PadVoiceSpec): boolean {
    const buffer = this.buffers.get(spec.fileId);
    if (!buffer) return false;
    const ctx = this.context;
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = spec.rate;
    const gain = ctx.createGain();
    const sounding = buffer.duration / spec.rate;
    const end = now + sounding;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(spec.gain, now + spec.attackS);
    if (sounding > spec.attackS + spec.releaseS) {
      gain.gain.setValueAtTime(spec.gain, end - spec.releaseS);
      gain.gain.linearRampToValueAtTime(0, end);
    }
    source.connect(gain).connect(ctx.destination);
    const voice: Voice = { source, gain, endsAt: end };
    this.voices.set(spec.voiceId, voice);
    source.onended = () => {
      this.voices.delete(spec.voiceId);
      source.disconnect();
      gain.disconnect();
      for (const fn of this.ended) fn(spec.voiceId);
    };
    source.start(now);
    return true;
  }

  release(voiceId: number, fadeS: number): void {
    const voice = this.voices.get(voiceId);
    if (!voice) return;
    const ctx = this.context;
    const now = ctx.currentTime;
    const stopAt = Math.min(voice.endsAt, now + fadeS);
    try {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + fadeS);
    } catch {
      // a param that will not take a ramp: fall through to the stop
    }
    try {
      voice.source.stop(Math.max(now, stopAt));
    } catch {
      // already stopped; onended has run or is about to
    }
  }

  stop(voiceId: number): void {
    const voice = this.voices.get(voiceId);
    if (!voice) return;
    try {
      voice.source.stop();
    } catch {
      // already stopped
    }
  }

  stopAll(): void {
    for (const id of [...this.voices.keys()]) this.stop(id);
  }

  onEnded(handler: (voiceId: number) => void): () => void {
    this.ended.add(handler);
    return () => {
      this.ended.delete(handler);
    };
  }

  /**
   * `outputLatency` is the real number when the browser gives it (Firefox and
   * Chrome do); `baseLatency` is the buffer the graph adds and is always
   * there. Together they are the output half of key-to-sound.
   */
  outputLatencyS(): number {
    const ctx = this.context as AudioContext & { outputLatency?: number };
    const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
    const output = typeof ctx.outputLatency === "number" && Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
    return output > 0 ? output : base;
  }

  forget(fileId: string): void {
    this.buffers.delete(fileId);
  }

  dispose(): void {
    this.stopAll();
    this.voices.clear();
    this.buffers.clear();
    this.ended.clear();
  }
}
