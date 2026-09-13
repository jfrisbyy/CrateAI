// MediaRecorder around the microphone, with an AnalyserNode for the level
// meter and the hit counter. Records audio/webm (opus) where the engine
// offers it, its own container elsewhere (Safari: audio/mp4); the upload
// helper converts to WAV in the browser. Browser-only; the pure parts
// (onset counting, WAV) live next door and are tested.

import { rmsOf } from "./onsets";

export const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") return null;
  return MIME_CANDIDATES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

export function canRecord(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";
}

export interface RecordingResult {
  blob: Blob;
  mimeType: string;
  durationMs: number;
}

export interface RecordingSession {
  analyser: AnalyserNode;
  startedAt: number;
  stop: () => Promise<RecordingResult>;
  cancel: () => void;
}

export function describeMicError(err: unknown): string {
  const name = err instanceof DOMException ? err.name : err instanceof Error ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access was denied. Allow it in the browser's site settings and try again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone was found. Plug one in or pick an input in the browser and try again.";
  if (name === "NotReadableError") return "The microphone is busy in another app.";
  return err instanceof Error ? err.message : String(err);
}

export async function startRecording(): Promise<RecordingSession> {
  if (!canRecord()) throw new Error("This browser cannot record audio; use a current Chrome, Firefox, Edge or Safari.");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const context = new Ctor();
  const source = context.createMediaStreamSource(stream);
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0;
  source.connect(analyser);
  void context.resume();

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.start(250);
  const startedAt = performance.now();

  let finished = false;
  const cleanup = () => {
    if (finished) return;
    finished = true;
    for (const track of stream.getTracks()) track.stop();
    try {
      source.disconnect();
    } catch {
      // already gone
    }
    void context.close();
  };

  return {
    analyser,
    startedAt,
    stop: () =>
      new Promise<RecordingResult>((resolve, reject) => {
        recorder.onstop = () => {
          cleanup();
          const type = recorder.mimeType || mimeType || "audio/webm";
          resolve({ blob: new Blob(chunks, { type }), mimeType: type, durationMs: performance.now() - startedAt });
        };
        recorder.onerror = () => {
          cleanup();
          reject(new Error("Recording failed."));
        };
        if (recorder.state === "inactive") {
          cleanup();
          resolve({ blob: new Blob(chunks, { type: mimeType ?? "audio/webm" }), mimeType: mimeType ?? "audio/webm", durationMs: performance.now() - startedAt });
          return;
        }
        recorder.stop();
      }),
    cancel: () => {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        // nothing to stop
      }
      cleanup();
    },
  };
}

/** RMS level of the analyser's current time-domain buffer, in [0, 1]. */
export function levelOf(analyser: AnalyserNode, scratch: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(scratch);
  return rmsOf(scratch);
}
