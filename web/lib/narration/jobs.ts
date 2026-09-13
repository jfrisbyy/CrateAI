// The jobs a breakdown's `missing` entries name, and how the web queues them.
//
// analysis/lockedgroove/breakdown/compose.py writes `Missing.job` as one of:
//   "stems"                      separate stems (kind 'stems')
//   "analyze"                    the core analysis on the file itself
//   "analyze:<stage>"            one report stage on the file ('chords', 'sample_use', 'effects_estimates', ...)
//   "analyze:<stem>"             analysis of a stem file that exists but has no report ('drums', 'bass', 'other', 'vocals')
//   "analyze:phase4"             the five stem-aware stages, as the breakdown job queues them
//   "identify_context"           not a job: the user names the track (Phase 5 adds the web tools)
//
// Every request goes through POST /api/jobs { kind, file_id, params }. Partial
// `analyze` runs carry `force: true` because compute skips an analyze job whose
// file already has a report at the current version (jobs/analyze.py); with
// `stages` present compute merges the new sections into the kept report.

import type { JobCreateRequest } from "@/lib/api/types";
import { REPORT_SECTIONS } from "@/lib/types/report";

/** analysis/lockedgroove/jobs/derived.py: PHASE4_STAGES */
export const PHASE4_STAGES = ["chords", "drums", "sample_use", "instrumentation", "effects_estimates"] as const;

export const STEM_NAMES = ["drums", "bass", "other", "vocals", "guitar", "piano"] as const;

export interface StemLink {
  stem: string;
  stem_file_id: string;
}

const STAGE_LABELS: Record<string, string> = {
  chords: "Run chord analysis",
  drums: "Run drum analysis",
  sample_use: "Run sample-use analysis",
  instrumentation: "Run instrumentation analysis",
  effects_estimates: "Run effects estimates",
  structure: "Run structure analysis",
  groove: "Run groove analysis",
  tempo: "Run tempo analysis",
  key: "Run key analysis",
  loudness: "Run loudness analysis",
  spectral: "Run spectral analysis",
  onsets: "Run onset detection",
  beats: "Run beat tracking",
};

/** The button text for a missing entry's job; null when there is no job to queue. */
export function jobLabel(job: string | null | undefined): string | null {
  if (!job) return null;
  if (job === "stems") return "Separate stems";
  if (job === "analyze") return "Run the analysis";
  if (job === "identify_context") return null;
  if (job.startsWith("analyze:")) {
    const what = job.slice("analyze:".length);
    if (what === "phase4") return "Run the breakdown stages";
    if ((STEM_NAMES as readonly string[]).includes(what)) return `Analyze the ${what} stem`;
    return STAGE_LABELS[what] ?? `Run ${what.replace(/_/g, " ")} analysis`;
  }
  return null;
}

/** The same label in a sentence: "I can separate stems for you." */
export function jobOffer(job: string | null | undefined): string | null {
  const label = jobLabel(job);
  if (!label) return null;
  return `I can ${label[0]!.toLowerCase()}${label.slice(1)} for you.`;
}

/**
 * The POST /api/jobs body that measures what a missing entry names. `stems`
 * maps stem names to their file ids (from GET /api/breakdowns/[fileId]);
 * a stem job whose stem is unknown resolves to null (separate stems again).
 */
export function jobRequest(job: string | null | undefined, fileId: string, stems: StemLink[] = []): JobCreateRequest | null {
  if (!job || job === "identify_context") return null;
  if (job === "stems") return { kind: "stems", file_id: fileId, params: { model: "htdemucs_ft" } };
  if (job === "analyze") return { kind: "analyze", file_id: fileId, params: { force: true } };
  if (!job.startsWith("analyze:")) return null;
  const what = job.slice("analyze:".length);
  if (what === "phase4") return { kind: "analyze", file_id: fileId, params: { stages: [...PHASE4_STAGES], force: true } };
  if ((STEM_NAMES as readonly string[]).includes(what)) {
    const link = stems.find((s) => s.stem === what);
    if (!link) return null;
    return { kind: "analyze", file_id: link.stem_file_id, params: { force: true } };
  }
  if ((REPORT_SECTIONS as readonly string[]).includes(what)) {
    return { kind: "analyze", file_id: fileId, params: { stages: [what], force: true } };
  }
  return null;
}

/** The job kinds the breakdown depends on; used to pick the live jobs that matter to the tab. */
export const BREAKDOWN_JOB_KINDS = ["breakdown", "stems", "analyze"] as const;
