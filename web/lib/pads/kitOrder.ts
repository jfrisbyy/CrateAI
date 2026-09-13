// Which key gets what — the second of the four places the AI helps.
//
// A pile of slices in file order is not a kit. Drums sort by hit class so the
// kicks land together under one hand; melodic slices sort by pitch or by
// position depending on what the producer is playing. The classification is
// measured, not guessed: `drums.patterns` already folds every section onto a
// 16th grid with a class, a mean velocity and how often that step is hit, so a
// slice's class is the class whose step it lands on.
//
// The producer drags a pad onto another pad to fix it, and that drag is a
// correction worth logging (principle 7): `orderCorrection` is the payload.

import type { AnalysisReport, DrumHit } from "@/lib/types/report";
import type { PadBindings } from "./bindings";

export type HitClass = "kick" | "snare" | "hat" | "other";
export const HIT_CLASS_ORDER: readonly HitClass[] = ["kick", "snare", "hat", "other"];

export type OrderStrategy = "file" | "hit-class" | "pitch" | "position" | "length";

export const ORDER_STRATEGIES: ReadonlyArray<{ id: OrderStrategy; label: string; describe: string }> = [
  { id: "file", label: "File order", describe: "The order the chopper made them. Where every kit starts." },
  { id: "hit-class", label: "Hit class", describe: "Kicks, then snares, then hats, then the rest — from the measured drum pattern." },
  { id: "pitch", label: "Pitch", describe: "Low to high, from the chord measured under each slice." },
  { id: "position", label: "Position", describe: "Where each slice sits in the record, earliest first." },
  { id: "length", label: "Length", describe: "Shortest first: the one-hits before the phrases." },
];

/** One slice as the kit sees it, whatever it came from. */
export interface KitSlice {
  /** index into the bindings this came from; this is what `PadKit.order` holds */
  index: number;
  label: string;
  startS: number;
  endS: number;
  fileId: string | null;
}

export interface SliceClass {
  hitClass: HitClass | null;
  /** how often that step is hit across the bars of its section, 0..1 */
  confidence: number;
  method: string;
  /** the note the chord measured under the slice puts it at, 0..11, or null */
  pitchClass: number | null;
  note: string;
}

