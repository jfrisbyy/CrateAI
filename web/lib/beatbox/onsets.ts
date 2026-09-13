// A small onset counter for the enrollment recorder: the user sees the hit
// count climb 1…20 while recording. It works on the level the AnalyserNode
// reports each animation frame (RMS of the time-domain buffer), so it is
// deliberately simple: a hit is a fast rise (>= riseDb within lookbackMs)
// above a floor, at most one per minGapMs, and the counter re-arms only
// after the level has fallen releaseDb below the hit's peak. The compute
// segments the uploaded recording itself (beatbox/features.py); this count
// is feedback, not the dataset.

export interface OnsetOptions {
  /** minimum time between two counted hits (matches the compute's 60 ms gap) */
  minGapMs?: number;
  /** rise over the level `lookbackMs` ago that counts as an attack */
  riseDb?: number;
  /** how far back the rise is measured */
  lookbackMs?: number;
  /** below this level nothing counts (breath, room) */
  minLevelDb?: number;
  /** the level must fall this far under the peak before the next hit can count */
  releaseDb?: number;
}

const DEFAULTS: Required<OnsetOptions> = {
  minGapMs: 60,
  riseDb: 8,
  lookbackMs: 50,
  minLevelDb: -45,
  releaseDb: 10,
};

export function dbOf(rms: number): number {
  return 20 * Math.log10(Math.max(rms, 1e-6));
}

/** RMS of a time-domain buffer in [-1, 1]. */
export function rmsOf(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

export class OnsetCounter {
  readonly options: Required<OnsetOptions>;
  private history: Array<{ t: number; db: number }> = [];
  private lastOnsetMs = Number.NEGATIVE_INFINITY;
  private armed = true;
  private peakDb = Number.NEGATIVE_INFINITY;
  private _count = 0;

  constructor(options: OnsetOptions = {}) {
    this.options = { ...DEFAULTS, ...options };
  }

  get count(): number {
    return this._count;
  }

  reset(): void {
    this.history = [];
    this.lastOnsetMs = Number.NEGATIVE_INFINITY;
    this.armed = true;
    this.peakDb = Number.NEGATIVE_INFINITY;
    this._count = 0;
  }

  /** Feed one frame (level in dBFS at time `tMs`). Returns true when this frame counts as a hit. */
  feedDb(db: number, tMs: number): boolean {
    const o = this.options;
    const ref = this.levelAt(tMs - o.lookbackMs);
    if (!this.armed) {
      this.peakDb = Math.max(this.peakDb, db);
      if (db <= this.peakDb - o.releaseDb) this.armed = true;
    }
    let hit = false;
    if (this.armed && db >= o.minLevelDb && ref !== null && db - ref >= o.riseDb && tMs - this.lastOnsetMs >= o.minGapMs) {
      hit = true;
      this._count += 1;
      this.lastOnsetMs = tMs;
      this.armed = false;
      this.peakDb = db;
    }
    this.history.push({ t: tMs, db });
    const keepFrom = tMs - o.lookbackMs * 4;
    while (this.history.length > 2 && this.history[0]!.t < keepFrom) this.history.shift();
    return hit;
  }

  /** Feed one frame as RMS in [0, 1]. */
  feed(rms: number, tMs: number): boolean {
    return this.feedDb(dbOf(rms), tMs);
  }

  /** The recorded level at or just before `t`; null before the first frame. */
  private levelAt(t: number): number | null {
    let best: number | null = null;
    for (const h of this.history) {
      if (h.t <= t) best = h.db;
      else break;
    }
    if (best === null && this.history.length) return this.history[0]!.db;
    return best;
  }
}
