"use client";

// The waveform: wavesurfer.js v7 fed from the stored peaks (no decode) and a
// signed URL for playback; a canvas overlay draws the effective beat grid,
// downbeats, section boundaries and the loop playhead; the Regions plugin
// carries the loops as draggable, resizable regions.

import { useCallback, useEffect, useRef, useState } from "react";
import type WaveSurfer from "wavesurfer.js";
import type RegionsPlugin from "wavesurfer.js/dist/plugins/regions.js";
import type { Region } from "wavesurfer.js/dist/plugins/regions.js";
import { barsInRange } from "@/lib/report/grid";
import { hedgeWord } from "@/lib/report/hedge";
import type { LoopRow } from "@/lib/types/db";
import type { AnalysisReport } from "@/lib/types/report";
import { useSurface } from "./surfaceState";

const HEIGHT = 168;
const REGION_COLOR = "rgba(240, 166, 58, 0.16)";
const REGION_COLOR_SELECTED = "rgba(240, 166, 58, 0.34)";

export function Waveform() {
  const s = useSurface();
  const { file, url, urlError, report, duration, loops, selectedLoopId, playingLoopId, loopPlayer } = s;
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const draggingRef = useRef<string | null>(null);
  const lastTimeRef = useRef(0);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Latest values for event handlers created once.
  const latest = useRef({ s });
  latest.current = { s };

  // ---- create wavesurfer -----------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !url) return;
    let disposed = false;
    let ws: WaveSurfer | null = null;

    (async () => {
      const [{ default: WaveSurferCtor }, { default: RegionsCtor }] = await Promise.all([
        import("wavesurfer.js"),
        import("wavesurfer.js/dist/plugins/regions.js"),
      ]);
      if (disposed) return;
      const regions = RegionsCtor.create();
      const peaks = file.peaks ? [file.peaks.max, file.peaks.min] : undefined;
      ws = WaveSurferCtor.create({
        container,
        height: HEIGHT,
        waveColor: "#9b988f",
        progressColor: "#e6e3dc",
        cursorColor: "#f0a63a",
        cursorWidth: 1,
        normalize: false,
        interact: true,
        dragToSeek: false,
        hideScrollbar: true,
        fillParent: true,
        minPxPerSec: 1,
        url,
        peaks,
        duration: peaks && duration > 0 ? duration : undefined,
        plugins: [regions],
      });
      wsRef.current = ws;
      regionsRef.current = regions;

      const st = () => latest.current.s;
      ws.on("ready", () => {
        setReady(true);
        setLoadError(null);
        // after a URL refresh the player is rebuilt; put the cursor back
        if (lastTimeRef.current > 0) ws?.setTime(lastTimeRef.current);
      });
      ws.on("error", (err) => setLoadError(err instanceof Error ? err.message : String(err)));
      ws.on("timeupdate", (t) => {
        lastTimeRef.current = t;
        st().setCursor(t);
      });
      ws.on("interaction", (t) => {
        lastTimeRef.current = t;
        st().setCursor(t);
      });
      ws.on("play", () => st().setTransportPlaying(true));
      ws.on("pause", () => st().setTransportPlaying(false));
      ws.on("finish", () => st().setTransportPlaying(false));

      regions.on("region-update", (region: Region) => {
        draggingRef.current = region.id;
        st().setLiveEdge(region.id, { start: region.start, end: region.end });
      });
      regions.on("region-updated", (region: Region, side?: "start" | "end") => {
        draggingRef.current = null;
        const state = st();
        state.setLiveEdge(region.id, null);
        const loop = state.loops.find((l) => l.id === region.id);
        if (!loop) return;
        let start = region.start;
        let end = region.end;
        if (side === "start") start = state.snap(start);
        else if (side === "end") end = state.snap(end);
        else {
          // a drag moved both edges: snap the start, keep the length
          const length = end - start;
          start = state.snap(start);
          end = start + length;
        }
        if (end <= start + 0.01) {
          region.setOptions({ start: loop.start_s, end: loop.end_s });
          return;
        }
        if (Math.abs(start - region.start) > 1e-6 || Math.abs(end - region.end) > 1e-6) region.setOptions({ start, end });
        void state.updateLoop(region.id, { start_s: start, end_s: end, bars: barsInRange(start, end, state.grid) });
      });
      regions.on("region-clicked", (region: Region, e: MouseEvent) => {
        e.stopPropagation();
        st().selectLoop(region.id);
      });

      st().waveRef.current = {
        getTime: () => ws?.getCurrentTime() ?? 0,
        setTime: (t) => ws?.setTime(t),
        playPause: async () => {
          await ws?.playPause();
        },
        pause: () => ws?.pause(),
        isPlaying: () => ws?.isPlaying() ?? false,
        getDuration: () => ws?.getDuration() ?? 0,
      };
    })().catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));

    return () => {
      disposed = true;
      setReady(false);
      latest.current.s.waveRef.current = null;
      regionsRef.current = null;
      wsRef.current = null;
      ws?.destroy();
    };
    // The URL refreshes every 9 minutes; recreating on that is acceptable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, file.id, file.peaks]);

  // ---- sync regions with loops -----------------------------------------------
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions || !ready) return;
    const existing = new Map(regions.getRegions().map((r) => [r.id, r]));
    const wanted = new Set(loops.map((l) => l.id));
    for (const [id, region] of existing) if (!wanted.has(id)) region.remove();
    for (const loop of loops) {
      const color = loop.id === selectedLoopId ? REGION_COLOR_SELECTED : REGION_COLOR;
      const content = loopLabel(loop);
      const region = existing.get(loop.id);
      if (!region) {
        regions.addRegion({ id: loop.id, start: loop.start_s, end: loop.end_s, drag: true, resize: true, color, content, minLength: 0.02 });
      } else if (draggingRef.current !== loop.id) {
        const changes: Parameters<Region["setOptions"]>[0] = {};
        if (Math.abs(region.start - loop.start_s) > 1e-6) changes.start = loop.start_s;
        if (Math.abs(region.end - loop.end_s) > 1e-6) changes.end = loop.end_s;
        if (region.color !== color) changes.color = color;
        if ((region.content?.textContent ?? "") !== content) changes.content = content;
        if (Object.keys(changes).length > 0) region.setOptions(changes);
      }
    }
  }, [loops, selectedLoopId, ready]);

  // ---- overlay: grid, sections, loop playhead ----------------------------------
  const draw = useCallback(
    (playhead: number | null) => {
      const canvas = canvasRef.current;
      const container = containerRef.current;
      if (!canvas || !container) return;
      const width = container.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(HEIGHT * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(HEIGHT * dpr);
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, HEIGHT);
      const total = duration || wsRef.current?.getDuration() || 0;
      if (total <= 0) return;
      const x = (t: number) => Math.round((t / total) * width) + 0.5;
      drawGrid(ctx, report, x, width);
      if (playhead !== null) {
        ctx.strokeStyle = "#f0a63a";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x(playhead), 0);
        ctx.lineTo(x(playhead), HEIGHT);
        ctx.stroke();
      }
    },
    [report, duration],
  );

  useEffect(() => {
    draw(null);
    const container = containerRef.current;
    if (!container) return;
    const ro = new ResizeObserver(() => draw(loopPlayer.position()));
    ro.observe(container);
    return () => ro.disconnect();
  }, [draw, loopPlayer, ready]);

  useEffect(() => {
    if (!playingLoopId) {
      draw(null);
      return;
    }
    let raf = 0;
    const tick = () => {
      draw(loopPlayer.position());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playingLoopId, loopPlayer, draw]);

  return (
    <div className="shrink-0 border-b border-rule bg-slate">
      <div className="relative waveform" style={{ height: HEIGHT }}>
        <div ref={containerRef} className="absolute inset-0" />
        <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none" style={{ width: "100%", height: HEIGHT }} aria-hidden />
        {!url && !urlError && <Note>Fetching a playback link.</Note>}
        {urlError && <Note>Could not get a playback link: {urlError}</Note>}
        {url && !ready && !loadError && <Note>{file.peaks ? "Drawing the waveform." : "No peaks stored yet; decoding the audio to draw it."}</Note>}
        {loadError && <Note>Could not load the audio: {loadError}</Note>}
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="absolute left-4 top-3 text-xs text-chalk-dim pointer-events-none" role="status">
      {children}
    </p>
  );
}

