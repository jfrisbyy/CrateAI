"use client";

// Stems, chops and midi rows are not in the Realtime publication; jobs are.
// Fire `onDone` when a matching job for the file transitions to `done`
// (the same watch the surface keeps for loops).

import { useEffect, useRef } from "react";
import type { JobRow } from "@/lib/types/db";

export function useJobDone(jobs: JobRow[], matches: (job: JobRow) => boolean, onDone: () => void): void {
  const seen = useRef<Map<string, string>>(new Map());
  const callback = useRef(onDone);
  callback.current = onDone;
  useEffect(() => {
    let fire = false;
    for (const j of jobs) {
      const prev = seen.current.get(j.id);
      if (prev === j.status) continue;
      seen.current.set(j.id, j.status);
      if (prev !== undefined && j.status === "done" && matches(j)) fire = true;
    }
    if (fire) callback.current();
  }, [jobs, matches]);
}
