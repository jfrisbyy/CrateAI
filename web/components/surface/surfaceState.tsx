"use client";

// Everything the surface's parts share for the open file: the effective
// report and grid, the playback URL, the cursor, the wavesurfer handle, the
// loops with their selection, and the loop player.

import { createContext, useContext, type MutableRefObject } from "react";
import type { LoopPlayer } from "@/lib/audio/loopPlayer";
import type { RenderLoopMeta } from "@/lib/audio/renderLoop";
import type { Grid, SnapMode } from "@/lib/report/grid";
import type { FileRow, JobRow, LoopRow } from "@/lib/types/db";
import type { AnalysisReport } from "@/lib/types/report";

export interface WaveformHandle {
  getTime: () => number;
  setTime: (t: number) => void;
  playPause: () => Promise<void>;
  pause: () => void;
  isPlaying: () => boolean;
  getDuration: () => number;
}

export interface LoopPatch {
  start_s?: number;
  end_s?: number;
  name?: string | null;
  bars?: number | null;
  /** which control the producer used, for the correction the edit logs (principle 7) */
  via?: "edges" | "bars";
}

export type PreviewMode = "raw" | "rendered";

export interface SurfaceState {
  file: FileRow;
  jobs: JobRow[];
  /** effective(report) — every consumer reads this, never the raw one */
  report: AnalysisReport | null;
  grid: Grid;
  duration: number;
  url: string | null;
  urlError: string | null;

  waveRef: MutableRefObject<WaveformHandle | null>;
  cursor: number;
  setCursor: (t: number) => void;
  transportPlaying: boolean;
  setTransportPlaying: (v: boolean) => void;

  loops: LoopRow[];
  loopsLoading: boolean;
  loopsError: string | null;
  selectedLoopId: string | null;
  selectLoop: (id: string | null) => void;
  /** edges while a region is being dragged, before the PATCH lands */
  liveEdges: Record<string, { start: number; end: number }>;
  setLiveEdge: (id: string, edges: { start: number; end: number } | null) => void;

  snapMode: SnapMode;
  setSnapMode: (m: SnapMode) => void;
  zeroCrossing: boolean;
  setZeroCrossing: (v: boolean) => void;
  previewMode: PreviewMode;
  setPreviewMode: (m: PreviewMode) => void;
  crossfadeMs: number;
  setCrossfadeMs: (ms: number) => void;

  /** snap a time with the current snap mode and zero-crossing preference */
  snap: (t: number) => number;

  loopPlayer: LoopPlayer;
  playingLoopId: string | null;
  playLoop: (id: string) => Promise<void>;
  stopLoop: () => void;
  decodeState: "idle" | "decoding" | "ready" | "error";
  decodeError: string | null;
  /** what the last rendered preview did to the edges (null until one plays) */
  renderMeta: RenderLoopMeta | null;

  createLoopAtCursor: () => Promise<void>;
  updateLoop: (id: string, patch: LoopPatch) => Promise<void>;
  deleteLoop: (id: string) => Promise<void>;
  setLoopEdge: (id: string, side: "start" | "end", t: number) => Promise<void>;
  nudgeLoop: (id: string, direction: 1 | -1) => Promise<void>;
  renderLoop: (id: string) => Promise<void>;
  findLoops: () => Promise<void>;
  renderJobFor: (loopId: string) => JobRow | undefined;
  findJob: JobRow | undefined;
  actionError: string | null;
  clearActionError: () => void;
  refetchLoops: () => Promise<void>;
}

export const SurfaceContext = createContext<SurfaceState | null>(null);

export function useSurface(): SurfaceState {
  const ctx = useContext(SurfaceContext);
  if (!ctx) throw new Error("useSurface must be used inside the Surface");
  return ctx;
}
