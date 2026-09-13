// Decoded audio, with a budget and an eviction order.
//
// Decoded PCM is the most expensive thing in the browser here: four minutes of
// 44.1 kHz stereo is 81 MB of Float32, and a session with a dozen tracks
// and a rack of candidates behind it will ask for more than a tab can hold. So
// the cache is bounded from the start rather than retrofitted.
//
//  - Least recently used goes first, and "used" means asked for by the
//    scheduler or the UI, not decoded.
//  - A pinned source is never evicted. The session pins every source a track
//    region points at; the rack pins only the candidate currently auditioning.
//    That is the difference between "this is in the song" and "I am listening
//    to this", and it is why the rack can hold a hundred candidates.
//  - Two callers asking at once share one decode. A failure is remembered so a
//    dead URL is not fetched on every tick, and `forget` clears it for a retry.
//  - Nothing is decoded because it appeared. Decoding is always someone asking.
//
// Generic in the buffer type so the whole thing is exercised in node against a
// stub; the browser passes AudioBuffer.

export interface DecodedSource<B> {
  buffer: B;
  /** memory this occupies, bytes; channels * frames * 4 for Float32 */
  bytes: number;
  durationS: number;
  sampleRate: number;
  channels: number;
}

export interface DecodeCacheOptions<B> {
  /** the budget, in bytes of decoded PCM */
  maxBytes: number;
  /** fetch and decode one source; rejections are cached until `forget` */
  load: (sourceId: string) => Promise<DecodedSource<B>>;
  /** a decode landed: the engine re-plans so a late track joins in progress */
  onReady?: (sourceId: string) => void;
  onEvict?: (sourceId: string) => void;
}

interface Entry<B> {
  source: DecodedSource<B>;
  /** monotonic counter, not a clock: only the order matters */
  usedAt: number;
}

export class DecodeCache<B> {
  private entries = new Map<string, Entry<B>>();
  private inflight = new Map<string, Promise<DecodedSource<B>>>();
  private failures = new Map<string, string>();
  private pinned = new Set<string>();
  private clock = 0;
  private total = 0;

  constructor(private readonly options: DecodeCacheOptions<B>) {}

  /** Bytes of decoded audio held right now. */
  get bytes(): number {
    return this.total;
  }

  get maxBytes(): number {
    return this.options.maxBytes;
  }

  get size(): number {
    return this.entries.size;
  }

  /** True when pins alone exceed the budget; the UI can say the session is too big to hold. */
  get overBudget(): boolean {
    return this.total > this.options.maxBytes;
  }

  has(sourceId: string): boolean {
    return this.entries.has(sourceId);
  }

  /** The decoded audio if it is in memory, marking it as used. */
  get(sourceId: string): DecodedSource<B> | undefined {
    const entry = this.entries.get(sourceId);
    if (!entry) return undefined;
    entry.usedAt = ++this.clock;
    return entry.source;
  }

  /** The decoded audio without touching the eviction order (for a readout, not for playback). */
  peek(sourceId: string): DecodedSource<B> | undefined {
    return this.entries.get(sourceId)?.source;
  }

  /** Why the last decode of this source failed, if it did. */
  failure(sourceId: string): string | undefined {
    return this.failures.get(sourceId);
  }

  isPending(sourceId: string): boolean {
    return this.inflight.has(sourceId);
  }

  pending(): string[] {
    return [...this.inflight.keys()];
  }

  isPinned(sourceId: string): boolean {
    return this.pinned.has(sourceId);
  }

  /** Hold this source against eviction (it is in the session, or auditioning). */
  pin(sourceId: string): void {
    this.pinned.add(sourceId);
  }

  unpin(sourceId: string): void {
    this.pinned.delete(sourceId);
    this.evict();
  }

  /** Replace the pin set in one step: exactly these sources are held. */
  setPins(sourceIds: Iterable<string>): void {
    this.pinned = new Set(sourceIds);
    this.evict();
  }

  /**
   * The decoded audio, decoding it if needed. Concurrent callers share one
   * decode. A source that failed before rejects immediately with the same
   * message rather than hammering a dead URL every tick.
   */
  request(sourceId: string): Promise<DecodedSource<B>> {
    const hit = this.get(sourceId);
    if (hit) return Promise.resolve(hit);
    const inflight = this.inflight.get(sourceId);
    if (inflight) return inflight;
    const failure = this.failures.get(sourceId);
    if (failure !== undefined) return Promise.reject(new Error(failure));

    const promise = this.options
      .load(sourceId)
      .then((source) => {
        this.inflight.delete(sourceId);
        this.put(sourceId, source);
        this.options.onReady?.(sourceId);
        return source;
      })
      .catch((err: unknown) => {
        this.inflight.delete(sourceId);
        const message = err instanceof Error ? err.message : String(err);
        this.failures.set(sourceId, message);
        throw err instanceof Error ? err : new Error(message);
      });
    this.inflight.set(sourceId, promise);
    return promise;
  }

  /** Put decoded audio in directly (a render the session produced, not a fetch). */
  put(sourceId: string, source: DecodedSource<B>): void {
    const existing = this.entries.get(sourceId);
    if (existing) this.total -= existing.source.bytes;
    this.entries.set(sourceId, { source, usedAt: ++this.clock });
    this.total += source.bytes;
    this.failures.delete(sourceId);
    this.evict();
  }

  /** Drop one source, its failure with it, so the next request decodes again. */
  forget(sourceId: string): void {
    const entry = this.entries.get(sourceId);
    if (entry) {
      this.total -= entry.source.bytes;
      this.entries.delete(sourceId);
    }
    this.failures.delete(sourceId);
  }

  clear(): void {
    this.entries.clear();
    this.failures.clear();
    this.total = 0;
  }

  /** The sources held, least recently used first: the order they would be evicted in. */
  order(): string[] {
    return [...this.entries.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt).map(([id]) => id);
  }

  private evict(): void {
    if (this.total <= this.options.maxBytes) return;
    for (const sourceId of this.order()) {
      if (this.total <= this.options.maxBytes) return;
      if (this.pinned.has(sourceId)) continue;
      const entry = this.entries.get(sourceId);
      if (!entry) continue;
      this.total -= entry.source.bytes;
      this.entries.delete(sourceId);
      this.options.onEvict?.(sourceId);
    }
  }
}

/** Bytes an AudioBuffer-shaped thing occupies once decoded. */
export function decodedBytes(channels: number, frames: number): number {
  return Math.max(0, channels) * Math.max(0, frames) * 4;
}

/** A budget that leaves room for the page: 384 MB, about nineteen minutes of stereo at 44.1 kHz. */
export const DEFAULT_BUDGET_BYTES = 384 * 1024 * 1024;
