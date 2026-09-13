// The second session.
//
// Arriving with ten records is a different problem from arriving with none.
// Nothing needs teaching any more, so the strip at the top of the chat stops
// teaching and starts reporting: what landed while they were away, what
// failed, and what the crate now measures. When there is nothing true to say
// it says nothing at all — `crateLines` returns an empty list and the strip
// does not render.

import { effective } from "@/lib/report/effective";
import { displayKey } from "@/lib/music/keys";
import { fmtBpm, fmtDuration } from "@/lib/format";
import type { FileRow, JobRow } from "@/lib/types/db";
import { isFullAnalyze } from "./stages";

export interface CrateSummary {
  /** analyzed originals: what the crate can actually answer about */
  records: number;
  /** originals still queued or analyzing */
  working: number;
  failed: number;
  /** every derived row: stems, chops, loops, layers, re-voices */
  derived: number;
  totalDurationS: number;
  tempoRange: { lo: number; hi: number } | null;
  keys: number;
  /** analyzed since the producer was last here, newest first */
  newSince: FileRow[];
}

function isOriginal(file: FileRow): boolean {
  return file.kind === "original";
}

/**
 * Files whose full analysis finished after `since`. Read from the analyze
 * jobs rather than `files.updated_at`, so an edit to a title or a corrected
 * BPM does not get reported as new work.
 */
function analyzedSince(files: readonly FileRow[], jobs: readonly JobRow[], since: string | null): FileRow[] {
  if (!since) return [];
  const cut = Date.parse(since);
  if (!Number.isFinite(cut)) return [];
  const ids = new Set<string>();
  for (const job of jobs) {
    if (job.status !== "done" || !job.file_id || !isFullAnalyze(job)) continue;
    const at = job.finished_at ? Date.parse(job.finished_at) : NaN;
    if (Number.isFinite(at) && at > cut) ids.add(job.file_id);
  }
  return files.filter((f) => ids.has(f.id) && f.status === "ready");
}

export function summarizeCrate(
  files: readonly FileRow[],
  jobs: readonly JobRow[],
  options: { since?: string | null } = {},
): CrateSummary {
  const originals = files.filter(isOriginal);
  const ready = originals.filter((f) => f.status === "ready");

  let totalDurationS = 0;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  const keys = new Set<string>();
  for (const file of ready) {
    totalDurationS += file.duration_s ?? 0;
    const report = file.report ? effective(file.report) : null;
    if (report?.tempo) {
      lo = Math.min(lo, report.tempo.bpm);
      hi = Math.max(hi, report.tempo.bpm);
    }
    if (report?.key) keys.add(displayKey(report.key.tonic, report.key.mode));
  }

  return {
    records: ready.length,
    working: originals.filter((f) => f.status === "queued" || f.status === "analyzing" || f.status === "uploading").length,
    failed: originals.filter((f) => f.status === "failed").length,
    derived: files.length - originals.length,
    totalDurationS,
    tempoRange: Number.isFinite(lo) && Number.isFinite(hi) ? { lo, hi } : null,
    keys: keys.size,
    newSince: analyzedSince(files, jobs, options.since ?? null),
  };
}

/**
 * What the crate is, in numbers it measured. One line, no adjectives.
 * "12 records, 48:31, 71.0-96.4 BPM, 7 keys"
 */
export function crateLine(summary: CrateSummary): string | null {
  if (summary.records === 0) return null;
  const parts = [`${summary.records} record${summary.records === 1 ? "" : "s"}`, fmtDuration(summary.totalDurationS)];
  if (summary.tempoRange) {
    parts.push(
      summary.tempoRange.lo === summary.tempoRange.hi
        ? `${fmtBpm(summary.tempoRange.lo)} BPM`
        : `${fmtBpm(summary.tempoRange.lo)}–${fmtBpm(summary.tempoRange.hi)} BPM`,
    );
  }
  if (summary.keys > 0) parts.push(`${summary.keys} key${summary.keys === 1 ? "" : "s"}`);
  if (summary.derived > 0) parts.push(`${summary.derived} derived`);
  return parts.join(", ");
}

/**
 * What is worth saying on the way back in, most actionable first. Empty when
 * the crate is quiet, which is the common case and the right answer for it.
 */
export function crateLines(summary: CrateSummary): string[] {
  const lines: string[] = [];
  if (summary.newSince.length > 0) {
    lines.push(
      summary.newSince.length === 1
        ? "1 record finished analyzing while you were away."
        : `${summary.newSince.length} records finished analyzing while you were away.`,
    );
  }
  if (summary.working > 0) {
    lines.push(summary.working === 1 ? "1 is still in the queue." : `${summary.working} are still in the queue.`);
  }
  if (summary.failed > 0) {
    lines.push(
      summary.failed === 1
        ? "1 did not analyze; open it to see why, or retry it in the library."
        : `${summary.failed} did not analyze; open them to see why, or retry them in the library.`,
    );
  }
  return lines;
}
