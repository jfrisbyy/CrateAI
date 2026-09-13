// The candidate rack's data contract, and the two things it has to get right:
// where a candidate starts, and how it is laid under the session.
//
// A candidate is anything the system found that a producer might use — a loop
// the finder ranked, a file the crate says fits, a separated stem. The rack
// shows them as rows you press play on, so the contract is built around what a
// row has to say for itself without another round trip:
//
//   audio        which file, which span of it, where its downbeat is
//   reason       the measurement that earned it a place, in the product's
//                own words, with the confidence and the hedge already picked
//   provenance   which record, which timestamp, which separation model
//   fit          what it would take to sit under this session
//
// Nothing here fetches. The builders take rows the routes already return
// (`/api/compat`, `/api/loops`) and turn them into rows the rack renders, so
// the same rack renders real data and a fixture without knowing the difference.

import { STEM_MODELS, type StemModelId } from "@/lib/api/stems";
import { compareTempo, foldTempo, type Mode, type TrackVitals } from "@/lib/compat/theory";
import type { CompatMatch } from "@/lib/compat/matches";
import { effective } from "@/lib/report/effective";
import type { FileKind, FileRow, LoopRow, Peaks, StemRow } from "@/lib/types/db";
import type { SessionRegion, SessionTrack } from "./types";

export type CandidateKind = "loop" | "file" | "stem" | "chop";

/** One measured claim on a row: the number, what measured it, how sure it is. */
export interface CandidateMeasurement {
  /** the value as a producer reads it: "92 BPM", "+3.9% to fit", "vocal-free" */
  label: string;
  /** the measurement behind it, for the title attribute; never invented */
  method: string | null;
  confidence: number | null;
}

/** Where the audio came from, in enough detail to go back to the source. */
export interface CandidateProvenance {
  fileId: string;
  fileName: string;
  /** the span inside that file, seconds */
  startS: number;
  endS: number;
  kind: FileKind;
  /** "drums" when this is a separated stem */
  stem: string | null;
  /** the separator that made it, and how it is described in the library */
  separationModel: string | null;
  separationModelLabel: string | null;
  /** the record a stem or chop was cut from */
  parentFileId: string | null;
}

/** What it would take to make this sit under the session. */
export interface CandidateFit {
  /** playback rate: source tempo -> session tempo, octave-folded. 1 when nothing is needed. */
  rate: number;
  /** "+3.9% to fit", "half-time", "no tempo on either side" */
  note: string;
  /** transparent / usable / out_of_range / unknown, from the compat thresholds */
  quality: string;
  semitones: number;
  confidence: number | null;
}

export interface RackCandidate {
  id: string;
  title: string;
  kind: CandidateKind;
  /** the file to decode and the span of it to play; `downbeatS` is where play starts */
  audio: { fileId: string; startS: number; endS: number; downbeatS: number };
  /** the one line that says why it is here, in the vocabulary the rest of the product uses */
  reason: string;
  /** the confidence that line rests on; drives the hedge word and the dot */
  confidence: number | null;
  /** why the confidence is what it is ("bounded by the other file's tempo") */
  confidenceReason: string | null;
  measurements: CandidateMeasurement[];
  provenance: CandidateProvenance;
  /** stored peaks for the row's waveform; null means draw the span alone */
  peaks: Peaks | null;
  /** the whole file's duration, so the span can be drawn in context */
  fileDurationS: number | null;
  fit: CandidateFit | null;
  /** where the machine put it, 1-based. A suggestion; the ear decides. */
  rank: number;
}

/** The sounding length of a candidate once its fit rate is applied, in session seconds. */
export function candidateLength(candidate: RackCandidate): number {
  const raw = Math.max(0, candidate.audio.endS - candidate.audio.downbeatS);
  const rate = candidate.fit?.rate ?? 1;
  return rate > 0 ? raw / rate : raw;
}

/** The source id a candidate decodes under: one per library file. */
export function sourceIdOf(candidate: RackCandidate): string {
  return candidate.audio.fileId;
}

