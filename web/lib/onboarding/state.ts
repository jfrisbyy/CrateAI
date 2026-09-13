// The first run, as a state machine over what the workspace already knows.
//
// There is no separate onboarding flow to get out of step with the product:
// the step is derived from the library store (files, jobs, the upload queue)
// plus five remembered facts. Anything that moves a file forward moves the
// first run forward, including a drop into the library rail, a retry from a
// row, or a second tab.
//
// The shape of it:
//
//   empty      nothing in the crate, nothing uploading. The only screen that
//              has to teach, because there is nothing else to look at.
//   uploading  hashing, deduping, uploading — real client-side progress.
//   queued     the row exists; compute has not picked it up.
//   analyzing  the ladder in stages.ts, driven by jobs.progress.
//   failed     what went wrong, and the retry.
//   ready      the measurements, with their confidences. The teaching moment.
//   returning  a crate that already works: what landed, what broke, what is in it.
//   silent     nothing true worth saying. Renders nothing.
//
// The working steps only show while the crate has no analyzed record at all.
// Once there is one, the library rail's own progress line is enough and the
// strip gets out of the way.

import type { FileRow, JobRow } from "@/lib/types/db";
import type { UploadItem } from "@/lib/upload/uploader";
import { summarizeCrate, crateLines, type CrateSummary } from "./crate";
import { isNewSession, type OnboardingMemory } from "./memory";
import { isFullAnalyze } from "./stages";

/** The part of an upload queue item this decision needs. */
export type UploadLike = Pick<UploadItem, "id" | "name" | "size" | "state" | "progress" | "error" | "dispatchNote"> & {
  fileRow: { id: string } | null;
};

export type FirstRunStep =
  | { kind: "empty" }
  | { kind: "uploading"; upload: UploadLike; others: number }
  | { kind: "queued"; file: FileRow; job: JobRow | null }
  | { kind: "analyzing"; file: FileRow; job: JobRow | null }
  | { kind: "failed"; file: FileRow; job: JobRow | null }
  | { kind: "ready"; file: FileRow }
  | { kind: "returning"; summary: CrateSummary; newSession: boolean }
  | { kind: "silent" };

export interface FirstRunInput {
  files: readonly FileRow[];
  jobs: readonly JobRow[];
  uploads: readonly UploadLike[];
  memory: OnboardingMemory;
  now?: Date;
}

const TERMINAL_UPLOAD_STATES = new Set(["done", "exists"]);

function byCreatedAsc(a: FileRow, b: FileRow): number {
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

/** The analyze job this file is waiting on, or the last one it ran. */
export function analyzeJobFor(jobs: readonly JobRow[], fileId: string): JobRow | null {
  const mine = jobs.filter((j) => j.file_id === fileId && isFullAnalyze(j));
  return (
    mine.find((j) => j.status === "running") ??
    mine.find((j) => j.status === "queued") ??
    mine.find((j) => j.status === "failed") ??
    mine[0] ??
    null
  );
}

/**
 * The record the first run is about: the one they were taught on if it is
 * still here, otherwise the first one that came back, otherwise whichever is
 * furthest along.
 */
export function firstRunSubject(files: readonly FileRow[], memory: OnboardingMemory): FileRow | null {
  const originals = files.filter((f) => f.kind === "original").sort(byCreatedAsc);
  if (originals.length === 0) return null;
  if (memory.firstReadyFileId) {
    const remembered = originals.find((f) => f.id === memory.firstReadyFileId);
    if (remembered) return remembered;
  }
  const ready = originals.find((f) => f.status === "ready" && f.report !== null);
  if (ready) return ready;
  const rank: Record<FileRow["status"], number> = { analyzing: 0, queued: 1, uploading: 2, failed: 3, ready: 4 };
  return [...originals].sort((a, b) => rank[a.status] - rank[b.status] || byCreatedAsc(a, b))[0] ?? null;
}

export function firstRunStep(input: FirstRunInput): FirstRunStep {
  const now = input.now ?? new Date();
  const originals = input.files.filter((f) => f.kind === "original");
  const analyzed = originals.filter((f) => f.status === "ready" && f.report !== null);
  const live = input.uploads.filter((u) => !TERMINAL_UPLOAD_STATES.has(u.state));

  // An empty crate is a dead end however long you have been here.
  if (originals.length === 0 && live.length === 0) return { kind: "empty" };

  // Nothing analyzed yet: the wait is the product, so show it in full. A row
  // that compute has already taken beats an upload still moving bytes.
  if (analyzed.length === 0) {
    const pending = firstRunSubject(input.files, input.memory);
    if (pending && pending.status !== "uploading") {
      const job = analyzeJobFor(input.jobs, pending.id);
      if (pending.status === "failed") return { kind: "failed", file: pending, job };
      if (pending.status === "analyzing") return { kind: "analyzing", file: pending, job };
      if (pending.status === "queued") return { kind: "queued", file: pending, job };
    }
    if (live.length > 0) {
      const failed = live.find((u) => u.state === "failed");
      return { kind: "uploading", upload: failed ?? (live[0] as UploadLike), others: live.length - 1 };
    }
    if (pending) return { kind: "queued", file: pending, job: analyzeJobFor(input.jobs, pending.id) };
    return { kind: "empty" };
  }

  // Something came back. Teach on it once, then step aside.
  const graduated = input.memory.dismissedAt !== null || (input.memory.firstReadyAt !== null && isNewSession(input.memory, now));
  const subject = firstRunSubject(input.files, input.memory);
  if (!graduated && subject && subject.status === "ready" && subject.report !== null) {
    return { kind: "ready", file: subject };
  }

  const summary = summarizeCrate(input.files, input.jobs, { since: input.memory.lastSeenAt });
  const newSession = isNewSession(input.memory, now);
  if (newSession || crateLines(summary).length > 0) return { kind: "returning", summary, newSession };
  return { kind: "silent" };
}

/** The record to offer on the way back in, or null when there is nothing obvious. */
export function wayBackIn(files: readonly FileRow[], summary: CrateSummary, memory: OnboardingMemory): FileRow | null {
  const newest = summary.newSince[0] ?? null;
  if (newest) return newest;
  if (memory.lastFileId) {
    const last = files.find((f) => f.id === memory.lastFileId && f.status === "ready");
    if (last) return last;
  }
  return null;
}
