"use client";

// The file's stems: fetched once, refetched when a `stems` job for the file
// finishes; `separate` queues the job and merges it into the library store.

import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@/lib/api/client";
import { stemsApi, type SeparateRequest, type StemWithFile } from "@/lib/api/stems";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { JobRow } from "@/lib/types/db";
import { useJobDone } from "./useJobDone";

const isStemsJob = (job: JobRow) => job.kind === "stems";

export interface StemsState {
  stems: StemWithFile[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  separate: (req?: SeparateRequest) => Promise<void>;
  actionError: string | null;
  clearActionError: () => void;
}

export function useStems(fileId: string, jobs: JobRow[]): StemsState {
  const lib = useLibrary();
  const [stems, setStems] = useState<StemWithFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await stemsApi.list(fileId);
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

  useJobDone(jobs, isStemsJob, () => void refetch());

  const separate = useCallback(
    async (req: SeparateRequest = {}) => {
      setActionError(null);
      try {
        const res = await stemsApi.separate(fileId, req);
        lib.upsertJob(res.job);
        if (res.dispatch && !res.dispatch.ok) setActionError(`Separation queued, but ${res.dispatch.reason}.`);
      } catch (err) {
        setActionError(errorMessage(err));
      }
    },
    [fileId, lib],
  );

  return { stems, loading, error, refetch, separate, actionError, clearActionError: () => setActionError(null) };
}
