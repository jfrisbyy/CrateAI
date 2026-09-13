"use client";

// Queue an export and watch it. The two choices a producer makes (format and
// bit depth) live here because they change the estimate the panel shows, and
// the estimate has to move as they move.
//
// Watching is a poll rather than a Realtime subscription: this hook has no
// Supabase client of its own and an export is a one-off a producer is sitting
// in front of, so a 1.5 s poll on the job row is honest and cheap. If it ever
// needs to survive a closed tab, the swap is to the `jobs` Realtime channel
// the library already subscribes to.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExportStatus } from "./ExportPanel";
import { exportDownloadHref, exportResultOf, queueExport, readExportJob } from "@/lib/export/client";
import { buildExportRequest, type ArrangementLike, type ExportOptions } from "@/lib/export/song";
import { DEFAULT_EXPORT_BIT_DEPTH, DEFAULT_EXPORT_FORMAT, type ExportBitDepth, type ExportFormat, type ExportJobResult, type ExportSongRequest } from "@/lib/export/types";

export const POLL_MS = 1500;

export interface UseExport {
  request: ExportSongRequest;
  status: ExportStatus;
  progress: number | null;
  error: string | null;
  result: ExportJobResult | null;
  downloadHref: string | null;
  setFormat: (format: ExportFormat) => void;
  setBitDepth: (depth: ExportBitDepth) => void;
  setIncludeMuted: (include: boolean) => void;
  start: () => void;
  reset: () => void;
}

export function useExport(arrangement: ArrangementLike, options: Omit<ExportOptions, "format" | "bitDepth" | "includeMuted"> = {}): UseExport {
  const [format, setFormat] = useState<ExportFormat>(DEFAULT_EXPORT_FORMAT);
  const [bitDepth, setBitDepth] = useState<ExportBitDepth>(DEFAULT_EXPORT_BIT_DEPTH);
  const [includeMuted, setIncludeMuted] = useState(false);
  const [status, setStatus] = useState<ExportStatus>("idle");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ExportJobResult | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const request = useMemo(
    () => buildExportRequest(arrangement, { ...options, format, bitDepth, includeMuted }),
    // The arrangement is a new object on every session change; the builder is
    // pure, so re-deriving it is cheap and always current.
    [arrangement, options, format, bitDepth, includeMuted],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setProgress(null);
    setError(null);
    setResult(null);
    setJobId(null);
  }, []);

  const start = useCallback(() => {
    setStatus("queued");
    setError(null);
    setResult(null);
    setProgress(null);
    queueExport(request)
      .then((response) => {
        if (!alive.current) return;
        setJobId(response.job.id);
        if (response.dispatch && response.dispatch.ok === false) {
          setStatus("failed");
          setError(response.dispatch.reason);
        }
      })
      .catch((err: unknown) => {
        if (!alive.current) return;
        setStatus("failed");
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [request]);

  useEffect(() => {
    if (!jobId || status === "done" || status === "failed") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      readExportJob(jobId)
        .then(({ job }) => {
          if (!alive.current) return;
          setProgress(typeof job.progress === "number" ? job.progress : null);
          if (job.status === "done") {
            setStatus("done");
            setResult(exportResultOf(job));
          } else if (job.status === "failed") {
            setStatus("failed");
            setError(job.error ?? "The export failed.");
          } else {
            setStatus(job.status === "running" ? "running" : "queued");
            timer = setTimeout(tick, POLL_MS);
          }
        })
        .catch((err: unknown) => {
          if (!alive.current) return;
          setStatus("failed");
          setError(err instanceof Error ? err.message : String(err));
        });
    };
    timer = setTimeout(tick, POLL_MS);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [jobId, status]);

  return {
    request,
    status,
    progress,
    error,
    result,
    downloadHref: status === "done" && jobId ? exportDownloadHref(jobId) : null,
    setFormat,
    setBitDepth,
    setIncludeMuted,
    start,
    reset,
  };
}
