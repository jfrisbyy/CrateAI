// Suggest patterns — the fourth of the four places the AI helps, and the one
// closest to the principle-1 line.
//
// It stays on the right side of that line by construction. A variation is not
// a list of notes: it is a list of *operations over the producer's own take* —
// swap two bars, repeat a bar, drop one pad from one bar, push a pad a 16th,
// thin a roll. The hits always come from the take that was played and the
// slices are always the producer's own, because the vocabulary contains no way
// to say "a hit here". A rhythm described in words cannot be expressed at all.
//
// That holds for a model too (`PatternAdvisor` below): the model chooses and
// parameterises operations, never notes, and `isRearrangementOf` checks the
// result anyway before a producer ever hears it. The check is the test that
// matters in patterns.test.ts.

import { barSeconds, stepSeconds, stepsPerBar } from "./grid";
import { placeTake, type RecordedHit, type RecordingSettings, type Take } from "./recording";

export type PatternOperation =
  | { op: "swap-bars"; a: number; b: number }
  | { op: "repeat-bar"; from: number; to: number }
  | { op: "drop-pad-in-bar"; pad: number; bar: number }
  | { op: "shift-pad"; pad: number; steps: number }
  | { op: "thin-pad"; pad: number; keep: number }
  | { op: "reverse-bars" };

export type PatternOperationName = PatternOperation["op"];

export const PATTERN_OPERATIONS: ReadonlyArray<{ op: PatternOperationName; describe: string }> = [
  { op: "swap-bars", describe: "Play two of your bars in the other order." },
  { op: "repeat-bar", describe: "Play one of your bars again in place of another." },
  { op: "drop-pad-in-bar", describe: "Take one pad out of one bar." },
  { op: "shift-pad", describe: "Push every hit of one pad a number of 16ths." },
  { op: "thin-pad", describe: "Keep every nth hit of one pad and drop the rest." },
  { op: "reverse-bars", describe: "Play your bars back to front." },
];

export interface PatternVariation {
  id: string;
  /** what it is, in the producer's words */
  name: string;
  /** why it might be worth hearing */
  why: string;
  bars: number;
  hits: RecordedHit[];
  /** every operation, named, so a producer can see it is their own take */
  derivation: string[];
  operations: PatternOperation[];
  source: "rules" | "model";
}

export interface RearrangementCheck {
  ok: boolean;
  reason: string;
}

/**
 * The guard. A variation may only contain pads the take contains, playing the
 * slices the take played, inside the take's own bars. Anything else is
 * something the producer did not play, and it does not get shown.
 */
export function isRearrangementOf(take: Take, hits: readonly RecordedHit[], settings: RecordingSettings): RearrangementCheck {
  const pads = new Set(take.hits.map((h) => h.pad));
  const files = new Map<number, string | null>();
  for (const h of take.hits) if (!files.has(h.pad)) files.set(h.pad, h.chop_file_id);
  const length = barSeconds(settings.bpm, settings.beatsPerBar) * take.bars;
  const half = stepSeconds(settings.bpm) / 2;
  for (const h of hits) {
    if (!pads.has(h.pad)) return { ok: false, reason: `Pad ${h.pad + 1} is not in the take that was played.` };
    const file = files.get(h.pad) ?? null;
    if (h.chop_file_id !== file) return { ok: false, reason: `Pad ${h.pad + 1} would play a slice the take did not.` };
    if (h.time_s < -half || h.time_s >= length + half) return { ok: false, reason: `A hit at ${h.time_s.toFixed(3)} s falls outside the ${take.bars}-bar take.` };
  }
  if (hits.length > take.hits.length * 2) return { ok: false, reason: `${hits.length} hits from a take of ${take.hits.length}: that is not a rearrangement.` };
  return { ok: true, reason: `${hits.length} hits, all of them yours.` };
}

