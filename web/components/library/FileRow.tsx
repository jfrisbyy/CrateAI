"use client";

// One library row: name, duration, BPM and key with confidence dots, status,
// live job progress. Numbers in mono, right-aligned; the row is a rule, not a card.

import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { btnQuiet, cx } from "@/components/ui";
import { api } from "@/lib/api/client";
import { fmtBpm, fmtDuration, fmtPercent } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { effective } from "@/lib/report/effective";
import type { FileRow as FileRowType, JobRow } from "@/lib/types/db";

export function fileTitle(file: FileRowType): string {
  return file.title?.trim() || file.original_filename;
}

export function activeJob(jobs: JobRow[]): JobRow | undefined {
  return jobs.find((j) => j.status === "running") ?? jobs.find((j) => j.status === "queued");
}

export function statusText(file: FileRowType, jobs: JobRow[]): { text: string; failed: boolean; queued: boolean } {
  if (file.status === "failed") {
    const failedJob = jobs.find((j) => j.status === "failed");
    return { text: failedJob?.error ? `failed: ${failedJob.error}` : "analysis failed", failed: true, queued: false };
  }
  if (file.status === "analyzing") {
    const job = activeJob(jobs);
    const progress = job?.progress;
    return { text: progress !== null && progress !== undefined ? `analyzing ${fmtPercent(progress)}` : "analyzing", failed: false, queued: false };
  }
  if (file.status === "queued") {
    const job = activeJob(jobs);
    const note = job?.error?.startsWith("dispatch:") ? job.error.slice("dispatch:".length).trim() : null;
    return { text: note ? `queued (${note})` : "queued", failed: false, queued: true };
  }
  if (file.status === "uploading") return { text: "uploading", failed: false, queued: false };
  return { text: "ready", failed: false, queued: false };
}

export function FileRow({
  file,
  jobs,
  selected,
  onOpen,
}: {
  file: FileRowType;
  jobs: JobRow[];
  selected: boolean;
  onOpen: () => void;
}) {
  const report = file.report ? effective(file.report) : null;
  const tempo = report?.tempo ?? null;
  const key = report?.key ?? null;
  const status = statusText(file, jobs);
  const job = activeJob(jobs);
  const running = job?.status === "running";
  const retryJob = jobs.find((j) => j.status === "failed") ?? (status.queued && job?.error ? job : undefined);

  return (
    <li className={cx("relative border-b border-rule", selected && "bg-slate")}>
      {selected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-pad" aria-hidden />}
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className="w-full text-left px-4 py-1.5 hover:bg-slate focus-visible:bg-slate"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm" title={file.original_filename}>
            {fileTitle(file)}
          </span>
          <span className="font-mono text-xs text-chalk-dim">{fmtDuration(file.duration_s)}</span>
        </div>
        <div className="mt-0.5 grid grid-cols-[1fr_auto_auto] items-baseline gap-x-3 text-xs">
          <span className={cx("truncate", status.failed ? "text-chalk" : "text-chalk-dim")}>{status.text}</span>
          <span className="font-mono flex items-center gap-1 justify-end">
            {tempo ? (
              <>
                <span>{fmtBpm(tempo.bpm)}</span>
                <ConfidenceDot confidence={tempo.confidence} />
              </>
            ) : (
              <span className="text-chalk-faint">—</span>
            )}
          </span>
          <span className="font-mono flex items-center gap-1 justify-end min-w-[64px]">
            {key ? (
              <>
                <span>{displayKey(key.tonic, key.mode)}</span>
                <ConfidenceDot confidence={key.confidence} />
              </>
            ) : (
              <span className="text-chalk-faint">—</span>
            )}
          </span>
        </div>
      </button>
      {retryJob && (status.failed || status.queued) && (
        <div className="px-4 pb-1.5 -mt-0.5 flex justify-end">
          <button
            type="button"
            className={btnQuiet}
            onClick={(e) => {
              e.stopPropagation();
              void api.jobs.retry(retryJob.id);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {running && (
        <div className="absolute left-0 right-0 bottom-0 h-px bg-rule" aria-hidden>
          <div
            className="h-px bg-pad transition-[width] duration-300"
            style={{ width: `${Math.round(Math.max(0.03, job?.progress ?? 0.03) * 100)}%` }}
          />
        </div>
      )}
    </li>
  );
}