// --- building candidates from what the routes already return -----------------

/** The first downbeat in a file's effective report, or its first beat, or zero. */
export function downbeatOf(file: FileRow, notBefore = 0): number {
  const report = file.report ? effective(file.report) : null;
  const downbeats = report?.beats?.downbeats_s ?? [];
  for (const t of downbeats) if (t >= notBefore - 1e-6) return t;
  const beats = report?.beats?.times_s ?? [];
  for (const t of beats) if (t >= notBefore - 1e-6) return t;
  return notBefore;
}

export function vitalsOf(file: FileRow): TrackVitals {
  const report = file.report ? effective(file.report) : null;
  return {
    file_id: file.id,
    bpm: report?.tempo?.bpm ?? null,
    bpm_confidence: report?.tempo?.confidence ?? null,
    tonic: report?.key?.tonic ?? null,
    mode: (report?.key?.mode as Mode | null) ?? null,
    key_confidence: report?.key?.confidence ?? null,
  };
}

/**
 * What it takes to fit `candidate` under `session`. Uses the same octave fold
 * and the same thresholds as the Fits-with panel, so the rack and the panel can
 * never say different things about the same pair.
 */
export function fitTo(session: TrackVitals | null, candidate: TrackVitals, semitones = 0): CandidateFit {
  if (!session || session.bpm === null || candidate.bpm === null || session.bpm <= 0 || candidate.bpm <= 0) {
    return { rate: 1, note: "plays at its own tempo", quality: "unknown", semitones, confidence: candidate.bpm_confidence };
  }
  const [, ratio] = foldTempo(session.bpm, candidate.bpm);
  const tempo = compareTempo(session, candidate);
  const percent = (ratio - 1) * 100;
  const note = Math.abs(percent) < 0.05 ? "already in tempo" : `${percent > 0 ? "+" : ""}${percent.toFixed(1)}% to fit`;
  return { rate: ratio, note, quality: tempo.quality, semitones, confidence: tempo.confidence };
}

/** A loop the finder ranked, as a rack row. The loop's own start is already on the grid. */
export function candidateFromLoop(file: FileRow, loop: LoopRow, rank: number, session: TrackVitals | null = null, stem: StemRow | null = null): RackCandidate {
  const vitals = vitalsOf(file);
  const fit = fitTo(session, vitals);
  const bars = loop.bars;
  const measurements: CandidateMeasurement[] = [];
  if (vitals.bpm !== null) {
    measurements.push({ label: `${vitals.bpm.toFixed(1)} BPM`, method: "tempo from the analysis", confidence: vitals.bpm_confidence });
  }
  if (loop.score !== null) {
    measurements.push({ label: `loop score ${loop.score.toFixed(2)}`, method: "the finder's ranking of this span", confidence: loop.score });
  }
  for (const [name, value] of componentPairs(loop.components)) {
    measurements.push({ label: `${name} ${value.toFixed(2)}`, method: "a component of the loop score", confidence: null });
  }
  if (session && fit.rate !== 1) {
    measurements.push({ label: fit.note, method: "octave-folded tempo ratio against the session", confidence: fit.confidence });
  }
  return {
    id: `loop:${loop.id}`,
    title: loop.name?.trim() || `${bars ?? "—"} bars of ${fileLabel(file)}`,
    kind: "loop",
    audio: { fileId: file.id, startS: loop.start_s, endS: loop.end_s, downbeatS: loop.start_s },
    reason: bars ? `${bars} ${bars === 1 ? "bar" : "bars"} on the grid` : "a loop on the grid",
    confidence: loop.score,
    confidenceReason: loop.origin === "finder" ? "the loop finder's score for this span" : "placed by hand, not scored",
    measurements,
    provenance: provenanceOf(file, loop.start_s, loop.end_s, stem),
    peaks: file.peaks,
    fileDurationS: file.duration_s,
    fit,
    rank,
  };
}

