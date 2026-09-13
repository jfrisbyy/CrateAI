"use client";

// The breakdown's state for one file: every version from the route, the live
// jobs it depends on (from LibraryProvider), and the two actions: run a new
// version, queue the job a missing entry names. Breakdowns are not in the
// Realtime publication, so the hook refetches when a breakdown job reaches
// done, and re-requests a breakdown (debounced) when a prerequisite the
// document is waiting on finishes, so the document fills in by versions.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { breakdownApi, missingJobRequest, type StemLink } from "@/lib/api/breakdown";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { useLibrary } from "@/lib/state/LibraryProvider";
import { BREAKDOWN_JOB_KINDS, STEM_NAMES } from "@/lib/narration/jobs";
import type { BreakdownContent, BreakdownRow, JobRow } from "@/lib/types/db";
import { isPending } from "./jobStatus";

const RERUN_DEBOUNCE_MS = 1500;

export interface WaitingItem {
  requirement: string;
  job: JobRow | undefined;
}

export interface BreakdownState {
  /** every version, newest first (null until the first fetch lands) */
  rows: BreakdownRow[] | null;
  latest: BreakdownRow | null;
  /** the version on screen: the latest unless one was pinned */
  selected: BreakdownRow | null;
  selectedVersion: number | null;
  selectVersion: (version: number | null) => void;
  loading: boolean;
  error: string | null;
  clearError: () => void;
  stems: StemLink[];
  /** the queued or running breakdown job, if any */
  breakdownJob: JobRow | undefined;
  /** the latest job (any status) that measures what a missing entry names */
  jobFor: (job: string | null | undefined) => JobRow | undefined;
  /** false when the missing entry's job cannot be resolved (a stem that is not there) */
  canQueue: (job: string | null | undefined) => boolean;
  /** what the latest version is still waiting on, with the live job for each */
  waitingOn: WaitingItem[];
  /** true while the latest version has unmeasured sections a job could fill */
  incomplete: boolean;
  run: () => Promise<void>;
  queueMissing: (job: string) => Promise<void>;
  refetch: () => Promise<void>;
}

function stagesOf(job: JobRow): string[] | null {
  if (!job.params || typeof job.params !== "object" || Array.isArray(job.params)) return null;
  const stages = job.params.stages;
  return Array.isArray(stages) ? stages.filter((s): s is string => typeof s === "string") : null;
}

function isIncomplete(content: BreakdownContent | undefined): boolean {
  if (!content) return false;
  if (content.requires.length > 0) return true;
  return content.sections.some((s) => s.missing.some((m) => m.job !== null && m.job !== "identify_context"));
}

/** The loop finder runs as an `analyze` job too (params.task = "find_loops"); it is not analysis. */
function isAnalysis(job: JobRow): boolean {
  if (job.kind !== "analyze") return false;
  if (!job.params || typeof job.params !== "object" || Array.isArray(job.params)) return true;
  return job.params.task !== "find_loops";
}

