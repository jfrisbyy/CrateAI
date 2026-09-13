"use client";

// The working surface for one file: header strip, waveform, tabs.
// Holds the shared state (surfaceState.tsx) and wires keyboard commands.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api/client";
import { channelsOf, decodeFromUrl } from "@/lib/audio/decode";
import { LoopPlayer } from "@/lib/audio/loopPlayer";
import { renderLoopPreview, type RenderLoopMeta } from "@/lib/audio/renderLoop";
import { onCommand } from "@/lib/keys/commands";
import { effective } from "@/lib/report/effective";
import { barsInRange, barsToSeconds, gridFromReport, nearestZeroCrossing, nudge, snapTime, type SnapMode } from "@/lib/report/grid";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { JobRow, LoopRow } from "@/lib/types/db";
import { HeaderStrip } from "./HeaderStrip";
import { SurfaceTabs } from "./SurfaceTabs";
import { SurfaceContext, type LoopPatch, type PreviewMode, type SurfaceState, type WaveformHandle } from "./surfaceState";
import { Waveform } from "./Waveform";

const URL_REFRESH_MS = 9 * 60 * 1000;

function isFindJob(job: JobRow): boolean {
  return job.kind === "analyze" && typeof job.params === "object" && job.params !== null && !Array.isArray(job.params) && job.params.task === "find_loops";
}

function loopIdOf(job: JobRow): string | null {
  if (job.kind !== "render_loop" || typeof job.params !== "object" || job.params === null || Array.isArray(job.params)) return null;
  const id = job.params.loop_id;
  return typeof id === "string" ? id : null;
}

export function Surface({ fileId }: { fileId: string }) {
  const lib = useLibrary();
  const file = lib.fileById(fileId);

  if (!file) {
    return (
      <div className="flex-1 flex items-start justify-center pt-[14vh] px-6">
        <div className="max-w-[440px]">
          <h1 className="text-lg font-semibold">This file isn&apos;t in your library.</h1>
          <p className="mt-2 text-sm text-chalk-dim">
            It may have been deleted, or the link belongs to another account.{" "}
            <Link href="/" className="text-chalk underline underline-offset-2">
              Back to the library
            </Link>
          </p>
        </div>
      </div>
    );
  }

  return <LoadedSurface key={file.id} fileId={file.id} />;
}