/**
 * A Fits-with match as a rack row: the same measurement the panel shows, but
 * playable. This is the exact case the direction document is about — five
 * records ranked by percussive fraction that the producer could not hear.
 */
export function candidateFromMatch(match: CompatMatch, rank: number, stem: StemRow | null = null): RackCandidate {
  const file = match.file;
  const downbeat = downbeatOf(file);
  const end = file.duration_s ?? downbeat;
  const measurements: CandidateMeasurement[] = [];
  const tempo = match.tempo;
  if (tempo.candidate_bpm !== null) {
    const folded = tempo.fold !== "none" && tempo.folded_bpm !== null ? ` counted ${tempo.fold === "double" ? "double-time" : "half-time"} as ${tempo.folded_bpm.toFixed(1)}` : "";
    measurements.push({ label: `${tempo.candidate_bpm.toFixed(1)} BPM${folded}`, method: tempo.method, confidence: tempo.confidence });
  }
  if (tempo.percent !== null) {
    measurements.push({ label: `${tempo.percent > 0 ? "+" : ""}${tempo.percent.toFixed(1)}% to fit`, method: tempo.note, confidence: tempo.confidence });
  }
  const key = match.key;
  if (key.candidate_tonic && key.candidate_mode) {
    measurements.push({ label: `${key.candidate_tonic} ${key.candidate_mode}`, method: key.method, confidence: key.confidence });
  }
  if (key.semitone_shift !== 0) {
    measurements.push({
      label: `${key.semitone_shift > 0 ? "+" : ""}${key.semitone_shift} st${key.shifts_character ? ", changes character" : ""}`,
      method: key.note,
      confidence: key.confidence,
    });
  }
  if (match.timbre !== null) {
    measurements.push({ label: `${(match.timbre * 100).toFixed(0)}% alike`, method: "cosine similarity of the two embeddings; it only breaks ties", confidence: null });
  }
  return {
    id: `file:${file.id}`,
    title: fileLabel(file),
    kind: file.kind === "stem" ? "stem" : file.kind === "chop" ? "chop" : "file",
    audio: { fileId: file.id, startS: 0, endS: end, downbeatS: downbeat },
    reason: match.reason,
    confidence: match.confidence,
    confidenceReason: match.confidence_reason,
    measurements,
    provenance: provenanceOf(file, downbeat, end, stem),
    peaks: file.peaks,
    fileDurationS: file.duration_s,
    fit: { rate: tempo.ratio ?? 1, note: tempo.note, quality: tempo.quality, semitones: key.semitone_shift, confidence: tempo.confidence },
    rank,
  };
}

export function candidatesFromMatches(matches: readonly CompatMatch[], stems: readonly StemRow[] = []): RackCandidate[] {
  const byFile = new Map(stems.map((s) => [s.stem_file_id, s]));
  return matches.map((m, i) => candidateFromMatch(m, i + 1, byFile.get(m.file.id) ?? null));
}

export function candidatesFromLoops(file: FileRow, loops: readonly LoopRow[], session: TrackVitals | null = null, stem: StemRow | null = null): RackCandidate[] {
  return [...loops]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((loop, i) => candidateFromLoop(file, loop, i + 1, session, stem));
}

function provenanceOf(file: FileRow, startS: number, endS: number, stem: StemRow | null): CandidateProvenance {
  const model = stem?.model ?? null;
  return {
    fileId: file.id,
    fileName: fileLabel(file),
    startS,
    endS,
    kind: file.kind,
    stem: stem?.stem ?? (file.kind === "stem" ? stemNameFrom(file.original_filename) : null),
    separationModel: model,
    separationModelLabel: model ? (STEM_MODELS.find((m) => m.id === (model as StemModelId))?.describe.split(".")[0] ?? model) : null,
    parentFileId: file.parent_file_id,
  };
}

export function fileLabel(file: FileRow): string {
  const title = file.title?.trim();
  if (title) return file.artist?.trim() ? `${file.artist.trim()} — ${title}` : title;
  return file.original_filename.replace(/\.[a-z0-9]+$/i, "");
}