/** Run a list of operations over a take. Anything that does not apply is reported, not silently dropped. */
export function applyOperations(
  take: Take,
  settings: RecordingSettings,
  operations: readonly PatternOperation[],
): { hits: RecordedHit[]; applied: string[]; rejected: string[] } {
  const bar = barSeconds(settings.bpm, settings.beatsPerBar);
  const step = stepSeconds(settings.bpm);
  const applied: string[] = [];
  const rejected: string[] = [];
  let hits: RecordedHit[] = [...take.hits];
  const pads = new Set(take.hits.map((h) => h.pad));

  for (const operation of operations) {
    switch (operation.op) {
      case "swap-bars": {
        if (!inBars(operation.a, take.bars) || !inBars(operation.b, take.bars) || operation.a === operation.b) {
          rejected.push(`swap bars ${operation.a + 1} and ${operation.b + 1}: the take has ${take.bars}.`);
          break;
        }
        hits = hits.map((h) => {
          const b = Math.floor(h.time_s / bar);
          if (b === operation.a) return { ...h, time_s: h.time_s + (operation.b - operation.a) * bar };
          if (b === operation.b) return { ...h, time_s: h.time_s + (operation.a - operation.b) * bar };
          return h;
        });
        applied.push(`Bars ${operation.a + 1} and ${operation.b + 1} swapped.`);
        break;
      }
      case "repeat-bar": {
        if (!inBars(operation.from, take.bars) || !inBars(operation.to, take.bars) || operation.from === operation.to) {
          rejected.push(`repeat bar ${operation.from + 1} over bar ${operation.to + 1}: the take has ${take.bars}.`);
          break;
        }
        const kept = hits.filter((h) => Math.floor(h.time_s / bar) !== operation.to);
        const copied = hits
          .filter((h) => Math.floor(h.time_s / bar) === operation.from)
          .map((h) => ({ ...h, time_s: h.time_s + (operation.to - operation.from) * bar }));
        hits = [...kept, ...copied];
        applied.push(`Bar ${operation.from + 1} played again in place of bar ${operation.to + 1}.`);
        break;
      }
      case "drop-pad-in-bar": {
        if (!pads.has(operation.pad) || !inBars(operation.bar, take.bars)) {
          rejected.push(`drop pad ${operation.pad + 1} from bar ${operation.bar + 1}: it is not in the take.`);
          break;
        }
        const before = hits.length;
        hits = hits.filter((h) => !(h.pad === operation.pad && Math.floor(h.time_s / bar) === operation.bar));
        applied.push(`Pad ${operation.pad + 1} taken out of bar ${operation.bar + 1} (${before - hits.length} hits).`);
        break;
      }
      case "shift-pad": {
        if (!pads.has(operation.pad) || !Number.isInteger(operation.steps) || operation.steps === 0) {
          rejected.push(`shift pad ${operation.pad + 1}: nothing to shift.`);
          break;
        }
        const length = bar * take.bars;
        hits = hits.map((h) => (h.pad === operation.pad ? { ...h, time_s: wrap(h.time_s + operation.steps * step, length) } : h));
        applied.push(`Pad ${operation.pad + 1} pushed ${Math.abs(operation.steps)} ${Math.abs(operation.steps) === 1 ? "16th" : "16ths"} ${operation.steps > 0 ? "later" : "earlier"}.`);
        break;
      }
      case "thin-pad": {
        const keep = Math.max(2, Math.round(operation.keep));
        if (!pads.has(operation.pad)) {
          rejected.push(`thin pad ${operation.pad + 1}: it is not in the take.`);
          break;
        }
        let n = 0;
        hits = hits.filter((h) => {
          if (h.pad !== operation.pad) return true;
          return n++ % keep === 0;
        });
        applied.push(`Pad ${operation.pad + 1} thinned to every ${keep === 2 ? "other" : `${keep}th`} hit.`);
        break;
      }
      case "reverse-bars": {
        if (take.bars < 2) {
          rejected.push("reverse the bars: the take is one bar.");
          break;
        }
        hits = hits.map((h) => {
          const b = Math.floor(h.time_s / bar);
          const within = h.time_s - b * bar;
          return { ...h, time_s: (take.bars - 1 - b) * bar + within };
        });
        applied.push(`The ${take.bars} bars played back to front.`);
        break;
      }
    }
  }
  return { hits: placeTake(hits, settings, take.bars), applied, rejected };
}

