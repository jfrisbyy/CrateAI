"use client";

// The file's chops: fetched once, refetched when a `chop` job for the file
// finishes; `chop` queues the job; `rename` patches a name in place.

import { useCallback, useEffect, useState } from "react";
import { chopsApi, type ChopRequest, type ChopWithFile } from "@/lib/api/chops";
import { errorMessage } from "@/lib/api/client";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { JobRow } from "@/lib/types/db";
import { useJobDone } from "@/components/stems/useJobDone";

const isChopJob = (job: JobRow) => job.kind === "chop";

export interface ChopsState {
  chops: ChopWithFile[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  chop: (body: ChopRequest) => Promise<void>;
  rename: (chopId: string, name: string | null) => Promise<void>;
  actionError: string | null;
  setActionError: (message: string | null) => void;
}

export function useChops(fileId: string, jobs: JobRow[]): ChopsState {
  const lib = useLibrary();
  const [chops, setChops] = useState<ChopWithFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await chopsApi.list(fileId);
      setChops(res.chops);
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

  useJobDone(jobs, isChopJob, () => void refetch());

  const chop = useCallback(
    async (body: ChopRequest) => {
      setActionError(null);
      try {
        const res = await chopsApi.chop(fileId, body);
        lib.upsertJob(res.job);
        if (res.dispatch && !res.dispatch.ok) setActionError(`Chop queued, but ${res.dispatch.reason}.`);
      } catch (err) {
        setActionError(errorMessage(err));
      }
    },
    [fileId, lib],
  );

  const rename = useCallback(
    async (chopId: string, name: string | null) => {
      const before = chops;
      setChops((prev) => prev.map((c) => (c.id === chopId ? { ...c, name } : c)));
      try {
        const res = await chopsApi.rename(fileId, chopId, { name });
        setChops((prev) => prev.map((c) => (c.id === chopId ? { ...c, ...res.chop } : c)));
      } catch (err) {
        setChops(before);
        setActionError(errorMessage(err));
      }
    },
    [chops, fileId],
  );

  return { chops, loading, error, refetch, chop, rename, actionError, setActionError };
}
