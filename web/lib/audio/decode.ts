// Decoded PCM for the loop preview. wavesurfer plays through a media element
// from the stored peaks; the Loops tab needs real samples for raw looping,
// the rendered preview and zero-crossing snapping, so those are decoded
// lazily here and cached per file.

let context: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!context) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error("Web Audio is not available in this browser.");
    context = new Ctor();
  }
  return context;
}

const cache = new Map<string, Promise<AudioBuffer>>();
const MAX_CACHED = 3;

/**
 * Fetch and decode, with no cache of its own. The session transport keeps its
 * own cache with a byte budget and an eviction order
 * (lib/session/decodeCache.ts); it must not be shadowed by the three-item one
 * below, which exists for the single open file on the loops tab.
 */
export async function fetchAndDecode(url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not fetch audio (${res.status}).`);
  const bytes = await res.arrayBuffer();
  return await getAudioContext().decodeAudioData(bytes);
}

export function decodeFromUrl(cacheKey: string, url: string): Promise<AudioBuffer> {
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  const promise = fetchAndDecode(url);
  cache.set(cacheKey, promise);
  promise.catch(() => cache.delete(cacheKey));
  while (cache.size > MAX_CACHED) {
    const first = cache.keys().next().value;
    if (first === undefined) break;
    cache.delete(first);
  }
  return promise;
}

export function channelsOf(buffer: AudioBuffer): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) out.push(buffer.getChannelData(c));
  return out;
}

export function bufferFromChannels(channels: Float32Array[], sampleRate: number): AudioBuffer {
  const ctx = getAudioContext();
  const length = Math.max(1, ...channels.map((c) => c.length));
  const buffer = ctx.createBuffer(Math.max(1, channels.length), length, sampleRate);
  channels.forEach((ch, i) => buffer.copyToChannel(ch as Float32Array<ArrayBuffer>, i));
  return buffer;
}