export interface SuggestOptions {
  /** how many to offer */
  max?: number;
}

/**
 * Variations from the take itself, with no model anywhere: the operations that
 * make musical sense for what was actually played. A take with one bar gets
 * different suggestions from a take with four, and a take with one pad gets
 * fewer than a take with five, because there is honestly less to rearrange.
 */
export function suggestPatterns(take: Take, settings: RecordingSettings, options: SuggestOptions = {}): PatternVariation[] {
  const max = Math.max(1, options.max ?? 4);
  if (take.hits.length === 0) return [];
  const bar = barSeconds(settings.bpm, settings.beatsPerBar);
  const counts = new Map<number, number>();
  for (const h of take.hits) counts.set(h.pad, (counts.get(h.pad) ?? 0) + 1);
  const byBusiest = [...counts.entries()].sort((a, b) => (b[1] === a[1] ? a[0] - b[0] : b[1] - a[1]));
  const busiest = byBusiest[0]?.[0];
  const sparsest = byBusiest[byBusiest.length - 1]?.[0];
  const candidates: Array<{ name: string; why: string; operations: PatternOperation[] }> = [];

  if (take.bars >= 2) {
    candidates.push({
      name: `Bars ${take.bars - 1} and ${take.bars} swapped`,
      why: "Your last two bars in the other order: the turnaround arrives a bar early.",
      operations: [{ op: "swap-bars", a: take.bars - 2, b: take.bars - 1 }],
    });
    candidates.push({
      name: "Bar 1 repeated",
      why: "Your first bar in place of your second, so the loop states itself twice before it moves.",
      operations: [{ op: "repeat-bar", from: 0, to: 1 }],
    });
  }
  if (busiest !== undefined && take.bars >= 2) {
    candidates.push({
      name: `Pad ${busiest + 1} out of the last bar`,
      why: "The busiest pad drops out for a bar, which is the oldest way to make a loop breathe.",
      operations: [{ op: "drop-pad-in-bar", pad: busiest, bar: take.bars - 1 }],
    });
  }
  if (busiest !== undefined && (counts.get(busiest) ?? 0) >= 4) {
    candidates.push({
      name: `Pad ${busiest + 1} thinned by half`,
      why: "Every other hit of your busiest pad: the same part, half as dense.",
      operations: [{ op: "thin-pad", pad: busiest, keep: 2 }],
    });
  }
  if (sparsest !== undefined && sparsest !== busiest) {
    candidates.push({
      name: `Pad ${sparsest + 1} pushed a 16th`,
      why: "Your sparsest pad a 16th later, which is a different feel and not a different rhythm.",
      operations: [{ op: "shift-pad", pad: sparsest, steps: 1 }],
    });
  }
  if (take.bars >= 2) {
    candidates.push({ name: "Bars reversed", why: "Your bars back to front.", operations: [{ op: "reverse-bars" }] });
  }

  const out: PatternVariation[] = [];
  for (const candidate of candidates) {
    if (out.length >= max) break;
    const built = build(take, settings, candidate, "rules", `rules-${out.length + 1}`);
    if (built && changed(take, built, bar)) out.push(built);
  }
  return out;
}

// --- the model seam ----------------------------------------------------------

/**
 * What a model is given. Symbolic only: no audio, no file names, no text the
 * producer typed that could become a rhythm. `operations` is the whole
 * vocabulary it may answer in, which is what keeps this inside principle 1.
 */
export interface PatternRequest {
  bpm: number;
  beats_per_bar: number;
  bars: number;
  pads: Array<{ pad: number; label: string; hit_class: string | null; hits: number }>;
  hits: Array<{ pad: number; bar: number; step: number; offset_ms: number; velocity: number }>;
  /** what the producer asked for, if they asked in words. Never a rhythm, only a direction. */
  instruction: string | null;
  operations: readonly PatternOperationName[];
  max_variations: number;
}

export interface PatternResponse {
  variations: Array<{ name: string; why: string; operations: PatternOperation[] }>;
}

export interface PatternAdvisor {
  propose(request: PatternRequest): Promise<PatternResponse>;
}

