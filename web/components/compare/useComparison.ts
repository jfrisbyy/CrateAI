"use client";

// The comparison state for one file: the picked reference, the latest
// comparison row for the pair (comparisons are not in the Realtime
// publication, so the hook refetches when the pair's `compare` job reaches
// done), and the action that queues one.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, errorMessage } from "@/lib/api/client";
import { compareApi, comparePairOf } from "@/lib/api/compare";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { ComparisonRow, JobRow } from "@/lib/types/db";
import { isPending } from "@/components/breakdown/jobStatus";

export interface ComparisonState {
  referenceId: string | null;
  setReferenceId: (id: string | null) => void;
  comparison: ComparisonRow | null;
  loading: boolean;
  error: string | null;
  clearError: () => void;
  /** the latest compare job for the pair, any status */
  job: JobRow | undefined;
  run: () => Promise<void>;
  retry: () => Promise<void>;
  refetch: () => Promise<void>;
}

export function useComparison(fileId: string): ComparisonState {
  const lib = useLibrary();
  const [referenceId, setReferenceId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<ComparisonRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const restored = useRef(false);

  // First open: restore the last reference this file was compared against.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await compareApi.get(fileId);
        if (cancelled) return;
        if (res.comparison && !restored.current) {
          restored.current = true;
          setReferenceId(res.comparison.file_b_id);
          setComparison(res.comparison);
        }
      } catch (err) {
        if (!cancelled) setError(errorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  const refetch = useCallback(async () => {
    if (!referenceId) {
      setComparison(null);
      return;
    }
    try {
      const res = await compareApi.get(fileId, referenceId);
      setComparison(res.comparison);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [fileId, referenceId]);

  // A different reference: show its latest comparison (or nothing).
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (shownFor.current === referenceId) return;
    shownFor.current = referenceId;
    if (comparison && comparison.file_b_id === referenceId) return; // restored above
    setComparison(null);
    void refetch();
    // `comparison` is intentionally not a dependency: this runs on a reference change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [referenceId, refetch]);

  const job = useMemo(
    () =>
      lib.jobs.find((j) => {
        if (j.kind !== "compare") return false;
        const pair = comparePairOf(j.params);
        return pair !== null && pair.file_a_id === fileId && pair.file_b_id === referenceId;
      }),
    [lib.jobs, fileId, referenceId],
  );

  const seen = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!job) return;
    const prev = seen.current.get(job.id);
    if (prev === job.status) return;
    seen.current.set(job.id, job.status);
    if (prev !== undefined && job.status === "done") void refetch();
  }, [job, refetch]);

  const run = useCallback(async () => {
    if (!referenceId) return;
    try {
      const res = await compareApi.run({ file_a_id: fileId, file_b_id: referenceId });
      lib.upsertJob(res.job);
      setError(res.dispatch && !res.dispatch.ok ? `Comparison queued, but ${res.dispatch.reason}.` : null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && isPending(job)) return;
      setError(errorMessage(err));
    }
  }, [fileId, referenceId, lib, job]);

  const retry = useCallback(async () => {
    if (!job) return;
    try {
      const res = await api.jobs.retry(job.id);
      lib.upsertJob(res.job);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [job, lib]);

  return { referenceId, setReferenceId, comparison, loading, error, clearError: () => setError(null), job, run, retry, refetch };
}
