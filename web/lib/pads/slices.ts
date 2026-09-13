// Where the cuts go — the first of the four places the AI helps, and the one
// that is pure measurement.
//
// Material decides the method, which is why the answer differs for a break, a
// horn line and a long phrase: transients for drums, note starts for melodic
// material, section edges for a phrase. All three come out of onset, beat,
// chord and structure work the analysis already did, so nothing here guesses
// and nothing here needs a model call.
//
// Two rules from the direction document, both mechanical here:
//
//   - a cut is proposed, never placed silently. Every point carries the
//     measurement behind it and a reason in the product's own words, and the
//     producer accepts or changes them before anything is chopped.
//   - a cut is editable. `moveSlicePoint` is the drag; the move is recorded as
//     a correction (principle 7) with the proposal it started from.

import { CHOP_DEFAULTS, CHOP_LIMITS } from "@/lib/api/chops";
import type { AnalysisReport } from "@/lib/types/report";

export type SliceMaterial = "break" | "melodic" | "phrase";

export const SLICE_MATERIALS: ReadonlyArray<{ id: SliceMaterial; label: string; describe: string }> = [
  { id: "break", label: "Break", describe: "Cut on the transients: every hit of the break gets its own key." },
  { id: "melodic", label: "Melodic", describe: "Cut where the notes and the chords change, not where the drums hit." },
  { id: "phrase", label: "Phrase", describe: "Cut at the section edges: one key a section of a long record." },
];

export type SliceOrigin = "proposed" | "moved" | "added";

export interface SlicePoint {
  id: string;
  /** seconds into the file */
  timeS: number;
  /** one line in the product's vocabulary: why this cut is here */
  reason: string;
  /** the measurement behind it, the same string the report uses */
  method: string;
  confidence: number;
  origin: SliceOrigin;
}

export interface SliceProposal {
  material: SliceMaterial;
  points: SlicePoint[];
  /** why this material got this method */
  why: string;
  method: string;
  /** what was measured, and what was missing */
  notes: string[];
}

export interface ProposeOptions {
  material?: SliceMaterial;
  /** most points to propose; the layout's pad count is the natural number */
  maxPoints?: number;
  fromS?: number;
  toS?: number;
  /** never two cuts closer than this */
  minGapS?: number;
}

/**
 * The onset detector reports no confidence of its own, so a cut that only an
 * onset supports carries this and says so. A cut that also lands on a measured
 * beat inherits the beat tracker's confidence instead, which is a real number.
 */
const ONSET_ONLY_CONFIDENCE = 0.5;
const BEAT_WINDOW_S = 0.03;
const NOTE_START_WINDOW_S = 0.06;

export interface MaterialGuess {
  material: SliceMaterial;
  why: string;
  confidence: number;
}

/** What this file looks like, from what was measured. Never from its name. */
export function suggestMaterial(report: AnalysisReport | null, durationS: number | null = null): MaterialGuess {
  if (!report) return { material: "break", why: "Nothing is measured yet, so the cuts fall back to the transients.", confidence: 0 };
  const sections = report.structure?.sections ?? [];
  const drums = report.drums;
  const chords = report.chords?.segments ?? [];
  const long = (durationS ?? 0) >= 30 || sections.length >= 3;
  if (drums && drums.source_estimate !== "unknown" && !long) {
    return {
      material: "break",
      why: `The drums measure as ${drums.source_estimate.replace("_", " ")}, so the cuts go on the transients.`,
      confidence: drums.source_confidence,
    };
  }
  if (long && sections.length >= 2) {
    return {
      material: "phrase",
      why: `${sections.length} sections were measured across ${durationS ? `${Math.round(durationS)} s` : "the file"}, so the cuts go on the section edges.`,
      confidence: sections.reduce((m, s) => Math.max(m, s.confidence), 0),
    };
  }
  if (chords.length >= 2) {
    return {
      material: "melodic",
      why: `${chords.length} chord segments were measured and no break was, so the cuts go where the notes change.`,
      confidence: chords.reduce((m, c) => Math.max(m, c.confidence), 0),
    };
  }
  if (drums) {
    return { material: "break", why: "Drums were measured, so the cuts go on the transients.", confidence: drums.source_confidence };
  }
  return { material: "break", why: "Only onsets were measured, so the cuts go on the transients.", confidence: ONSET_ONLY_CONFIDENCE };
}