export function useBreakdown(fileId: string): BreakdownState {
  const lib = useLibrary();
  const [rows, setRows] = useState<BreakdownRow[] | null>(null);
  const [stems, setStems] = useState<StemLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await breakdownApi.get(fileId, { all: true });
      setRows(res.breakdowns);
      setStems(res.stems);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [fileId]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  const latest = rows?.[0] ?? null;
  const selected = useMemo(() => {
    if (!rows || rows.length === 0) return null;
    if (selectedVersion === null) return rows[0] ?? null;
    return rows.find((r) => r.version === selectedVersion) ?? rows[0] ?? null;
  }, [rows, selectedVersion]);

  // The stems' file ids: from the route, plus the library's child files for
  // the moment between a separation landing and the next fetch.
  const stemIds = useMemo(() => {
    const ids = new Set(stems.map((s) => s.stem_file_id));
    for (const f of lib.files) if (f.parent_file_id === fileId && f.kind === "stem") ids.add(f.id);
    return ids;
  }, [stems, lib.files, fileId]);

  const relevantJobs = useMemo(
    () =>
      lib.jobs.filter(
        (j) =>
          (j.file_id === fileId && (BREAKDOWN_JOB_KINDS as readonly string[]).includes(j.kind) && (j.kind !== "analyze" || isAnalysis(j))) ||
          (j.file_id !== null && stemIds.has(j.file_id) && isAnalysis(j)),
      ),
    [lib.jobs, fileId, stemIds],
  );

  const breakdownJob = useMemo(() => relevantJobs.find((j) => j.kind === "breakdown" && isPending(j)), [relevantJobs]);

  const jobFor = useCallback(
    (job: string | null | undefined): JobRow | undefined => {
      if (!job || job === "identify_context") return undefined;
      if (job === "stems") return relevantJobs.find((j) => j.kind === "stems" && j.file_id === fileId);
      if (job === "analyze") return relevantJobs.find((j) => j.kind === "analyze" && j.file_id === fileId && stagesOf(j) === null);
      if (!job.startsWith("analyze:")) return undefined;
      const what = job.slice("analyze:".length);
      if ((STEM_NAMES as readonly string[]).includes(what)) {
        const link = stems.find((s) => s.stem === what);
        if (!link) return undefined;
        return relevantJobs.find((j) => j.kind === "analyze" && j.file_id === link.stem_file_id);
      }
      return relevantJobs.find((j) => {
        if (j.kind !== "analyze" || j.file_id !== fileId) return false;
        const stages = stagesOf(j);
        return stages !== null && (what === "phase4" ? stages.length >= 2 : stages.includes(what));
      });
    },
    [relevantJobs, stems, fileId],
  );

  const canQueue = useCallback((job: string | null | undefined) => missingJobRequest(job, fileId, stems) !== null, [fileId, stems]);

  const incomplete = isIncomplete(latest?.content);
  const waitingOn = useMemo<WaitingItem[]>(
    () => (latest?.content.requires ?? []).map((requirement) => ({ requirement, job: jobFor(requirement) })),
    [latest, jobFor],
  );

  // ---- actions --------------------------------------------------------------
  const awaiting = useRef(new Set<string>());

  const run = useCallback(async () => {
    try {
      const res = await breakdownApi.run(fileId);
      lib.upsertJob(res.job);
      setError(res.dispatch && !res.dispatch.ok ? `Breakdown queued, but ${res.dispatch.reason}.` : null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) return; // already queued: the live job shows it
      setError(errorMessage(err));
    }
  }, [fileId, lib]);

  const queueMissing = useCallback(
    async (job: string) => {
      const request = missingJobRequest(job, fileId, stems);
      if (!request) {
        setError(job.startsWith("analyze:") ? "That stem isn't in the library any more; separate stems again." : "Nothing to queue for that entry.");
        return;
      }
      try {
        const res = await api.jobs.create(request);
        lib.upsertJob(res.job);
        awaiting.current.add(res.job.id);
        setError(res.dispatch && !res.dispatch.ok ? `Queued, but ${res.dispatch.reason}.` : null);
      } catch (err) {
        setError(errorMessage(err));
      }
    },
    [fileId, stems, lib],
  );

  // ---- reacting to jobs ---------------------------------------------------------
  const incompleteRef = useRef(incomplete);
  incompleteRef.current = incomplete;
  const rerunTimer = useRef<number | null>(null);
  const scheduleRerun = useCallback(() => {
    if (rerunTimer.current !== null) window.clearTimeout(rerunTimer.current);
    rerunTimer.current = window.setTimeout(() => {
      rerunTimer.current = null;
      void run();
    }, RERUN_DEBOUNCE_MS);
  }, [run]);
  useEffect(
    () => () => {
      if (rerunTimer.current !== null) window.clearTimeout(rerunTimer.current);
    },
    [],
  );

  const seen = useRef(new Map<string, string>());
  const mountedAt = useRef(Date.now());
  useEffect(() => {
    let refetchNeeded = false;
    let rerunNeeded = false;
    for (const j of relevantJobs) {
      const prev = seen.current.get(j.id);
      if (prev === j.status) continue;
      seen.current.set(j.id, j.status);
      // A job first seen already done counts only when it finished after the tab opened.
      if (prev === undefined && !(j.status === "done" && Date.parse(j.finished_at ?? j.created_at) > mountedAt.current)) continue;
      if (j.status !== "done") continue;
      refetchNeeded = true;
      if (j.kind !== "breakdown" && (awaiting.current.has(j.id) || incompleteRef.current)) rerunNeeded = true;
      awaiting.current.delete(j.id);
    }
    if (refetchNeeded) void refetch();
    if (rerunNeeded) scheduleRerun();
  }, [relevantJobs, refetch, scheduleRerun]);

  return {
    rows,
    latest,
    selected,
    selectedVersion,
    selectVersion: setSelectedVersion,
    loading,
    error,
    clearError: () => setError(null),
    stems,
    breakdownJob,
    jobFor,
    canQueue,
    waitingOn,
    incomplete,
    run,
    queueMissing,
    refetch,
  };
}
