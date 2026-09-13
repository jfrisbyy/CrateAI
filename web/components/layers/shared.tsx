"use client";

// Small pieces the Layers, Re-voice and Beatbox surfaces share: the job status
// line, a hook that fires when a matching job reaches done (jobs are live in
// LibraryProvider; the rows they write are not, so lists refetch on done),
// and play / open / download for a library file by id. Candidates for
// components/ui once the lead wants them there.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { btnQuiet, cx } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import type { JobRow } from "@/lib/types/db";

export function jobText(job: JobRow | undefined | null): string | null {
  if (!job) return null;
  if (job.status === "queued") {
    const note = job.error?.startsWith("dispatch:") ? job.error.slice("dispatch:".length).trim() : null;
    return note ? `queued (${note})` : "queued";
  }
  if (job.status === "running") return job.progress !== null ? `running ${Math.round(job.progress * 100)}%` : "running";
  if (job.status === "failed") return `failed: ${job.error ?? "unknown error"}`;
  return "done";
}

export function isActive(job: JobRow | undefined | null): boolean {
  return job?.status === "queued" || job?.status === "running";
}

/**
 * Calls `onDone` when a job matched by `match` transitions to done while this
 * component is mounted (a job first seen as done does not fire: the initial
 * fetch already covers it). `match` should be stable (useCallback).
 */
export function useJobDone(jobs: JobRow[], match: (job: JobRow) => boolean, onDone: (job: JobRow) => void): void {
  const seen = useRef<Map<string, string>>(new Map());
  const callback = useRef(onDone);
  callback.current = onDone;
  useEffect(() => {
    for (const j of jobs) {
      if (!match(j)) continue;
      const prev = seen.current.get(j.id);
      if (prev === j.status) continue;
      seen.current.set(j.id, j.status);
      if (prev !== undefined && j.status === "done") callback.current(j);
    }
  }, [jobs, match]);
}

/** A running job's progress as a hairline under a row (amber = happening now). */
export function ProgressLine({ job }: { job: JobRow | undefined | null }) {
  if (job?.status !== "running") return null;
  return (
    <div className="absolute left-0 right-0 bottom-0 h-px bg-rule" aria-hidden>
      <div className="h-px bg-pad transition-[width] duration-300" style={{ width: `${Math.round(Math.max(0.03, job.progress ?? 0.03) * 100)}%` }} />
    </div>
  );
}

// ---- playback of a library file by id -------------------------------------------

let current: { stop: () => void } | null = null;

export function PlayButton({ fileId, disabled, title }: { fileId: string | null; disabled?: boolean; title?: string }) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const stop = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    setState("idle");
  }, []);

  useEffect(() => stop, [stop]);

  const play = async () => {
    if (!fileId) return;
    if (state === "playing") {
      stop();
      return;
    }
    setState("loading");
    setError(null);
    try {
      const res = await api.files.url(fileId);
      current?.stop();
      const audio = new Audio(res.url);
      audio.preload = "auto";
      audioRef.current = audio;
      audio.onended = () => {
        if (audioRef.current === audio) stop();
      };
      audio.onerror = () => {
        if (audioRef.current === audio) {
          setError("Could not play the file.");
          stop();
        }
      };
      await audio.play();
      current = { stop };
      setState("playing");
    } catch (err) {
      setError(errorMessage(err));
      stop();
    }
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        className={cx("h-7 w-7 rounded-sm border flex items-center justify-center shrink-0", state === "playing" ? "border-pad text-pad" : "border-rule text-chalk hover:border-rule-strong disabled:opacity-40")}
        onClick={() => void play()}
        disabled={disabled || !fileId || state === "loading"}
        aria-label={state === "playing" ? "Stop" : "Play"}
        title={title ?? (state === "playing" ? "Stop" : "Play")}
      >
        <span aria-hidden className="font-mono text-xs">
          {state === "playing" ? "■" : state === "loading" ? "…" : "▶"}
        </span>
      </button>
      {error && <span className="text-xs">{error}</span>}
    </span>
  );
}

export function OpenButton({ fileId, children = "Open" }: { fileId: string; children?: React.ReactNode }) {
  const router = useRouter();
  return (
    <button type="button" className={btnQuiet} onClick={() => router.push(`/f/${fileId}`)} title="Open on the surface">
      {children}
    </button>
  );
}

export function DownloadButton({ fileId, children = "Download" }: { fileId: string; children?: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.files.url(fileId);
      window.open(res.url, "_blank", "noopener");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button type="button" className={btnQuiet} disabled={busy} onClick={() => void download()} title="Signed link, 10 minutes">
        {children}
      </button>
      {error && <span className="text-xs">{error}</span>}
    </>
  );
}

/** Retry a failed job (POST /api/jobs/[id]/retry). */
export function RetryButton({ job, onRetried }: { job: JobRow; onRetried?: (job: JobRow) => void }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <button
        type="button"
        className={btnQuiet}
        onClick={() =>
          void api.jobs
            .retry(job.id)
            .then((res) => onRetried?.(res.job))
            .catch((err) => setError(errorMessage(err)))
        }
      >
        Retry
      </button>
      {error && <span className="text-xs">{error}</span>}
    </>
  );
}