/** Propose the cuts. Pure: the same report and options always give the same points. */
export function proposeSlicePoints(report: AnalysisReport | null, options: ProposeOptions = {}): SliceProposal {
  const guess = suggestMaterial(report, report?.file?.duration_s ?? null);
  const material = options.material ?? guess.material;
  const maxPoints = Math.max(1, Math.min(CHOP_LIMITS.markers, options.maxPoints ?? CHOP_DEFAULTS.count));
  const minGapS = Math.max(0, options.minGapS ?? CHOP_DEFAULTS.min_gap_ms / 1000);
  const fromS = Math.max(0, options.fromS ?? 0);
  const toS = options.toS ?? Number.POSITIVE_INFINITY;
  const notes: string[] = [];
  const why = options.material && options.material !== guess.material ? `${guess.why} You asked for ${material} cuts instead.` : guess.why;

  if (!report) {
    return { material, points: [], why, method: "none", notes: ["Nothing has been measured on this file yet."] };
  }

  const candidates =
    material === "phrase"
      ? sectionPoints(report, notes)
      : material === "melodic"
        ? notePoints(report, notes)
        : transientPoints(report, notes);

  const method = candidates.method;
  const inRange = candidates.points.filter((p) => p.timeS >= fromS && p.timeS <= toS);
  if (inRange.length < candidates.points.length) notes.push(`${candidates.points.length - inRange.length} cuts fell outside the span you asked for.`);
  const spaced = spaceOut(inRange, minGapS);
  if (spaced.length < inRange.length) notes.push(`${inRange.length - spaced.length} cuts were closer than ${Math.round(minGapS * 1000)} ms to the one before and were dropped.`);
  const points = spaced.slice(0, maxPoints);
  if (spaced.length > maxPoints) notes.push(`${spaced.length} cuts were found; the ${maxPoints} strongest are here.`);
  return { material, points: renumber(points), why, method, notes };
}

interface Candidates {
  points: SlicePoint[];
  method: string;
}

function transientPoints(report: AnalysisReport, notes: string[]): Candidates {
  const onsets = report.onsets;
  if (!onsets || onsets.times_s.length === 0) {
    notes.push("No onsets are measured on this file, so there is nothing to cut on.");
    return { points: [], method: "none" };
  }
  const beats = report.beats?.times_s ?? [];
  const downbeats = report.beats?.downbeats_s ?? [];
  const beatConfidence = report.beats?.confidence ?? 0;
  const points = onsets.times_s.map((t, i) => {
    const onBeat = nearestWithin(beats, t, BEAT_WINDOW_S) !== null;
    const onDownbeat = nearestWithin(downbeats, t, BEAT_WINDOW_S) !== null;
    const reason = onDownbeat
      ? `Onset on a measured downbeat at ${fmt(t)} s`
      : onBeat
        ? `Onset on a measured beat at ${fmt(t)} s`
        : `Onset at ${fmt(t)} s`;
    return point(`onset-${i}`, t, reason, onsets.method, onBeat ? beatConfidence : ONSET_ONLY_CONFIDENCE);
  });
  if (beats.length === 0) notes.push("No beat grid is measured, so no cut can say it lands on the beat.");
  notes.push(`Onsets from ${onsets.method}; the detector reports no confidence of its own, so a cut that is not also on a beat carries ${ONSET_ONLY_CONFIDENCE}.`);
  return { points, method: onsets.method };
}

function notePoints(report: AnalysisReport, notes: string[]): Candidates {
  const segments = report.chords?.segments ?? [];
  const onsets = report.onsets?.times_s ?? [];
  if (segments.length === 0) {
    notes.push("No chord segments are measured, so the note starts fall back to the onsets.");
    return transientPoints(report, notes);
  }
  const method = report.chords?.method ?? "chords";
  const points = segments.map((seg, i) => {
    const snapped = nearestWithin(onsets, seg.start_s, NOTE_START_WINDOW_S);
    const timeS = snapped ?? seg.start_s;
    const reason =
      snapped === null
        ? `Chord change to ${seg.label} at ${fmt(seg.start_s)} s`
        : `Note start nearest the change to ${seg.label}, ${fmt(timeS)} s`;
    return point(`chord-${i}`, timeS, reason, snapped === null ? method : `${method} + onsets`, seg.confidence);
  });
  if (onsets.length === 0) notes.push("No onsets are measured, so each cut sits on the chord boundary itself rather than on the note that starts it.");
  return { points, method };
}

function sectionPoints(report: AnalysisReport, notes: string[]): Candidates {
  const sections = report.structure?.sections ?? [];
  if (sections.length === 0) {
    notes.push("No sections are measured, so the cuts fall back to the transients.");
    return transientPoints(report, notes);
  }
  const method = report.structure?.method ?? "structure";
  const points = sections.map((s, i) =>
    point(`section-${i}`, s.start_s, `${s.label} starts at ${fmt(s.start_s)} s, bar ${s.start_bar + 1}`, method, s.confidence),
  );
  return { points, method };
}

