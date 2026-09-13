"use client";

// The browser half of the prototype's audio, and deliberately the whole of it.
//
// `synth.ts` makes the samples in pure arithmetic; this packs them into an
// `AudioBuffer` and hands back the same `DecodedSource` the library loader
// hands back after a fetch and a `decodeAudioData`. From there nothing can
// tell the difference: the decode cache accounts for the bytes, evicts and
// pins the same way, the engine asks `isReady` the same way, and the scheduler
// starts the same `AudioBufferSourceNode`.
//
// Two things are true on purpose:
//
//   The loader is asynchronous. Packing a buffer is real work and a source that
//   resolved synchronously would never exercise the engine's "this lane is
//   still waiting" path, which is one of the things the prototype exists to
//   show.
//
//   Nothing is packed until it is asked for. The rack draws its rows from the
//   stored peaks and decodes only what is played, exactly as it does with real
//   uploads.

import { bufferFromChannels } from "@/lib/audio/decode";
import { decodedBytes, type DecodedSource } from "@/lib/session/decodeCache";
import type { Pcm } from "./synth";

/**
 * The rate the material is synthesised at. It need not match the browser's
 * output rate: an `AudioBuffer` carries its own, and the source node resamples
 * it without changing how long it lasts. Fixing it here keeps the samples (and
 * therefore the stored peaks) identical on every machine and in the tests.
 */
export const DEMO_SAMPLE_RATE = 44100;

export type DemoLoader = (fileId: string) => Promise<DecodedSource<AudioBuffer>>;

/** A source loader over already-synthesised PCM, for `SessionProvider`'s `loadSource`. */
export function demoSourceLoader(pcm: ReadonlyMap<string, Pcm>): DemoLoader {
  return async (fileId) => {
    const source = pcm.get(fileId);
    if (!source) throw new Error(`There is no demo audio for ${fileId}.`);
    await Promise.resolve();
    const buffer = bufferFromChannels(source.channels, source.sampleRate);
    return {
      buffer,
      bytes: decodedBytes(buffer.numberOfChannels, buffer.length),
      durationS: buffer.duration,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
    };
  };
}