function stemNameFrom(filename: string): string | null {
  const base = filename.toLowerCase().replace(/\.[a-z0-9]+$/i, "");
  for (const name of ["drums", "bass", "vocals", "other", "guitar", "piano", "instrumental"]) {
    if (base.includes(name)) return name;
  }
  return null;
}

function componentPairs(components: LoopRow["components"]): Array<[string, number]> {
  if (!components || typeof components !== "object" || Array.isArray(components)) return [];
  const out: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(components)) if (typeof v === "number") out.push([k, v]);
  return out;
}

// --- laying a candidate under the session ------------------------------------

/** The lane the rack auditions into. One lane, replaced in place, so A/B never adds tracks. */
export const AUDITION_TRACK_ID = "audition";

/** The lane a committed candidate becomes. One per candidate, so committing twice replaces. */
export function trackIdFor(candidate: RackCandidate): string {
  return `track-${candidate.id}`;
}

export interface TilePlan {
  regions: SessionRegion[];
  /** one repeat's sounding length in session seconds */
  cycleS: number;
  repeats: number;
}

/**
 * Tile a candidate across a span of the timeline, starting on its downbeat.
 *
 * This is what "solo against the session" is made of: the candidate is laid
 * under the loop the producer is already listening to, repeated to fill it,
 * the last repeat cut at the locator. Starting at `downbeatS` rather than the
 * file's zero is the difference between a break that lands on the one and a
 * break that arrives late by whatever silence the upload happened to have.
 */
export function tileCandidate(options: {
  candidate: RackCandidate;
  trackId: string;
  span: { startS: number; endS: number };
  gain?: number;
  /** override the fit; the rack passes 1 when the producer asks to hear it raw */
  rate?: number;
  idPrefix?: string;
}): TilePlan {
  const { candidate, trackId, span } = options;
  const gain = options.gain ?? 1;
  const rate = options.rate ?? candidate.fit?.rate ?? 1;
  const sourceSpan = Math.max(0, candidate.audio.endS - candidate.audio.downbeatS);
  const cycleS = rate > 0 ? sourceSpan / rate : sourceSpan;
  const length = span.endS - span.startS;
  const prefix = options.idPrefix ?? `${trackId}:${candidate.id}`;
  if (cycleS <= 0 || length <= 0) return { regions: [], cycleS: 0, repeats: 0 };
  const regions: SessionRegion[] = [];
  let at = span.startS;
  let i = 0;
  while (at < span.endS - 1e-6 && i < 512) {
    const durationS = Math.min(cycleS, span.endS - at);
    regions.push({
      id: `${prefix}:${i}`,
      trackId,
      sourceId: sourceIdOf(candidate),
      startS: at,
      durationS,
      offsetS: candidate.audio.downbeatS,
      gain,
      rate,
    });
    at += cycleS;
    i++;
  }
  return { regions, cycleS, repeats: regions.length };
}

/** The lane a candidate becomes when it is committed to the session. */
export function trackFromCandidate(candidate: RackCandidate, trackId: string, options: { gain?: number } = {}): SessionTrack {
  const p = candidate.provenance;
  const where = `${fmtSpan(p.startS, p.endS)}`;
  const parts = [p.fileName, p.stem, where].filter((x): x is string => Boolean(x));
  return {
    id: trackId,
    name: candidate.title,
    gain: options.gain ?? 1,
    muted: false,
    soloed: false,
    fileId: candidate.audio.fileId,
    origin: "candidate",
    provenance: parts.join(", "),
  };
}

/** The audition lane: ephemeral, replaced on every A/B, never committed by itself. */
export function auditionTrack(candidate: RackCandidate): SessionTrack {
  return { ...trackFromCandidate(candidate, AUDITION_TRACK_ID), name: `Auditioning ${candidate.title}`, origin: "audition", ephemeral: true };
}