export interface KitOrdering {
  /** `order[i]` is the slice index pad `i + 1` plays */
  order: number[];
  strategy: OrderStrategy;
  method: string;
  /** one line per pad the producer can read: why that slice is under that key */
  reasons: string[];
  notes: string[];
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Slices from the pads' bindings and the chops they came from. */
export function slicesFromBindings(bindings: PadBindings, spans: ReadonlyMap<string, { startS: number; endS: number }> = new Map()): KitSlice[] {
  const out: KitSlice[] = [];
  bindings.forEach((b, index) => {
    if (!b) return;
    const span = b.chop_id ? spans.get(b.chop_id) : undefined;
    out.push({ index, label: b.label, startS: span?.startS ?? 0, endS: span?.endS ?? 0, fileId: b.file_id });
  });
  return out;
}

/**
 * What each slice is, from what was measured. A slice with no drum pattern
 * under it comes back with a null class and a confidence of zero, and the
 * ordering says so rather than pretending.
 */
export function classifySlices(slices: readonly KitSlice[], report: AnalysisReport | null): Map<number, SliceClass> {
  const out = new Map<number, SliceClass>();
  const stepS = sixteenthSeconds(report);
  const sections = report?.structure?.sections ?? [];
  const patterns = report?.drums?.patterns ?? [];
  const drumMethod = report?.drums?.method ?? "drums";
  const chords = report?.chords?.segments ?? [];
  for (const slice of slices) {
    const pitchClass = pitchClassAt(chords, slice.startS);
    let hitClass: HitClass | null = null;
    let confidence = 0;
    let note = "No drum pattern is measured under this slice.";
    if (stepS !== null && patterns.length > 0) {
      const sectionIndex = sectionIndexAt(sections, slice.startS);
      const pattern = patterns.find((p) => p.section_index === sectionIndex) ?? patterns[0];
      if (pattern) {
        const sectionStart = sections[pattern.section_index]?.start_s ?? 0;
        const perBar = stepsPerBarOf(report);
        const step = (((Math.round((slice.startS - sectionStart) / stepS) % perBar) + perBar) % perBar);
        const best = strongestAtStep(pattern, step);
        if (best) {
          hitClass = best.hitClass;
          confidence = clamp01(best.hit.frequency);
          note = `Step ${step + 1} of the measured pattern is a ${best.hitClass} in ${Math.round(clamp01(best.hit.frequency) * 100)}% of that section's bars.`;
        } else {
          note = `Nothing is measured on step ${step + 1} of that section's pattern.`;
        }
      }
    } else if (patterns.length === 0) {
      note = "No drum pattern is measured on this file.";
    } else {
      note = "No beat grid is measured, so a slice cannot be put on a step.";
    }
    out.set(slice.index, {
      hitClass,
      confidence,
      method: hitClass ? `${drumMethod} (pattern step match)` : "none",
      pitchClass,
      note,
    });
  }
  return out;
}

/** The kit's order under a strategy. Pure, and always a permutation of the pads. */
export function orderKit(
  slices: readonly KitSlice[],
  strategy: OrderStrategy,
  context: { report?: AnalysisReport | null; padCount: number; classes?: ReadonlyMap<number, SliceClass> },
): KitOrdering {
  const padCount = Math.max(0, Math.round(context.padCount));
  const classes = context.classes ?? classifySlices(slices, context.report ?? null);
  const notes: string[] = [];
  let sorted: KitSlice[];
  let method: string;

  switch (strategy) {
    case "hit-class": {
      const classified = slices.filter((s) => classes.get(s.index)?.hitClass);
      if (classified.length === 0) {
        notes.push("No slice could be put on a measured drum step, so the kit stays in file order.");
        return { ...fileOrder(slices, padCount), strategy, notes, method: "none" };
      }
      if (classified.length < slices.length) notes.push(`${slices.length - classified.length} of ${slices.length} slices have no measured class and keep file order after the ones that do.`);
      sorted = [...slices].sort((a, b) => {
        const ka = rankOf(classes.get(a.index)?.hitClass ?? null);
        const kb = rankOf(classes.get(b.index)?.hitClass ?? null);
        if (ka !== kb) return ka - kb;
        const ca = classes.get(a.index)?.confidence ?? 0;
        const cb = classes.get(b.index)?.confidence ?? 0;
        if (ca !== cb) return cb - ca;
        return a.index - b.index;
      });
      method = context.report?.drums?.method ?? "drums";
      break;
    }
    case "pitch": {
      const withPitch = slices.filter((s) => classes.get(s.index)?.pitchClass !== null && classes.get(s.index)?.pitchClass !== undefined);
      if (withPitch.length === 0) {
        notes.push("No chord is measured under any slice, so the kit stays in file order.");
        return { ...fileOrder(slices, padCount), strategy, notes, method: "none" };
      }
      if (withPitch.length < slices.length) notes.push(`${slices.length - withPitch.length} slices have no measured chord and keep file order after the ones that do.`);
      sorted = [...slices].sort((a, b) => {
        const pa = classes.get(a.index)?.pitchClass;
        const pb = classes.get(b.index)?.pitchClass;
        if (pa === null || pa === undefined) return pb === null || pb === undefined ? a.index - b.index : 1;
        if (pb === null || pb === undefined) return -1;
        return pa === pb ? a.index - b.index : pa - pb;
      });
      method = context.report?.chords?.method ?? "chords";
      break;
    }
    case "position":
      sorted = [...slices].sort((a, b) => (a.startS === b.startS ? a.index - b.index : a.startS - b.startS));
      method = "chop start";
      break;
    case "length":
      sorted = [...slices].sort((a, b) => {
        const la = Math.max(0, a.endS - a.startS);
        const lb = Math.max(0, b.endS - b.startS);
        return la === lb ? a.index - b.index : la - lb;
      });
      method = "chop length";
      break;
    default:
      return { ...fileOrder(slices, padCount), strategy: "file", notes, method: "chop index" };
  }

  const order = padOrder(sorted, padCount);
  return { order, strategy, method, reasons: reasonsFor(order, slices, classes, strategy), notes };
}

function fileOrder(slices: readonly KitSlice[], padCount: number): { order: number[]; reasons: string[] } {
  const sorted = [...slices].sort((a, b) => a.index - b.index);
  const order = padOrder(sorted, padCount);
  return { order, reasons: reasonsFor(order, slices, new Map(), "file") };
}

/** Pad `i + 1` plays `order[i]`; -1 where there is no slice left to place. */
function padOrder(sorted: readonly KitSlice[], padCount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < padCount; i++) out.push(sorted[i]?.index ?? -1);
  return out;
}

