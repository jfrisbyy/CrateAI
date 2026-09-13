"use client";

// The library store: files and jobs for the signed-in user, kept live by
// Supabase Realtime (postgres_changes on files and jobs filtered by user_id),
// plus the upload queue. Reconnects and refetches when the tab becomes
// visible again; polls while jobs are in flight as insurance.

import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createClient } from "@/lib/supabase/client";
import type { FileRow, JobRow } from "@/lib/types/db";
import { UploadManager, type UploadItem } from "@/lib/upload/uploader";

export interface LibraryState {
  userId: string;
  userEmail: string | null;
  files: FileRow[];
  jobs: JobRow[];
  uploads: UploadItem[];
  uploader: UploadManager;
  realtime: "connecting" | "live" | "offline";
  fileById: (id: string) => FileRow | undefined;
  jobsForFile: (id: string) => JobRow[];
  refresh: () => Promise<void>;
  /** Merge a row we already have in hand (from a route response) before Realtime echoes it. */
  upsertFile: (file: FileRow) => void;
  upsertJob: (job: JobRow) => void;
  removeFile: (id: string) => void;
}

const LibraryContext = createContext<LibraryState | null>(null);

const POLL_MS = 15_000;

function sortFiles(files: FileRow[]): FileRow[] {
  return [...files].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

function sortJobs(jobs: JobRow[]): JobRow[] {
  return [...jobs].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

function upsertInto<T extends { id: string }>(list: T[], row: T): T[] {
  const i = list.findIndex((x) => x.id === row.id);
  if (i < 0) return [row, ...list];
  const next = list.slice();
  next[i] = row;
  return next;
}

export function LibraryProvider({
  userId,
  userEmail,
  initialFiles,
  initialJobs,
  children,
}: {
  userId: string;
  userEmail: string | null;
  initialFiles: FileRow[];
  initialJobs: JobRow[];
  children: ReactNode;
}) {
  const [files, setFiles] = useState<FileRow[]>(() => sortFiles(initialFiles));
  const [jobs, setJobs] = useState<JobRow[]>(() => sortJobs(initialJobs));
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [realtime, setRealtime] = useState<LibraryState["realtime"]>("connecting");
  const uploader = useMemo(() => new UploadManager(), []);
  const channelRef = useRef<RealtimeChannel | null>(null);

  const upsertFile = useCallback((file: FileRow) => setFiles((prev) => sortFiles(upsertInto(prev, file))), []);
  const upsertJob = useCallback((job: JobRow) => setJobs((prev) => sortJobs(upsertInto(prev, job))), []);
  const removeFile = useCallback((id: string) => setFiles((prev) => prev.filter((f) => f.id !== id)), []);

  useEffect(() => {
    uploader.onFileRow = (file, job) => {
      upsertFile(file);
      if (job) upsertJob(job);
    };
    return uploader.subscribe(setUploads);
  }, [uploader, upsertFile, upsertJob]);

  const refresh = useCallback(async () => {
    const supabase = createClient();
    const [filesRes, jobsRes] = await Promise.all([
      supabase.from("files").select("*").order("created_at", { ascending: false }).limit(1000),
      supabase.from("jobs").select("*").order("created_at", { ascending: false }).limit(300),
    ]);
    if (filesRes.data) setFiles(sortFiles(filesRes.data));
    if (jobsRes.data) setJobs(sortJobs(jobsRes.data));
  }, []);

  // Realtime subscription, re-established when the tab comes back.
  useEffect(() => {
    const supabase = createClient();
    let disposed = false;

    const subscribe = async () => {
      if (disposed) return;
      if (channelRef.current) {
        await supabase.removeChannel(channelRef.current);
        channelRef.current = null;
      }
      const { data } = await supabase.auth.getSession();
      if (data.session) supabase.realtime.setAuth(data.session.access_token);
      const channel = supabase
        .channel(`library:${userId}`)
        .on<FileRow>(
          "postgres_changes",
          { event: "*", schema: "public", table: "files", filter: `user_id=eq.${userId}` },
          (payload: RealtimePostgresChangesPayload<FileRow>) => {
            if (payload.eventType === "DELETE") {
              const old = payload.old as Partial<FileRow>;
              if (old.id) removeFile(old.id);
            } else {
              upsertFile(payload.new);
            }
          },
        )
        .on<JobRow>(
          "postgres_changes",
          { event: "*", schema: "public", table: "jobs", filter: `user_id=eq.${userId}` },
          (payload: RealtimePostgresChangesPayload<JobRow>) => {
            if (payload.eventType === "DELETE") {
              const old = payload.old as Partial<JobRow>;
              if (old.id) setJobs((prev) => prev.filter((j) => j.id !== old.id));
            } else {
              upsertJob(payload.new);
            }
          },
        )
        .subscribe((status) => {
          if (status === "SUBSCRIBED") setRealtime("live");
          else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") setRealtime("offline");
        });
      channelRef.current = channel;
    };

    void subscribe();

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
      const state = channelRef.current?.state;
      if (state !== "joined" && state !== "joining") void subscribe();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
      if (channelRef.current) void supabase.removeChannel(channelRef.current);
      channelRef.current = null;
    };
  }, [userId, refresh, upsertFile, upsertJob, removeFile]);

  // Poll while anything is in flight (covers a Realtime channel that never joined).
  const inFlight =
    jobs.some((j) => j.status === "queued" || j.status === "running") ||
    files.some((f) => f.status === "queued" || f.status === "analyzing");
  useEffect(() => {
    if (!inFlight) return;
    const id = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(id);
  }, [inFlight, refresh]);

  const fileById = useCallback((id: string) => files.find((f) => f.id === id), [files]);
  const jobsForFile = useCallback((id: string) => jobs.filter((j) => j.file_id === id), [jobs]);

  const value = useMemo<LibraryState>(
    () => ({ userId, userEmail, files, jobs, uploads, uploader, realtime, fileById, jobsForFile, refresh, upsertFile, upsertJob, removeFile }),
    [userId, userEmail, files, jobs, uploads, uploader, realtime, fileById, jobsForFile, refresh, upsertFile, upsertJob, removeFile],
  );

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryState {
  const ctx = useContext(LibraryContext);
  if (!ctx) throw new Error("useLibrary must be used inside LibraryProvider");
  return ctx;
}
