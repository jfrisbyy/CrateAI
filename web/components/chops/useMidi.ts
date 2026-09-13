"use client";

// The file's MIDI rows with download links: fetched once, refetched when a
// `midi` job for the file finishes; pads recordings are added as they are
// saved (the route returns the row).

import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "@/lib/api/client";
import { midiApi, type MidiExtractKind, type MidiWithUrl } from "@/lib/api/midi";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { JobRow } from "@/lib/types/db";
import { useJobDone } from "@/components/stems/useJobDone";

const isMidiJob = (job: JobRow) => job.kind === "midi";

export interface MidiState {
  midi: MidiWithUrl[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  extract: (kind: MidiExtractKind) => Promise<void>;
  add: (row: MidiWithUrl) => void;
  actionError: string | null;
  setActionError: (message: string | null) => void;
}

export function useMidi(fileId: string, jobs: JobRow[]): MidiState {
  const lib = useLibrary();
  const [midi, setMidi] = useState<MidiWithUrl[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const res = await midiApi.list(fileId);
      setMidi(res.midi);
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

  useJobDone(jobs, isMidiJob, () => void refetch());

  const extract = useCallback(
    async (kind: MidiExtractKind) => {
      setActionError(null);
      try {
        const res = await midiApi.extract(fileId, { kind });
        lib.upsertJob(res.job);
        if (res.dispatch && !res.dispatch.ok) setActionError(`${kind} MIDI queued, but ${res.dispatch.reason}.`);
      } catch (err) {
        setActionError(errorMessage(err));
      }
    },
    [fileId, lib],
  );

  const add = useCallback((row: MidiWithUrl) => setMidi((prev) => [row, ...prev.filter((m) => m.id !== row.id)]), []);

  return { midi, loading, error, refetch, extract, add, actionError, setActionError };
}