function loopLabel(loop: LoopRow): string {
  const name = loop.name?.trim() || (loop.origin === "finder" ? "found" : loop.origin === "chat" ? "chat" : "loop");
  return loop.bars ? `${name} · ${loop.bars} bar${loop.bars === 1 ? "" : "s"}` : name;
}

function drawGrid(ctx: CanvasRenderingContext2D, report: AnalysisReport | null, x: (t: number) => number, width: number) {
  if (!report) return;
  const beats = report.beats;
  if (beats) {
    const downbeats = new Set(beats.downbeats_s);
    const dense = beats.times_s.length > width / 3;
    ctx.lineWidth = 1;
    // beats: short ticks from the bottom
    ctx.strokeStyle = "rgba(230, 227, 220, 0.22)";
    ctx.beginPath();
    for (const t of beats.times_s) {
      if (downbeats.has(t)) continue;
      if (dense && Math.round(t * 1000) % 2 !== 0) continue;
      const px = x(t);
      ctx.moveTo(px, HEIGHT - 18);
      ctx.lineTo(px, HEIGHT);
    }
    ctx.stroke();
    // downbeats: full height, stronger
    ctx.strokeStyle = "rgba(230, 227, 220, 0.42)";
    ctx.beginPath();
    for (const t of beats.downbeats_s) {
      const px = x(t);
      ctx.moveTo(px, 0);
      ctx.lineTo(px, HEIGHT);
    }
    ctx.stroke();
  }
  const structure = report.structure;
  if (structure) {
    ctx.font = "10px var(--font-public-sans), system-ui, sans-serif";
    ctx.textBaseline = "top";
    for (const section of structure.sections) {
      const px = x(section.start_s);
      ctx.strokeStyle = "rgba(230, 227, 220, 0.6)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, 0);
      ctx.lineTo(px, HEIGHT);
      ctx.stroke();
      ctx.setLineDash([]);
      const hedge = hedgeWord(section.confidence);
      const text = hedge ? `${section.label} (${hedge})` : section.label;
      const w = ctx.measureText(text).width + 8;
      ctx.fillStyle = "rgba(27, 27, 30, 0.85)";
      ctx.fillRect(px + 2, 2, w, 14);
      ctx.fillStyle = "#e6e3dc";
      ctx.fillText(text, px + 6, 4);
    }
  }
}
