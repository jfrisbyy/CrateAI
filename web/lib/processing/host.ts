// How the processing controls reach the audio graph without going through the
// engine.
//
// The transport's engine schedules regions; it has no opinion about filters,
// and a per-track EQ changes nothing about when a piece starts. Threading
// processing through `SessionEngine` would have meant changing a file this
// seam was told to leave alone, for no benefit: the only thing that needs to
// know about a chain is the backend that owns the nodes.
//
// So the backend registers itself here when it is built (it is built lazily,
// on the first sound), and the processing provider pushes its state at
// whichever host is current. `onProcessingHost` exists for exactly that race:
// a producer can set up a curve before any audio has ever played, and the
// state has to arrive at the graph the moment the graph exists.

import type { MasterProcessing, TrackProcessing } from "./types";

export interface ProcessingHost {
  /** the running context's rate; the curve is drawn at the rate that is sounding */
  sampleRate(): number;
  /** null takes the chain off the lane entirely */
  setTrackProcessing(trackId: string, processing: TrackProcessing | null): void;
  setMasterProcessing(master: MasterProcessing): void;
  /** how much the master limiter is holding back right now, dB; 0 when there is none */
  limiterReduction(): number;
}

let current: ProcessingHost | null = null;
const listeners = new Set<(host: ProcessingHost | null) => void>();

export function registerProcessingHost(host: ProcessingHost): void {
  current = host;
  for (const listener of [...listeners]) listener(host);
}

export function releaseProcessingHost(host: ProcessingHost): void {
  if (current !== host) return;
  current = null;
  for (const listener of [...listeners]) listener(null);
}

export function processingHost(): ProcessingHost | null {
  return current;
}

/** Called with the host now, and again whenever it changes. Returns the unsubscribe. */
export function onProcessingHost(listener: (host: ProcessingHost | null) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
