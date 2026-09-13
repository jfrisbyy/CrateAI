// Turning the coarse candidate set from the compatible_files RPC into ranked,
// explained matches. Pure: the route hands in rows, this hands back the list the
// panel renders. Nothing here fetches anything.

import { effective } from "@/lib/report/effective";
import type { FileRow } from "@/lib/types/db";
import { compatibility, isTonal, type Compatibility, type CompatibilityOptions, type TrackVitals } from "./theory";

/** Scores this close count as a tie, and timbre decides between them. */
export const SCORE_TIE = 0.01;

export interface CompatMatch extends Compatibility {
  file: FileRow;
  /** cosine similarity of the two CLAP embeddings, when both files carry one in the same model */
  timbre: number | null;
}

/**
 * The file's effective vitals: a user's correction wins over the prediction
 * (principle 7), which is the same resolution compatible_files does in SQL.
 */
export function vitalsFromFile(file: FileRow): TrackVitals {
  const report = file.report ? effective(file.report) : null;
  const tags = (report?.tags ?? []).map((t) => t.tag);
  return {
    file_id: file.id,
    bpm: report?.tempo?.bpm ?? null,
    bpm_confidence: report?.tempo?.confidence ?? null,
    tonic: report?.key?.tonic ?? null,
    mode: report?.key?.mode ?? null,
    key_confidence: report?.key?.confidence ?? null,
    tonal: isTonal(file.kind, tags, file.original_filename),
  };
}

/** pgvector comes back as a string from PostgREST and as an array from some clients. */
export function parseVector(value: number[] | string | null | undefined): number[] | null {
  if (Array.isArray(value)) return value.every((n) => typeof n === "number" && Number.isFinite(n)) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const inner = trimmed.slice(1, -1).trim();
  if (inner === "") return null;
  const out: number[] = [];
  for (const part of inner.split(",")) {
    const n = Number(part);
    if (!Number.isFinite(n)) return null;
    out.push(n);
  }
  return out;
}

/** Cosine similarity, or null when the vectors cannot be compared. */
export function cosine(a: number[], b: number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na <= 0 || nb <= 0) return null;
  return Math.max(-1, Math.min(1, dot / (Math.sqrt(na) * Math.sqrt(nb))));
}

export interface EmbeddingLike {
  file_id: string;
  model: string;
  vector: number[] | string | null;
}

/**
 * Timbre similarity of every candidate to the source, from the CLAP embeddings
 * both already carry. Only vectors from the same model are compared: two models
 * do not share a space. Files without an embedding get nothing, not a zero.
 */
export function timbreSimilarity(sourceFileId: string, rows: EmbeddingLike[]): Map<string, number> {
  const out = new Map<string, number>();
  const source = rows.filter((r) => r.file_id === sourceFileId);
  if (source.length === 0) return out;
  for (const src of source) {
    const srcVector = parseVector(src.vector);
    if (!srcVector) continue;
    for (const row of rows) {
      if (row.file_id === sourceFileId || row.model !== src.model || out.has(row.file_id)) continue;
      const vector = parseVector(row.vector);
      if (!vector) continue;
      const similarity = cosine(srcVector, vector);
      if (similarity !== null) out.set(row.file_id, similarity);
    }
  }
  return out;
}

export function fileName(file: FileRow): string {
  return file.title?.trim() || file.original_filename;
}

/** How many of the two axes could actually be checked on this pair. */
export function measuredAxes(m: CompatMatch): number {
  return (m.tempo.quality === "unknown" ? 0 : 1) + (m.key.relationship === "unknown" ? 0 : 1);
}

/**
 * Rank: the score first, then timbre inside a tie, then how much was measured,
 * then the smaller move.
 *
 * Scores land on a handful of values (five relationships times a short list of
 * stretches), so ties are the normal case rather than the exception -- which is
 * exactly where "and which of these two sounds more like my record" is the
 * question worth answering, and what the CLAP embedding is for.
 *
 * A keyless drum break at the same tempo scores as high as an exact key match,
 * because on everything that could be measured it is as good. What separates
 * them is that one was checked on both axes and the other on one, so at an equal
 * score the fully measured pair goes first: an absence of a measurement is not
 * evidence (principle 2).
 */
export function rankMatches(matches: CompatMatch[]): CompatMatch[] {
  const bucket = (m: CompatMatch) => Math.round(m.score / SCORE_TIE);
  return [...matches].sort((a, b) => {
    const byScore = bucket(b) - bucket(a);
    if (byScore !== 0) return byScore;
    const byTimbre = (b.timbre ?? -1) - (a.timbre ?? -1);
    if (Math.abs(byTimbre) > 1e-9) return byTimbre;
    const byMeasured = measuredAxes(b) - measuredAxes(a);
    if (byMeasured !== 0) return byMeasured;
    const byDistance = (a.tempo.distance ?? 1) - (b.tempo.distance ?? 1);
    if (Math.abs(byDistance) > 1e-9) return byDistance;
    const byShift = Math.abs(a.key.semitone_shift) - Math.abs(b.key.semitone_shift);
    if (byShift !== 0) return byShift;
    return fileName(a.file).localeCompare(fileName(b.file));
  });
}

export interface BuildOptions extends CompatibilityOptions {
  /** drop pairs the bands rule out; the coarse SQL filter already did most of this */
  keepIncompatible?: boolean;
  limit?: number;
}

/** Score every candidate against the source, drop the ones that do not fit, rank the rest. */
export function buildMatches(
  source: FileRow,
  candidates: FileRow[],
  timbre: Map<string, number>,
  options: BuildOptions = {},
): CompatMatch[] {
  const sourceVitals = vitalsFromFile(source);
  const matches: CompatMatch[] = [];
  for (const file of candidates) {
    if (file.id === source.id) continue;
    const match = compatibility(sourceVitals, vitalsFromFile(file), options);
    if (!match.compatible && !options.keepIncompatible) continue;
    matches.push({ ...match, file, timbre: timbre.get(file.id) ?? null });
  }
  const ranked = rankMatches(matches);
  return options.limit ? ranked.slice(0, options.limit) : ranked;
}
