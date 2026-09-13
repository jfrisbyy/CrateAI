// Merging vector hits with filter hits, and working out which report fields
// matched so the UI can show them on the row (BUILD_PACKET section 12:
// "Results show the report fields that matched").

import { fmtBpm } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { effective } from "@/lib/report/effective";
import type { FileKind, FileRow, TagRow, VectorMatch } from "@/lib/types/db";
import type { ParsedQuery } from "./parse";
import { DRUM_TAGS, expandTags } from "./vocabulary";

export interface Matched {
  bpm?: number;
  key?: string;
  kind?: FileKind;
  tags?: string[];
  has_drums?: boolean;
  is_loop_based?: boolean;
  similarity?: number;
  /** the filename, title or artist matched the text (name match, filters mode) */
  name?: string;
}

export interface SearchHit {
  file: FileRow;
  matched: Matched;
  similarity?: number;
}

/** The file's tags: the tags table plus the tags inside the report, deduped. */
export function fileTagNames(file: FileRow, rows: readonly TagRow[]): string[] {
  const out = new Set<string>();
  for (const r of rows) if (r.file_id === file.id) out.add(r.tag);
  for (const t of file.report?.tags ?? []) out.add(t.tag);
  return [...out];
}

export function hasDrums(tags: readonly string[]): boolean {
  return tags.some((t) => DRUM_TAGS.includes(t));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Which of the parsed fields this file satisfies, with the file's own values. */
export function matchedFor(file: FileRow, parsed: ParsedQuery, tags: readonly string[], opts: { similarity?: number; nameMatch?: boolean } = {}): Matched {
  const m: Matched = {};
  const report = file.report ? effective(file.report) : null;
  if (parsed.bpm_min !== null && parsed.bpm_max !== null && report?.tempo) {
    const bpm = report.tempo.bpm;
    if (bpm >= parsed.bpm_min && bpm <= parsed.bpm_max) m.bpm = round1(bpm);
  }
  if (parsed.tonic && parsed.mode && report?.key && report.key.tonic === parsed.tonic && report.key.mode === parsed.mode) {
    m.key = displayKey(report.key.tonic, report.key.mode);
  }
  if (parsed.kind && file.kind === parsed.kind) m.kind = file.kind;
  if (parsed.tags.length > 0) {
    const wanted = new Set(expandTags(parsed.tags));
    const hit = tags.filter((t) => wanted.has(t));
    if (hit.length > 0) m.tags = hit;
  }
  if (parsed.has_drums !== null) {
    const drums = hasDrums(tags);
    if (drums === parsed.has_drums) m.has_drums = drums;
  }
  if (parsed.is_loop_based !== null && report?.sample_use && report.sample_use.is_loop_based === parsed.is_loop_based) {
    m.is_loop_based = report.sample_use.is_loop_based;
  }
  if (opts.similarity !== undefined) m.similarity = Math.round(opts.similarity * 1000) / 1000;
  if (opts.nameMatch) m.name = file.title?.trim() || file.original_filename;
  return m;
}

/** Does the file pass the hard filters? Used when the RPC could not apply them (similar_files). */
export function passesFilters(file: FileRow, parsed: ParsedQuery, tags: readonly string[]): boolean {
  const report = file.report ? effective(file.report) : null;
  if (parsed.kind && file.kind !== parsed.kind) return false;
  if (parsed.bpm_min !== null && parsed.bpm_max !== null) {
    const bpm = report?.tempo?.bpm;
    if (bpm === undefined || bpm < parsed.bpm_min || bpm > parsed.bpm_max) return false;
  }
  if (parsed.tonic && parsed.mode) {
    if (!report?.key || report.key.tonic !== parsed.tonic || report.key.mode !== parsed.mode) return false;
  }
  if (parsed.has_drums !== null && hasDrums(tags) !== parsed.has_drums) return false;
  if (parsed.is_loop_based !== null && report?.sample_use?.is_loop_based !== parsed.is_loop_based) return false;
  return true;
}

export function nameMatches(file: FileRow, text: string | null): boolean {
  if (!text) return false;
  const needle = text.toLowerCase();
  const hay = `${file.original_filename} ${file.title ?? ""} ${file.artist ?? ""}`.toLowerCase();
  return needle.split(/\s+/).some((w) => w.length > 1 && hay.includes(w));
}

export interface MergeInput {
  vector: VectorMatch[];
  filtered: FileRow[];
  filesById: Map<string, FileRow>;
  tagRows: TagRow[];
  parsed: ParsedQuery;
  limit: number;
  /** filters mode: mark rows whose names matched the text */
  nameMatch?: boolean;
}

/**
 * Vector hits first, ranked by similarity; then filter-only hits in the order
 * the RPC returned them (newest first). A file appears once.
 */
export function mergeHits(input: MergeInput): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const sortedVector = [...input.vector].sort((a, b) => b.similarity - a.similarity);
  for (const v of sortedVector) {
    if (seen.has(v.file_id)) continue;
    const file = input.filesById.get(v.file_id);
    if (!file) continue;
    seen.add(v.file_id);
    const tags = fileTagNames(file, input.tagRows);
    out.push({ file, matched: matchedFor(file, input.parsed, tags, { similarity: v.similarity }), similarity: v.similarity });
    if (out.length >= input.limit) return out;
  }
  for (const file of input.filtered) {
    if (seen.has(file.id)) continue;
    seen.add(file.id);
    const tags = fileTagNames(file, input.tagRows);
    const nameMatch = input.nameMatch ? nameMatches(file, input.parsed.text_query) : false;
    out.push({ file, matched: matchedFor(file, input.parsed, tags, { nameMatch }) });
    if (out.length >= input.limit) break;
  }
  return out;
}

/** The matched fields as short display parts, e.g. ["92 BPM", "F minor", "dusty"]. */
export function matchedParts(m: Matched): string[] {
  const out: string[] = [];
  if (m.bpm !== undefined) out.push(`${fmtBpm(m.bpm)} BPM`);
  if (m.key) out.push(m.key);
  if (m.kind) out.push(m.kind);
  if (m.tags && m.tags.length > 0) out.push(m.tags.join(", "));
  if (m.has_drums === false) out.push("no drums");
  if (m.has_drums === true) out.push("drums");
  if (m.is_loop_based) out.push("loop-based");
  if (m.similarity !== undefined) out.push(`${Math.round(m.similarity * 100)}% similar`);
  if (m.name) out.push("name");
  return out;
}