function point(id: string, timeS: number, reason: string, method: string, confidence: number): SlicePoint {
  return { id, timeS: round3(timeS), reason, method, confidence: clamp01(confidence), origin: "proposed" };
}

/** Keep the strongest of any cluster closer than the gap. */
function spaceOut(points: readonly SlicePoint[], minGapS: number): SlicePoint[] {
  const sorted = [...points].sort((a, b) => a.timeS - b.timeS);
  const out: SlicePoint[] = [];
  for (const p of sorted) {
    const last = out[out.length - 1];
    if (last && p.timeS - last.timeS < minGapS) {
      if (p.confidence > last.confidence) out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

function renumber(points: readonly SlicePoint[]): SlicePoint[] {
  return [...points].sort((a, b) => a.timeS - b.timeS);
}

/**
 * Drag a cut. It cannot cross its neighbours — that would renumber the kit
 * under the producer's hands — and it keeps the reason it was proposed with,
 * marked as moved so the correction can say what changed.
 */
export function moveSlicePoint(proposal: SliceProposal, id: string, toS: number, options: { minGapS?: number; maxS?: number } = {}): SliceProposal {
  const gap = Math.max(0, options.minGapS ?? CHOP_DEFAULTS.min_gap_ms / 1000);
  const i = proposal.points.findIndex((p) => p.id === id);
  if (i < 0) return proposal;
  const before = proposal.points[i - 1];
  const after = proposal.points[i + 1];
  const lo = before ? before.timeS + gap : 0;
  const hi = Math.min(after ? after.timeS - gap : Number.POSITIVE_INFINITY, options.maxS ?? Number.POSITIVE_INFINITY);
  const timeS = round3(Math.max(lo, Math.min(hi, Math.max(0, toS))));
  const points = [...proposal.points];
  const current = points[i] as SlicePoint;
  if (current.timeS === timeS) return proposal;
  points[i] = { ...current, timeS, origin: "moved" };
  return { ...proposal, points };
}

export function addSlicePoint(proposal: SliceProposal, timeS: number, reason = "Placed by hand"): SliceProposal {
  const t = round3(Math.max(0, timeS));
  if (proposal.points.some((p) => Math.abs(p.timeS - t) < 1e-3)) return proposal;
  const added: SlicePoint = { id: `added-${t.toFixed(3)}`, timeS: t, reason, method: "user", confidence: 1, origin: "added" };
  return { ...proposal, points: renumber([...proposal.points, added]) };
}

export function removeSlicePoint(proposal: SliceProposal, id: string): SliceProposal {
  const points = proposal.points.filter((p) => p.id !== id);
  return points.length === proposal.points.length ? proposal : { ...proposal, points };
}

/** The markers a manual chop takes. Accepting a proposal runs the route that already exists. */
export function markersFor(proposal: SliceProposal): number[] {
  return proposal.points.map((p) => p.timeS).slice(0, CHOP_LIMITS.markers);
}

/** One line for the panel and for the chat, in the same words. */
export function describeProposal(proposal: SliceProposal): string {
  if (proposal.points.length === 0) return `Nothing to cut on: ${proposal.notes[0] ?? "nothing measured."}`;
  const moved = proposal.points.filter((p) => p.origin !== "proposed").length;
  const label = SLICE_MATERIALS.find((m) => m.id === proposal.material)?.label.toLowerCase() ?? proposal.material;
  return `${proposal.points.length} ${label} cuts from ${proposal.method}${moved > 0 ? `, ${moved} moved by hand` : ""}.`;
}

/** Principle 7: a moved cut is a correction against what was proposed. */
export interface SliceCorrection {
  field: "chop.slice_point";
  predicted_s: number;
  corrected_s: number;
  method: string;
  confidence: number;
  reason: string;
}

export function sliceCorrections(proposed: SliceProposal, edited: SliceProposal): SliceCorrection[] {
  const byId = new Map(proposed.points.map((p) => [p.id, p]));
  const out: SliceCorrection[] = [];
  for (const p of edited.points) {
    const was = byId.get(p.id);
    if (!was || was.timeS === p.timeS) continue;
    out.push({ field: "chop.slice_point", predicted_s: was.timeS, corrected_s: p.timeS, method: was.method, confidence: was.confidence, reason: was.reason });
  }
  return out;
}

function nearestWithin(sorted: readonly number[], t: number, window: number): number | null {
  let best: number | null = null;
  let bestD = window;
  for (const x of sorted) {
    const d = Math.abs(x - t);
    if (d <= bestD) {
      best = x;
      bestD = d;
    }
  }
  return best;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function fmt(t: number): string {
  return t.toFixed(3);
}