function reasonsFor(order: readonly number[], slices: readonly KitSlice[], classes: ReadonlyMap<number, SliceClass>, strategy: OrderStrategy): string[] {
  const byIndex = new Map(slices.map((s) => [s.index, s]));
  return order.map((sliceIndex, pad) => {
    const slice = byIndex.get(sliceIndex);
    if (!slice) return `Pad ${pad + 1}: empty.`;
    const cls = classes.get(sliceIndex);
    if (strategy === "hit-class") return `Pad ${pad + 1}: ${slice.label} — ${cls?.hitClass ?? "unclassified"}. ${cls?.note ?? ""}`.trim();
    if (strategy === "pitch") {
      const pc = cls?.pitchClass;
      return `Pad ${pad + 1}: ${slice.label} — ${pc === null || pc === undefined ? "no chord measured" : NOTE_NAMES[pc]}.`;
    }
    if (strategy === "position") return `Pad ${pad + 1}: ${slice.label} — starts at ${slice.startS.toFixed(3)} s.`;
    if (strategy === "length") return `Pad ${pad + 1}: ${slice.label} — ${(Math.max(0, slice.endS - slice.startS) * 1000).toFixed(0)} ms.`;
    return `Pad ${pad + 1}: ${slice.label}.`;
  });
}

/** One line for the panel and the chat. */
export function describeOrdering(ordering: KitOrdering): string {
  const label = ORDER_STRATEGIES.find((s) => s.id === ordering.strategy)?.label ?? ordering.strategy;
  const placed = ordering.order.filter((i) => i >= 0).length;
  return `${label}: ${placed} ${placed === 1 ? "slice" : "slices"} laid out${ordering.method === "none" ? "" : ` from ${ordering.method}`}.`;
}

/** Principle 7: the producer moved a slice the machine had placed. */
export interface KitOrderCorrection {
  field: "kit.pad_assignment";
  pad: number;
  predicted_slice: number;
  corrected_slice: number;
  strategy: OrderStrategy;
  method: string;
  reason: string;
}

export function orderCorrections(before: KitOrdering, afterOrder: readonly number[]): KitOrderCorrection[] {
  const out: KitOrderCorrection[] = [];
  afterOrder.forEach((sliceIndex, pad) => {
    const was = before.order[pad];
    if (was === undefined || was === sliceIndex) return;
    out.push({
      field: "kit.pad_assignment",
      pad: pad + 1,
      predicted_slice: was,
      corrected_slice: sliceIndex,
      strategy: before.strategy,
      method: before.method,
      reason: before.reasons[pad] ?? "",
    });
  });
  return out;
}

// --- the measurements behind all of it ---------------------------------------

function rankOf(hitClass: HitClass | null): number {
  const i = hitClass ? HIT_CLASS_ORDER.indexOf(hitClass) : -1;
  return i < 0 ? HIT_CLASS_ORDER.length : i;
}

function strongestAtStep(
  pattern: { kick: DrumHit[]; snare: DrumHit[]; hat: DrumHit[]; other: DrumHit[] },
  step: number,
): { hitClass: HitClass; hit: DrumHit } | null {
  let best: { hitClass: HitClass; hit: DrumHit } | null = null;
  for (const hitClass of HIT_CLASS_ORDER) {
    const hit = pattern[hitClass].find((h) => h.step === step);
    if (!hit) continue;
    if (!best || hit.frequency > best.hit.frequency) best = { hitClass, hit };
  }
  return best;
}

function sixteenthSeconds(report: AnalysisReport | null): number | null {
  const bpm = report?.tempo?.bpm;
  if (!bpm || !Number.isFinite(bpm) || bpm <= 0) return null;
  return 60 / bpm / 4;
}

function stepsPerBarOf(report: AnalysisReport | null): number {
  const meter = report?.beats?.meter ?? "4/4";
  const top = Number(meter.split("/")[0]);
  return (Number.isFinite(top) && top > 0 ? top : 4) * 4;
}

function sectionIndexAt(sections: ReadonlyArray<{ start_s: number; end_s: number }>, t: number): number {
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i] as { start_s: number; end_s: number };
    if (t >= s.start_s && t < s.end_s) return i;
  }
  return 0;
}

function pitchClassAt(segments: ReadonlyArray<{ start_s: number; end_s: number; label: string }>, t: number): number | null {
  for (const seg of segments) {
    if (t >= seg.start_s && t < seg.end_s) return pitchClassOf(seg.label);
  }
  return null;
}

const NATURALS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pitchClassOf(label: string): number | null {
  const text = label.trim();
  if (text.length === 0) return null;
  const base = NATURALS[text[0]!.toUpperCase()];
  if (base === undefined) return null;
  const next = text[1];
  const shift = next === "#" ? 1 : next === "b" ? -1 : 0;
  return (((base + shift) % 12) + 12) % 12;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}
