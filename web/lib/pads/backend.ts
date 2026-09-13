// The browser half of the pads, behind one interface.
//
// Everything above this line — when a voice starts, how long the fades are,
// what a key release means, which pad is lit — is decided in engine.ts and
// asserted in node against the fake in fakes.ts. Everything below it is node
// plumbing: buffer sources, gain nodes, an AudioContext (webAudioPads.ts).
// The session transport is split the same way and for the same reason: there
// is no browser here, and the timing decisions are the part worth testing.

/** One voice's worth of work: what to play, how loud, how fast, how it fades. */
export interface PadVoiceSpec {
  voiceId: number;
  /** 1-based pad, or 0 for a file played outside the grid */
  pad: number;
  fileId: string;
  /** linear gain from the velocity */
  gain: number;
  /** 1 in chop mode; 2 ** (semitones / 12) in note mode */
  rate: number;
  /** fade in, seconds; a slice cut mid-waveform clicks without it */
  attackS: number;
  /** fade out at the slice's natural end, seconds */
  releaseS: number;
  /** the source's length at rate 1 */
  sourceDurationS: number;
  /** true when a key release is expected to cut this voice (gate mode) */
  gate: boolean;
}

export type PadLoadStatus = "loading" | "ready" | "error";

export interface PadBackend {
  /** the audio clock, the one the recorder and the click share */
  now(): number;
  /** resume a context suspended until a gesture; safe to call repeatedly */
  resume(): void;
  isReady(fileId: string): boolean;
  /** the decoded length in seconds, or null when it is not decoded */
  durationOf(fileId: string): number | null;
  /** fetch through `getUrl` and decode once; resolves with the duration */
  load(fileId: string, getUrl: () => Promise<string>): Promise<number>;
  /** start a voice now; false when it could not sound */
  start(spec: PadVoiceSpec): boolean;
  /** fade to silence over `fadeS` and stop: the key came up */
  release(voiceId: number, fadeS: number): void;
  /** cut a voice with no fade (a stop, a dispose) */
  stop(voiceId: number): void;
  stopAll(): void;
  /** a voice finished, by its own end or by a release */
  onEnded(handler: (voiceId: number) => void): () => void;
  /**
   * What the output adds between `start(now)` and sound reaching the speakers,
   * in seconds. This is the honest half of the key-to-sound number; the other
   * half is how long the keydown took to reach us (latency.ts).
   */
  outputLatencyS(): number;
  /** drop a decoded file (a retry after a failure) */
  forget(fileId: string): void;
  dispose(): void;
}
