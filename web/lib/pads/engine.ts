// Web Audio playback for the pads: every bound file is fetched and decoded
// once into an AudioBuffer; a tap starts a fresh source with a 3 ms fade in
// and out. Polyphonic, nothing chokes. Trigger times come from the audio
// clock so the recorder and the click agree.

import { getAudioContext } from "@/lib/audio/decode";

export const PAD_FADE_S = 0.003;

export type BufferStatus = "loading" | "ready" | "error";

export class PadEngine {
  private buffers = new Map<string, AudioBuffer>();
  private pending = new Map<string, Promise<AudioBuffer>>();
  private errors = new Map<string, string>();
  private voices = new Map<number, Set<AudioBufferSourceNode>>();
  private listeners = new Set<() => void>();

  get context(): AudioContext {
    return getAudioContext();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  status(fileId: string): BufferStatus | null {
    if (this.buffers.has(fileId)) return "ready";
    if (this.pending.has(fileId)) return "loading";
    if (this.errors.has(fileId)) return "error";
    return null;
  }

  errorFor(fileId: string): string | null {
    return this.errors.get(fileId) ?? null;
  }

  /** Fetch (via `getUrl`, a signed URL) and decode once; concurrent calls share the promise. */
  load(fileId: string, getUrl: () => Promise<string>): Promise<AudioBuffer> {
    const ready = this.buffers.get(fileId);
    if (ready) return Promise.resolve(ready);
    const inFlight = this.pending.get(fileId);
    if (inFlight) return inFlight;
    const promise = (async () => {
      const url = await getUrl();
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Could not fetch the audio (${res.status}).`);
      const bytes = await res.arrayBuffer();
      const buffer = await this.context.decodeAudioData(bytes);
      this.buffers.set(fileId, buffer);
      return buffer;
    })();
    this.pending.set(fileId, promise);
    this.errors.delete(fileId);
    this.emit();
    promise
      .then(() => {
        this.pending.delete(fileId);
        this.emit();
      })
      .catch((err: unknown) => {
        this.pending.delete(fileId);
        this.errors.set(fileId, err instanceof Error ? err.message : String(err));
        this.emit();
      });
    return promise;
  }

  /** Play `fileId` on `pad` now. Returns the audio-clock time of the trigger, or null when the buffer is not ready. */
  trigger(pad: number, fileId: string, velocity = 1): number | null {
    const buffer = this.buffers.get(fileId);
    if (!buffer) return null;
    const ctx = this.context;
    if (ctx.state === "suspended") void ctx.resume();
    const now = ctx.currentTime;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    const level = Math.max(0, Math.min(1, velocity));
    const end = now + buffer.duration;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(level, now + PAD_FADE_S);
    if (buffer.duration > PAD_FADE_S * 2) {
      gain.gain.setValueAtTime(level, end - PAD_FADE_S);
      gain.gain.linearRampToValueAtTime(0, end);
    }
    source.connect(gain).connect(ctx.destination);
    let set = this.voices.get(pad);
    if (!set) {
      set = new Set();
      this.voices.set(pad, set);
    }
    set.add(source);
    source.onended = () => {
      set.delete(source);
      source.disconnect();
      gain.disconnect();
      this.emit();
    };
    source.start(now);
    this.emit();
    return now;
  }

  isLit(pad: number): boolean {
    return (this.voices.get(pad)?.size ?? 0) > 0;
  }

  litPads(): number[] {
    return [...this.voices.entries()].filter(([, set]) => set.size > 0).map(([pad]) => pad);
  }

  stopAll(): void {
    for (const set of this.voices.values()) {
      for (const source of set) {
        try {
          source.stop();
        } catch {
          // already stopped
        }
      }
    }
  }

  /**
   * Stop everything and drop the decoded audio. The engine stays usable: in
   * development React mounts, unmounts and remounts effects, so a disposed
   * engine may be asked to load again.
   */
  dispose(): void {
    this.stopAll();
    this.buffers.clear();
    this.errors.clear();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}