function LoadedSurface({ fileId }: { fileId: string }) {
  const lib = useLibrary();
  const file = lib.fileById(fileId)!;
  const jobs = useMemo(() => lib.jobs.filter((j) => j.file_id === fileId), [lib.jobs, fileId]);

  const report = useMemo(() => (file.report ? effective(file.report) : null), [file.report]);
  const grid = useMemo(() => gridFromReport(report), [report]);
  const duration = file.duration_s ?? report?.file.duration_s ?? 0;

  const waveRef = useRef<WaveformHandle | null>(null);
  const loopPlayer = useMemo(() => new LoopPlayer(), []);

  // ---- playback URL --------------------------------------------------------
  const [url, setUrl] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.files.url(fileId);
        if (!cancelled) {
          setUrl(res.url);
          setUrlError(null);
        }
      } catch (err) {
        if (!cancelled) setUrlError(errorMessage(err));
      }
    };
    void load();
    // A fresh URL recreates the player, so never swap it mid-playback:
    // when the 9-minute mark lands during play, try again shortly after.
    let timer = window.setTimeout(function tick() {
      if (waveRef.current?.isPlaying() || loopPlayer.isPlaying) {
        timer = window.setTimeout(tick, 30_000);
        return;
      }
      void load();
      timer = window.setTimeout(tick, URL_REFRESH_MS);
    }, URL_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileId, loopPlayer]);

  // ---- transport -----------------------------------------------------------
  const [cursor, setCursor] = useState(0);
  const [transportPlaying, setTransportPlaying] = useState(false);

  // ---- loops ---------------------------------------------------------------
  const [loops, setLoops] = useState<LoopRow[]>([]);
  const [loopsLoading, setLoopsLoading] = useState(true);
  const [loopsError, setLoopsError] = useState<string | null>(null);
  const [selectedLoopId, setSelectedLoopId] = useState<string | null>(null);
  const [liveEdges, setLiveEdges] = useState<Record<string, { start: number; end: number }>>({});
  const [actionError, setActionError] = useState<string | null>(null);

  const refetchLoops = useCallback(async () => {
    try {
      const res = await api.loops.list(fileId);
      setLoops(res.loops);
      setLoopsError(null);
    } catch (err) {
      setLoopsError(errorMessage(err));
    } finally {
      setLoopsLoading(false);
    }
  }, [fileId]);

  useEffect(() => {
    void refetchLoops();
  }, [refetchLoops]);

  // Loops are not in the Realtime publication; refetch when a job for this
  // file finishes (the finder writes loops rows, the renderer sets render_file_id).
  const seenStatus = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    let changed = false;
    for (const j of jobs) {
      const prev = seenStatus.current.get(j.id);
      if (prev !== j.status) {
        seenStatus.current.set(j.id, j.status);
        if (prev !== undefined && j.status === "done" && (isFindJob(j) || j.kind === "render_loop")) changed = true;
      }
    }
    if (changed) void refetchLoops();
  }, [jobs, refetchLoops]);

  const setLiveEdge = useCallback((id: string, edges: { start: number; end: number } | null) => {
    setLiveEdges((prev) => {
      if (edges === null) {
        if (!(id in prev)) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: edges };
    });
  }, []);

  // ---- snap settings ---------------------------------------------------------
  const [snapMode, setSnapMode] = useState<SnapMode>("beat");
  const [zeroCrossing, setZeroCrossing] = useState(true);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("raw");
  const [crossfadeMs, setCrossfadeMs] = useState(12);

  // ---- decoded audio + loop player -------------------------------------------
  const bufferRef = useRef<AudioBuffer | null>(null);
  const [decodeState, setDecodeState] = useState<SurfaceState["decodeState"]>("idle");
  const [decodeError, setDecodeError] = useState<string | null>(null);
  const [playingLoopId, setPlayingLoopId] = useState<string | null>(null);
  const [renderMeta, setRenderMeta] = useState<RenderLoopMeta | null>(null);

  useEffect(() => {
    return loopPlayer.onChange(() => {
      if (!loopPlayer.isPlaying) setPlayingLoopId(null);
    });
  }, [loopPlayer]);

  useEffect(() => () => loopPlayer.stop(), [loopPlayer]);

  const ensureDecoded = useCallback(async (): Promise<AudioBuffer> => {
    if (bufferRef.current) return bufferRef.current;
    if (!url) throw new Error("No playback URL yet.");
    setDecodeState("decoding");
    try {
      const buffer = await decodeFromUrl(fileId, url);
      bufferRef.current = buffer;
      setDecodeState("ready");
      setDecodeError(null);
      return buffer;
    } catch (err) {
      setDecodeState("error");
      setDecodeError(errorMessage(err));
      throw err;
    }
  }, [fileId, url]);

  const snap = useCallback(
    (t: number): number => {
      let s = snapTime(t, snapMode, grid);
      if (zeroCrossing && bufferRef.current) {
        s = nearestZeroCrossing(bufferRef.current.getChannelData(0), bufferRef.current.sampleRate, s);
      }
      return Math.max(0, Math.min(s, duration || s));
    },
    [snapMode, grid, zeroCrossing, duration],
  );

  const stopLoop = useCallback(() => {
    loopPlayer.stop();
    setPlayingLoopId(null);
  }, [loopPlayer]);

  const playLoop = useCallback(
    async (id: string) => {
      const loop = loops.find((l) => l.id === id);
      if (!loop) return;
      try {
        const buffer = await ensureDecoded();
        waveRef.current?.pause();
        if (previewMode === "raw") {
          loopPlayer.playRaw(buffer, loop.start_s, loop.end_s);
        } else {
          const rendered = renderLoopPreview(channelsOf(buffer), buffer.sampleRate, loop.start_s, loop.end_s, {
            crossfadeMs,
            snapZeroCrossing: zeroCrossing,
          });
          loopPlayer.playRendered(rendered.channels, buffer.sampleRate, rendered.startS);
          setRenderMeta(rendered.meta);
        }
        setPlayingLoopId(id);
        setSelectedLoopId(id);
      } catch (err) {
        setActionError(errorMessage(err));
      }
    },
    [loops, ensureDecoded, previewMode, loopPlayer, crossfadeMs, zeroCrossing],
  );

  // ---- loop actions ----------------------------------------------------------
  const updateLoop = useCallback(
    async (id: string, patch: LoopPatch) => {
      const before = loops;
      setLoops((prev) => prev.map((l) => (l.id === id ? { ...l, ...stripUndefined(patch) } : l)));
      try {
        const res = await api.loops.update(id, patch);
        setLoops((prev) => prev.map((l) => (l.id === id ? res.loop : l)));
        if (playingLoopId === id && (patch.start_s !== undefined || patch.end_s !== undefined)) {
          const buffer = bufferRef.current;
          if (buffer) {
            if (previewMode === "raw") loopPlayer.playRaw(buffer, res.loop.start_s, res.loop.end_s);
            else {
              const rendered = renderLoopPreview(channelsOf(buffer), buffer.sampleRate, res.loop.start_s, res.loop.end_s, {
                crossfadeMs,
                snapZeroCrossing: zeroCrossing,
              });
              loopPlayer.playRendered(rendered.channels, buffer.sampleRate, rendered.startS);
              setRenderMeta(rendered.meta);
            }
          }
        }
      } catch (err) {
        setLoops(before);
        setActionError(errorMessage(err));
      }
    },
    [loops, playingLoopId, previewMode, loopPlayer, crossfadeMs, zeroCrossing],
  );

  const createLoopAtCursor = useCallback(async () => {
    const start = snap(waveRef.current?.getTime() ?? cursor);
    const len = barsToSeconds(start, 4, grid) ?? Math.min(2, Math.max(0.5, duration - start));
    const end = Math.min(duration || start + len, start + len);
    if (end <= start + 0.02) {
      setActionError("The cursor is too close to the end of the file for a loop.");
      return;
    }
    try {
      const res = await api.loops.create({ file_id: fileId, start_s: start, end_s: end, bars: barsInRange(start, end, grid) });
      setLoops((prev) => [res.loop, ...prev]);
      setSelectedLoopId(res.loop.id);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }, [snap, cursor, grid, duration, fileId]);

  const deleteLoop = useCallback(
    async (id: string) => {
      if (playingLoopId === id) stopLoop();
      const before = loops;
      setLoops((prev) => prev.filter((l) => l.id !== id));
      if (selectedLoopId === id) setSelectedLoopId(null);
      try {
        await api.loops.remove(id);
      } catch (err) {
        setLoops(before);
        setActionError(errorMessage(err));
      }
    },
    [loops, playingLoopId, selectedLoopId, stopLoop],
  );

  const setLoopEdge = useCallback(
    async (id: string, side: "start" | "end", t: number) => {
      const loop = loops.find((l) => l.id === id);
      if (!loop) return;
      const snapped = snap(t);
      const start = side === "start" ? snapped : loop.start_s;
      const end = side === "end" ? snapped : loop.end_s;
      if (end <= start) {
        setActionError(side === "start" ? "The start must come before the end." : "The end must come after the start.");
        return;
      }
      await updateLoop(id, { start_s: start, end_s: end, bars: barsInRange(start, end, grid) });
    },
    [loops, snap, updateLoop, grid],
  );

  const nudgeLoop = useCallback(
    async (id: string, direction: 1 | -1) => {
      const loop = loops.find((l) => l.id === id);
      if (!loop) return;
      const start = nudge(loop.start_s, direction, grid);
      const delta = start - loop.start_s;
      const end = Math.min(duration || loop.end_s + delta, loop.end_s + delta);
      if (end <= start) return;
      await updateLoop(id, { start_s: start, end_s: end });
    },
    [loops, grid, duration, updateLoop],
  );

  const renderLoop = useCallback(
    async (id: string) => {
      try {
        const res = await api.loops.render(id);
        lib.upsertJob(res.job);
        if (res.dispatch && !res.dispatch.ok) setActionError(`Export queued, but ${res.dispatch.reason}.`);
      } catch (err) {
        setActionError(errorMessage(err));
      }
    },
    [lib],
  );

  const findLoops = useCallback(async () => {
    try {
      const res = await api.loops.find({ file_id: fileId });
      lib.upsertJob(res.job);
      if (res.dispatch && !res.dispatch.ok) setActionError(`Loop finder queued, but ${res.dispatch.reason}.`);
    } catch (err) {
      setActionError(errorMessage(err));
    }
  }, [fileId, lib]);

  const renderJobFor = useCallback(
    (loopId: string) => jobs.find((j) => loopIdOf(j) === loopId && (j.status === "queued" || j.status === "running" || j.status === "failed")),
    [jobs],
  );
  const findJob = useMemo(() => jobs.find((j) => isFindJob(j) && j.status !== "done") ?? jobs.find(isFindJob), [jobs]);

  // ---- keyboard commands -------------------------------------------------------
  useEffect(() => {
    return onCommand((command) => {
      const t = waveRef.current?.getTime() ?? cursor;
      switch (command) {
        case "play-pause":
          if (loopPlayer.isPlaying) stopLoop();
          else void waveRef.current?.playPause();
          break;
        case "loop-start":
          if (selectedLoopId) void setLoopEdge(selectedLoopId, "start", t);
          break;
        case "loop-end":
          if (selectedLoopId) void setLoopEdge(selectedLoopId, "end", t);
          break;
        case "new-loop":
          void createLoopAtCursor();
          break;
        case "nudge-left":
          if (selectedLoopId) void nudgeLoop(selectedLoopId, -1);
          break;
        case "nudge-right":
          if (selectedLoopId) void nudgeLoop(selectedLoopId, 1);
          break;
        case "set-downbeat":
          window.dispatchEvent(new CustomEvent("crateai:set-downbeat", { detail: t }));
          break;
        default:
          break;
      }
    });
  }, [cursor, loopPlayer, stopLoop, selectedLoopId, setLoopEdge, createLoopAtCursor, nudgeLoop]);

  const value: SurfaceState = {
    file,
    jobs,
    report,
    grid,
    duration,
    url,
    urlError,
    waveRef,
    cursor,
    setCursor,
    transportPlaying,
    setTransportPlaying,
    loops,
    loopsLoading,
    loopsError,
    selectedLoopId,
    selectLoop: setSelectedLoopId,
    liveEdges,
    setLiveEdge,
    snapMode,
    setSnapMode,
    zeroCrossing,
    setZeroCrossing,
    previewMode,
    setPreviewMode,
    crossfadeMs,
    setCrossfadeMs,
    snap,
    loopPlayer,
    playingLoopId,
    playLoop,
    stopLoop,
    decodeState,
    decodeError,
    renderMeta,
    createLoopAtCursor,
    updateLoop,
    deleteLoop,
    setLoopEdge,
    nudgeLoop,
    renderLoop,
    findLoops,
    renderJobFor,
    findJob,
    actionError,
    clearActionError: () => setActionError(null),
    refetchLoops,
  };

  return (
    <SurfaceContext.Provider value={value}>
      <div className="flex-1 min-h-0 flex flex-col">
        <HeaderStrip />
        <Waveform />
        <SurfaceTabs />
      </div>
    </SurfaceContext.Provider>
  );
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
