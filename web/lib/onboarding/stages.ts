// The first analysis, told honestly.
//
// A running `analyze` job writes one number to `jobs.progress` and nothing
// else: the stage name passed to `ctx.progress(fraction, stage)` is not
// persisted (analysis/lockedgroove/jobs/common.py). The fractions are a fixed
// ladder, though, so the number does say which measurement is running:
//
//   analysis/lockedgroove/jobs/analyze.py  0.02 download, 0.05 decode,
//                                          0.1 + 0.8 * (i / n) per stage,
//                                          0.95 write
//   analysis/lockedgroove/pipeline.py      DEFAULT_STAGES, in order, n = 8
//
// That is what the wait shows: where the job is and what each step produces.
// It never shows a value before the value exists. The report is written once,
// at the end, so there is no half-measured tempo to display at twenty seconds
// and the screen says so rather than inventing one.
//
// `stages.test.ts` reads DEFAULT_STAGES out of pipeline.py and fails if this
// ladder drifts away from it.

import type { JobRow } from "@/lib/types/db";

export interface AnalysisStage {
  /** the pipeline step, or the report section it fills */
  id: string;
  /** what the producer reads */
  label: string;
  /** what this step produces, in the producer's terms */
  gives: string;
  /** the progress fraction the job writes when this step starts */
  at: number;
}

/**
 * The ladder. `at` is the fraction written when the step *starts*, because
 * `analyze_array` reports a stage before running it.
 */
export const ANALYSIS_LADDER: readonly AnalysisStage[] = [
  { id: "download", label: "Fetching", gives: "your file, on the machine that measures it", at: 0.02 },
  { id: "decode", label: "Decoding", gives: "samples, and the waveform you will see", at: 0.05 },
  { id: "tempo", label: "Tempo", gives: "BPM, with the half and the double it also considered", at: 0.1 },
  { id: "beats", label: "Beats", gives: "every beat, the downbeats, and the meter", at: 0.2 },
  { id: "onsets", label: "Onsets", gives: "where the hits land", at: 0.3 },
  { id: "key", label: "Key", gives: "tonic and mode, and the key it nearly chose instead", at: 0.4 },
  { id: "groove", label: "Groove", gives: "swing, and how far off the grid it sits", at: 0.5 },
  { id: "loudness", label: "Loudness", gives: "integrated LUFS and true peak", at: 0.6 },
  { id: "spectral", label: "Spectrum", gives: "brightness, width, and how high the content actually goes", at: 0.7 },
  { id: "structure", label: "Sections", gives: "where it changes, and the bar length it repeats on", at: 0.8 },
  { id: "write", label: "Writing it down", gives: "the report, the waveform and the vitals, all at once", at: 0.9 },
];

/** The report sections this ladder expects the pipeline to run, in order. */
export const LADDER_STAGE_IDS: readonly string[] = ANALYSIS_LADDER.filter(
  (s) => s.id !== "download" && s.id !== "decode" && s.id !== "write",
).map((s) => s.id);

export interface LadderPosition {
  /** index into ANALYSIS_LADDER; -1 before the job has written anything */
  index: number;
  /** the step running now, or null before the first write */
  running: AnalysisStage | null;
  done: readonly AnalysisStage[];
  waiting: readonly AnalysisStage[];
}

const EPS = 1e-9;

/** Where a job with this progress fraction has got to. */
export function positionAt(progress: number | null | undefined): LadderPosition {
  const p = typeof progress === "number" && Number.isFinite(progress) ? progress : null;
  let index = -1;
  if (p !== null) {
    for (let i = 0; i < ANALYSIS_LADDER.length; i++) {
      if ((ANALYSIS_LADDER[i] as AnalysisStage).at <= p + EPS) index = i;
    }
  }
  return {
    index,
    running: index >= 0 ? (ANALYSIS_LADDER[index] as AnalysisStage) : null,
    done: index > 0 ? ANALYSIS_LADDER.slice(0, index) : [],
    waiting: ANALYSIS_LADDER.slice(index + 1),
  };
}

/** Seconds since the job started running, or null if it has not started. */
export function elapsedSeconds(job: Pick<JobRow, "started_at" | "finished_at">, now: Date = new Date()): number | null {
  if (!job.started_at) return null;
  const from = Date.parse(job.started_at);
  if (!Number.isFinite(from)) return null;
  const to = job.finished_at ? Date.parse(job.finished_at) : now.getTime();
  if (!Number.isFinite(to)) return null;
  return Math.max(0, (to - from) / 1000);
}

/** A full analysis of one file: not the loop finder, not a partial re-run. */
export function isFullAnalyze(job: Pick<JobRow, "kind" | "params">): boolean {
  if (job.kind !== "analyze") return false;
  const params = job.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return true;
  return params.task === undefined && params.stages === undefined;
}

export interface PastRuns {
  runs: number;
  medianS: number;
}

/**
 * How long analysis has taken on this account, from its own finished jobs.
 * Null on the first one, because there is nothing to say yet — the screen says
 * that rather than guessing at a duration.
 */
export function pastAnalysisRuns(jobs: readonly JobRow[]): PastRuns | null {
  const durations: number[] = [];
  for (const job of jobs) {
    if (job.status !== "done" || !isFullAnalyze(job)) continue;
    const seconds = elapsedSeconds(job);
    if (seconds !== null && seconds > 0) durations.push(seconds);
  }
  if (durations.length === 0) return null;
  durations.sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const medianS =
    durations.length % 2 === 1
      ? (durations[mid] as number)
      : ((durations[mid - 1] as number) + (durations[mid] as number)) / 2;
  return { runs: durations.length, medianS };
}

/** "48 s", "2:10" — a duration a producer reads, not a clock readout. */
export function fmtElapsed(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
