// One-line status for a job row, the way the library and the Loops tab say it.

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

export function isPending(job: JobRow | undefined | null): boolean {
  return job?.status === "queued" || job?.status === "running";
}
