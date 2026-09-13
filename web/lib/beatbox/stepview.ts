// The step view of a beatbox transcription (bars × 16 steps) built from the
// classified hits the compute stores in `midi.notes.hits`
// (analysis/lockedgroove/beatbox/transcribe.py TranscribedHit: time_s, cls,
// confidence, velocity, bar, step, offset_ms). Building it here, rather than
// reading `notes.step_view`, keeps each cell tied to its `hit_index`, which is
// what a correction refers to: `{ hit_index, corrected_class }` rows the user
// saves into the same JSON, for the next enrollment to learn from.

export interface BeatboxHit {
  time_s: number;
  cls: string;
  confidence: number;
  velocity: number;
  bar: number;
  step: number;
  offset_ms: number;
}

export interface BeatboxCorrection {
  hit_index: number;
  corrected_class: string;
}

export interface StepHit {
  hit_index: number;
  cls: string;
  corrected_class: string | null;
  velocity: number;
  offset_ms: number;
  confidence: number;
  time_s: number;
}

export interface StepCell {
  step: number;
  hits: StepHit[];
}

export interface StepRow {
  bar: number;
  steps: StepCell[];
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** The hits list from a midi row's notes JSON (anything malformed is dropped). */
export function hitsOf(notes: unknown): BeatboxHit[] {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) return [];
  const raw = (notes as Record<string, unknown>).hits;
  if (!Array.isArray(raw)) return [];
  const out: BeatboxHit[] = [];
  for (const h of raw) {
    if (!h || typeof h !== "object") continue;
    const r = h as Record<string, unknown>;
    if (typeof r.cls !== "string") continue;
    out.push({
      time_s: num(r.time_s),
      cls: r.cls,
      confidence: num(r.confidence),
      velocity: num(r.velocity, 1),
      bar: Math.max(0, Math.round(num(r.bar))),
      step: Math.max(0, Math.round(num(r.step))),
      offset_ms: num(r.offset_ms),
    });
  }
  return out;
}

export function correctionsOf(notes: unknown): BeatboxCorrection[] {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) return [];
  const raw = (notes as Record<string, unknown>).corrections;
  if (!Array.isArray(raw)) return [];
  const out: BeatboxCorrection[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    if (typeof r.hit_index !== "number" || typeof r.corrected_class !== "string") continue;
    out.push({ hit_index: r.hit_index, corrected_class: r.corrected_class });
  }
  return out;
}

/** Rows of bars (every bar from 0 to the last hit's bar) with `stepsPerBar` cells each. */
export function stepViewFromHits(hits: BeatboxHit[], corrections: BeatboxCorrection[] = [], stepsPerBar = 16): StepRow[] {
  const corrected = new Map(corrections.map((c) => [c.hit_index, c.corrected_class]));
  const lastBar = hits.length ? Math.max(...hits.map((h) => h.bar)) : -1;
  const rows: StepRow[] = [];
  for (let bar = 0; bar <= lastBar; bar++) {
    rows.push({ bar, steps: Array.from({ length: stepsPerBar }, (_, step) => ({ step, hits: [] })) });
  }
  hits.forEach((h, hit_index) => {
    const row = rows[h.bar];
    const cell = row?.steps[Math.min(h.step, stepsPerBar - 1)];
    if (!cell) return;
    cell.hits.push({
      hit_index,
      cls: h.cls,
      corrected_class: corrected.get(hit_index) ?? null,
      velocity: h.velocity,
      offset_ms: h.offset_ms,
      confidence: h.confidence,
      time_s: h.time_s,
    });
  });
  return rows;
}

export function effectiveClass(hit: StepHit): string {
  return hit.corrected_class ?? hit.cls;
}

/**
 * Set (or clear, when the class equals the prediction) one hit's correction.
 * Returns a new list, one entry per hit at most, in hit order.
 */
export function setCorrection(corrections: BeatboxCorrection[], hitIndex: number, corrected: string, predicted: string): BeatboxCorrection[] {
  const rest = corrections.filter((c) => c.hit_index !== hitIndex);
  if (corrected === predicted) return rest.sort((a, b) => a.hit_index - b.hit_index);
  return [...rest, { hit_index: hitIndex, corrected_class: corrected }].sort((a, b) => a.hit_index - b.hit_index);
}

/** Two-letter cell label: "K", "S", "H", "OH" for open_hat, first two letters otherwise. */
export function classLabel(cls: string): string {
  const known: Record<string, string> = { kick: "K", snare: "S", hat: "H", open_hat: "OH", clap: "C", rim: "R", tom: "T", other: "?" };
  return known[cls] ?? cls.slice(0, 2).toUpperCase();
}
