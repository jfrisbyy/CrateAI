// Key to audible sound, measured rather than assumed.
//
// The target from the direction document is about 20 ms: past that a producer
// stops feeling played and starts feeling triggered. The number has three
// parts and only two of them are ours:
//
//   input     the keydown's own timestamp to the moment our handler ran.
//             The OS scan, the browser's event loop, anything blocking the
//             main thread. This is the part a slow render ruins.
//   schedule  what the engine adds before the voice starts. Zero by design:
//             a pad starts at `currentTime`, never on a lookahead.
//   output    what the audio graph and the device add after the start —
//             `AudioContext.outputLatency`, or `baseLatency` when the browser
//             will not say. On a laptop this is usually the biggest part and
//             the one no code can shorten.
//
// `KeyboardEvent.timeStamp` shares an epoch with `performance.now()` in every
// current browser, but a stale or coarsened stamp would make the input part a
// lie, so an implausible reading is reported as unknown instead of as zero.

export const LATENCY_TARGET_MS = 20;
/** Past this the reading is not a key press we handled late, it is a bad clock. */
const MAX_PLAUSIBLE_INPUT_MS = 500;

export interface LatencyInput {
  /** `KeyboardEvent.timeStamp`, ms */
  eventTimeStampMs: number;
  /** `performance.now()` inside the handler, ms */
  handledAtMs: number;
  /** what the engine scheduled ahead of the clock, seconds (0 for a pad) */
  scheduleAheadS?: number;
  /** `PadBackend.outputLatencyS()`, seconds */
  outputLatencyS: number;
}

export interface LatencySample {
  /** null when the event's timestamp was not usable */
  inputMs: number | null;
  scheduleMs: number;
  outputMs: number;
  /** the parts we could measure, added up */
  totalMs: number;
  /** true when the input part is missing, so the total is a floor, not a total */
  partial: boolean;
}

export function latencySample(input: LatencyInput): LatencySample {
  const raw = input.handledAtMs - input.eventTimeStampMs;
  const usable = Number.isFinite(raw) && raw >= 0 && raw <= MAX_PLAUSIBLE_INPUT_MS;
  const inputMs = usable ? round3(raw) : null;
  const scheduleMs = round3(Math.max(0, input.scheduleAheadS ?? 0) * 1000);
  const outputMs = round3(Math.max(0, input.outputLatencyS) * 1000);
  return { inputMs, scheduleMs, outputMs, totalMs: round3((inputMs ?? 0) + scheduleMs + outputMs), partial: inputMs === null };
}

/** A rolling window of samples; p95 is what a producer feels, not the mean. */
export class LatencyStats {
  private totals: number[] = [];
  private inputs: number[] = [];
  private capacity: number;

  constructor(capacity = 200) {
    this.capacity = Math.max(1, capacity);
  }

  add(sample: LatencySample): void {
    this.totals.push(sample.totalMs);
    if (sample.inputMs !== null) this.inputs.push(sample.inputMs);
    if (this.totals.length > this.capacity) this.totals.shift();
    if (this.inputs.length > this.capacity) this.inputs.shift();
  }

  get count(): number {
    return this.totals.length;
  }

  reset(): void {
    this.totals = [];
    this.inputs = [];
  }

  /** The percentile of the total, 0..1; null with nothing measured yet. */
  percentile(p: number): number | null {
    return percentileOf(this.totals, p);
  }

  inputPercentile(p: number): number | null {
    return percentileOf(this.inputs, p);
  }

  worst(): number | null {
    return this.totals.length === 0 ? null : round3(Math.max(...this.totals));
  }

  summary(): LatencySummary {
    return { count: this.count, medianMs: this.percentile(0.5), p95Ms: this.percentile(0.95), worstMs: this.worst() };
  }
}

export interface LatencySummary {
  count: number;
  medianMs: number | null;
  p95Ms: number | null;
  worstMs: number | null;
}

/** One line, in measured numbers, never a claim we cannot back. */
export function describeLatency(summary: LatencySummary): string {
  if (summary.count === 0) return "No key-to-sound measurement yet; play a pad.";
  const median = summary.medianMs ?? 0;
  const p95 = summary.p95Ms ?? median;
  const verdict = p95 <= LATENCY_TARGET_MS ? "inside the 20 ms that feels played" : "past the 20 ms that feels played";
  return `${fmt(median)} ms typical, ${fmt(p95)} ms at the 95th over ${summary.count} ${summary.count === 1 ? "hit" : "hits"} — ${verdict}.`;
}

function fmt(ms: number): string {
  return ms >= 10 ? ms.toFixed(0) : ms.toFixed(1);
}

function percentileOf(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return round3(sorted[i] as number);
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
