// One line for a job row, the way the Loops tab and the library word it.

import type { JobRow } from "@/lib/types/db";

export function jobStatusText(job: JobRow | undefined | null): string | null {
  if (!job) return null;
  if (job.status === "queued") {
    const note = job.error?.startsWith("dispatch:") ? job.error.slice("dispatch:".length).trim() : null;
    return note ? `queued (${note})` : "queued";
  }
  if (job.status === "running") return job.progress !== null ? `running ${Math.round(job.progress * 100)}%` : "running";
  if (job.status === "failed") return `failed: ${job.error ?? "unknown error"}`;
  return "done";
}

export function isInFlight(job: JobRow | undefined | null): boolean {
  return job?.status === "queued" || job?.status === "running";
}

export function paramOf(job: JobRow, key: string): unknown {
  if (typeof job.params !== "object" || job.params === null || Array.isArray(job.params)) return undefined;
  return job.params[key];
}

/** The job to show for a kind: one in flight, else the most recent failed one (jobs come newest first). */
export function jobToShow(jobs: JobRow[], kind: JobRow["kind"]): JobRow | undefined {
  const ofKind = jobs.filter((j) => j.kind === kind);
  return ofKind.find(isInFlight) ?? (ofKind[0]?.status === "failed" ? ofKind[0] : undefined);
}