function fmtSpan(startS: number, endS: number): string {
  return `${fmtTime(startS)}–${fmtTime(endS)}`;
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return "—";
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s - m * 60)).padStart(2, "0")}`;
}

// --- the producer's pick is data, not just a UI event -------------------------

/**
 * Principle 7: picking the third row over the first is a correction of the
 * ranking, and the ranking should learn from it. This is the payload that
 * records one; nothing writes it yet (there is no route), so the rack keeps it
 * in the session and the handoff says where it should land.
 */
export interface RankCorrection {
  candidateId: string;
  /** where the machine put it */
  predictedRank: number;
  /** what the producer did: auditioned it, committed it, skipped past it */
  action: "audition" | "commit" | "skip";
  /** the rank of the row that was first, so the pair can be compared */
  topRank: number;
  at: string;
}

export function correctionFor(candidate: RackCandidate, action: RankCorrection["action"], at = new Date().toISOString()): RankCorrection {
  return { candidateId: candidate.id, predictedRank: candidate.rank, action, topRank: 1, at };
}

// --- a rack ------------------------------------------------------------------

/** What the rack is matching against, so the header can say so. */
export interface RackSourceVitals {
  fileId: string;
  name: string;
  bpm: number | null;
  bpmConfidence: number | null;
  tonic: string | null;
  mode: Mode | null;
  keyConfidence: number | null;
}

/** A rack is one ask, answered with rows you can play. */
export interface Rack {
  id: string;
  /** the panel's title: "Drums that fit Masquerade" */
  title: string;
  /** what measured the ranking; shown so the order is a suggestion, not an oracle */
  method: string | null;
  /** why the rack is thin, when it is */
  note: string | null;
  source: RackSourceVitals | null;
  candidates: RackCandidate[];
  origin: "compat" | "loops" | "search";
}

export function rackFromCompat(
  response: { source: { file_id: string; name: string; bpm: number | null; bpm_confidence: number | null; tonic: string | null; mode: Mode | null; key_confidence: number | null }; matches: readonly CompatMatch[]; note: string | null; method: string },
  stems: readonly StemRow[] = [],
): Rack {
  const s = response.source;
  return {
    id: `compat:${s.file_id}`,
    title: `What fits ${s.name}`,
    method: response.method,
    note: response.note,
    source: { fileId: s.file_id, name: s.name, bpm: s.bpm, bpmConfidence: s.bpm_confidence, tonic: s.tonic, mode: s.mode, keyConfidence: s.key_confidence },
    candidates: candidatesFromMatches(response.matches, stems),
    origin: "compat",
  };
}

export function rackFromLoops(file: FileRow, loops: readonly LoopRow[], session: TrackVitals | null = null): Rack {
  const vitals = vitalsOf(file);
  return {
    id: `loops:${file.id}`,
    title: `Loops in ${fileLabel(file)}`,
    method: "the loop finder's score on the beat grid",
    note: loops.length === 0 ? "No loops found in this file yet. Run the finder on the Loops tab, or place one by hand." : null,
    source: { fileId: file.id, name: fileLabel(file), bpm: vitals.bpm, bpmConfidence: vitals.bpm_confidence, tonic: vitals.tonic, mode: vitals.mode, keyConfidence: vitals.key_confidence },
    candidates: candidatesFromLoops(file, loops, session),
    origin: "loops",
  };
}

/** The row at a 1-based position, for "play the third one". */
export function candidateAt(rack: Rack | null, index: number): RackCandidate | null {
  return rack?.candidates[index - 1] ?? null;
}

/** The row after (or before) the one sounding, for "next" and "previous". */
export function stepCandidate(rack: Rack | null, current: RackCandidate | null, direction: 1 | -1): RackCandidate | null {
  if (!rack || rack.candidates.length === 0) return null;
  if (!current) return direction === 1 ? (rack.candidates[0] ?? null) : (rack.candidates[rack.candidates.length - 1] ?? null);
  const at = rack.candidates.findIndex((c) => c.id === current.id);
  if (at < 0) return rack.candidates[0] ?? null;
  const next = at + direction;
  if (next < 0 || next >= rack.candidates.length) return null;
  return rack.candidates[next] ?? null;
}

// --- "find me drums": the library search as a rack ----------------------------

/**
 * A search hit as a playable row. This is the ask the direction document is
 * written around — five records went in, one had drums worth using, and the
 * producer never got to hear any of them. The hit already carries what matched
 * (the tag, the tempo, the key, the similarity), so the row can say why it is
 * here without inventing anything.
 */
export function candidateFromHit(hit: SearchHitLike, rank: number, session: TrackVitals | null = null, stem: StemRow | null = null): RackCandidate {
  const file = hit.file;
  const vitals = vitalsOf(file);
  const fit = fitTo(session, vitals);
  const downbeat = downbeatOf(file);
  const end = file.duration_s ?? downbeat;
  const matched = hit.matched ?? {};
  const measurements: CandidateMeasurement[] = [];
  if (vitals.bpm !== null) measurements.push({ label: `${vitals.bpm.toFixed(1)} BPM`, method: "tempo from the analysis", confidence: vitals.bpm_confidence });
  if (vitals.tonic && vitals.mode) measurements.push({ label: `${vitals.tonic} ${vitals.mode}`, method: "key from the analysis", confidence: vitals.key_confidence });
  if (matched.tags && matched.tags.length > 0) measurements.push({ label: matched.tags.join(", "), method: "tags the query asked for", confidence: null });
  if (matched.similarity !== undefined) measurements.push({ label: `${Math.round(matched.similarity * 100)}% alike`, method: "cosine similarity of the embeddings", confidence: null });
  if (session && fit.rate !== 1) measurements.push({ label: fit.note, method: "octave-folded tempo ratio against the session", confidence: fit.confidence });
  return {
    id: `hit:${file.id}`,
    title: fileLabel(file),
    kind: file.kind === "stem" ? "stem" : file.kind === "chop" ? "chop" : "file",
    audio: { fileId: file.id, startS: 0, endS: end, downbeatS: downbeat },
    reason: searchReason(matched),
    confidence: matched.similarity ?? null,
    confidenceReason: matched.similarity !== undefined ? "similarity of the embeddings, not a measurement of fit" : "matched the filters exactly",
    measurements,
    provenance: provenanceOf(file, 0, end, stem),
    peaks: file.peaks,
    fileDurationS: file.duration_s,
    fit,
    rank,
  };
}

/** The shape `/api/search` returns per hit; kept structural so this file imports no route. */
export interface SearchHitLike {
  file: FileRow;
  matched?: { bpm?: number; key?: string; kind?: string; tags?: string[]; has_drums?: boolean; is_loop_based?: boolean; similarity?: number; name?: string };
}

function searchReason(matched: SearchHitLike["matched"]): string {
  const parts: string[] = [];
  if (matched?.tags && matched.tags.length > 0) parts.push(matched.tags.join(", "));
  if (matched?.has_drums) parts.push("has drums");
  if (matched?.is_loop_based) parts.push("loop-based");
  if (matched?.bpm !== undefined) parts.push(`${matched.bpm} BPM`);
  if (matched?.key) parts.push(matched.key);
  if (matched?.name) parts.push(`name matches "${matched.name}"`);
  if (parts.length === 0 && matched?.similarity !== undefined) return "sounds like what you asked for";
  return parts.length > 0 ? parts.join(" · ") : "in the crate";
}

export function rackFromSearch(query: string, hits: readonly SearchHitLike[], note: string | null, mode: string, session: TrackVitals | null = null): Rack {
  return {
    id: `search:${query}`,
    title: query.trim() === "" ? "The crate" : `“${query.trim()}” in the crate`,
    method: mode === "vector" ? "text through the embedding, then the filters the query named" : "the filters the query named",
    note,
    source: null,
    candidates: hits.map((hit, i) => candidateFromHit(hit, i + 1, session)),
    origin: "search",
  };
}