/** Build the request. Pure, so a test can assert exactly what would be sent. */
export function patternRequest(
  take: Take,
  settings: RecordingSettings,
  context: { labels?: ReadonlyMap<number, string>; classes?: ReadonlyMap<number, string | null>; instruction?: string | null; max?: number } = {},
): PatternRequest {
  const perBar = stepsPerBar(settings.beatsPerBar);
  const counts = new Map<number, number>();
  for (const h of take.hits) counts.set(h.pad, (counts.get(h.pad) ?? 0) + 1);
  return {
    bpm: settings.bpm,
    beats_per_bar: settings.beatsPerBar,
    bars: take.bars,
    pads: [...counts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([pad, hits]) => ({ pad, label: context.labels?.get(pad) ?? `pad ${pad + 1}`, hit_class: context.classes?.get(pad) ?? null, hits })),
    hits: take.hits.map((h) => ({
      pad: h.pad,
      bar: h.placement.bar,
      step: h.placement.global_step % perBar,
      offset_ms: h.placement.offset_ms,
      velocity: h.velocity,
    })),
    instruction: context.instruction ?? null,
    operations: PATTERN_OPERATIONS.map((o) => o.op),
    max_variations: Math.max(1, context.max ?? 4),
  };
}

/**
 * Take what the advisor answered and make variations from it — locally, by
 * running the operations over the producer's own take. A variation whose hits
 * are not a rearrangement is dropped with its reason; nothing a model says is
 * trusted far enough to be heard unchecked.
 */
export async function patternsFromAdvisor(
  advisor: PatternAdvisor,
  take: Take,
  settings: RecordingSettings,
  context: Parameters<typeof patternRequest>[2] = {},
): Promise<{ variations: PatternVariation[]; refused: string[] }> {
  const response = await advisor.propose(patternRequest(take, settings, context));
  const variations: PatternVariation[] = [];
  const refused: string[] = [];
  response.variations.forEach((v, i) => {
    const operations = (v.operations ?? []).filter(isKnownOperation);
    if (operations.length === 0) {
      refused.push(`"${v.name}" asked for something that is not a rearrangement of your take.`);
      return;
    }
    const built = build(take, settings, { ...v, operations }, "model", `model-${i + 1}`);
    if (!built) {
      refused.push(`"${v.name}" did not come out as your own hits.`);
      return;
    }
    variations.push(built);
  });
  return { variations, refused };
}

export function isKnownOperation(operation: unknown): operation is PatternOperation {
  if (!operation || typeof operation !== "object") return false;
  const op = (operation as { op?: unknown }).op;
  return typeof op === "string" && PATTERN_OPERATIONS.some((known) => known.op === op);
}

function build(
  take: Take,
  settings: RecordingSettings,
  candidate: { name: string; why: string; operations: PatternOperation[] },
  source: "rules" | "model",
  id: string,
): PatternVariation | null {
  const { hits, applied, rejected } = applyOperations(take, settings, candidate.operations);
  if (applied.length === 0) return null;
  const check = isRearrangementOf(take, hits, settings);
  if (!check.ok) return null;
  return {
    id,
    name: candidate.name,
    why: candidate.why,
    bars: take.bars,
    hits,
    derivation: [...applied, ...rejected.map((r) => `Not applied: ${r}`)],
    operations: candidate.operations,
    source,
  };
}

function changed(take: Take, variation: PatternVariation, bar: number): boolean {
  if (variation.hits.length !== take.hits.length) return true;
  const key = (h: RecordedHit) => `${h.pad}:${Math.round(h.time_s / (bar / 1000))}`;
  const before = new Set(take.hits.map(key));
  return variation.hits.some((h) => !before.has(key(h)));
}

function inBars(bar: number, bars: number): boolean {
  return Number.isInteger(bar) && bar >= 0 && bar < bars;
}

function wrap(t: number, length: number): number {
  if (length <= 0) return t;
  let x = t;
  while (x >= length) x -= length;
  while (x < 0) x += length;
  return Math.round(x * 1e6) / 1e6;
}
