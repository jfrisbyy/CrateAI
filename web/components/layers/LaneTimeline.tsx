"use client";

// One lane's block on the layer timeline: positioned by its offset (bars at
// the target tempo behind it), draggable with snap to bar / beat / 16th /
// free, keyboard-nudgeable, with the file's stored peaks drawn inside and the
// part before the layer's zero dimmed (the renderer crops it).

import { useMemo, useRef, useState } from "react";
import { cx } from "@/components/ui";
import { formatBarsBeats, formatRulerBeat, formatSignedSeconds, snapSeconds, stepSeconds, type GridSnap } from "@/lib/pianoroll/time";
import type { Peaks } from "@/lib/types/db";

export const LANE_HEIGHT = 44;
export const RULER_HEIGHT = 18;

export interface TimelineScale {
  /** the leftmost second shown (<= 0) */
  t0: number;
  /** pixels per second */
  pxPerSec: number;
  bpm: number;
  beatsPerBar: number;
}

export function barGridStyle(scale: TimelineScale): React.CSSProperties {
  const beatPx = (60 / scale.bpm) * scale.pxPerSec;
  const barPx = beatPx * scale.beatsPerBar;
  const originPx = -scale.t0 * scale.pxPerSec;
  const layers = [`repeating-linear-gradient(to right, var(--color-rule-strong) 0 1px, transparent 1px ${Math.max(2, barPx)}px)`];
  if (beatPx >= 10) layers.push(`repeating-linear-gradient(to right, var(--color-rule) 0 1px, transparent 1px ${Math.max(2, beatPx)}px)`);
  return { backgroundImage: layers.join(", "), backgroundPositionX: `${originPx}px, ${originPx}px` };
}

export function Ruler({ scale, width }: { scale: TimelineScale; width: number }) {
  const beat = 60 / scale.bpm;
  const bar = beat * scale.beatsPerBar;
  const barPx = bar * scale.pxPerSec;
  const every = barPx >= 34 ? 1 : barPx >= 17 ? 2 : barPx >= 9 ? 4 : 8;
  const labels: Array<{ x: number; text: string }> = [];
  if (width > 0 && Number.isFinite(barPx) && barPx > 0) {
    const firstBar = Math.floor(scale.t0 / bar);
    const lastBar = Math.ceil((scale.t0 + width / scale.pxPerSec) / bar);
    for (let b = firstBar; b <= lastBar; b++) {
      if (b % every !== 0) continue;
      const x = (b * bar - scale.t0) * scale.pxPerSec;
      if (x < 0 || x > width) continue;
      labels.push({ x, text: b < 0 ? String(b) : formatRulerBeat(b * scale.beatsPerBar, scale.beatsPerBar) });
    }
  }
  return (
    <div className="relative border-b border-rule text-2xs text-chalk-dim font-mono select-none" style={{ height: RULER_HEIGHT, ...barGridStyle(scale) }} aria-hidden>
      {labels.map((l) => (
        <span key={l.text + l.x} className="absolute top-0.5 pl-1" style={{ left: l.x }}>
          {l.text}
        </span>
      ))}
    </div>
  );
}

function PeaksShape({ peaks, muted }: { peaks: Peaks; muted: boolean }) {
  const d = useMemo(() => {
    const n = Math.min(peaks.points, peaks.max.length, peaks.min.length);
    if (n < 2) return "";
    const parts: string[] = [`M0 ${-(peaks.max[0] ?? 0)}`];
    for (let i = 1; i < n; i++) parts.push(`L${i} ${-(peaks.max[i] ?? 0)}`);
    for (let i = n - 1; i >= 0; i--) parts.push(`L${i} ${-(peaks.min[i] ?? 0)}`);
    parts.push("Z");
    return parts.join("");
  }, [peaks]);
  if (!d) return null;
  const n = Math.min(peaks.points, peaks.max.length, peaks.min.length);
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 -1 ${n} 2`} preserveAspectRatio="none" aria-hidden>
      <path d={d} fill={muted ? "var(--color-chalk-faint)" : "var(--color-chalk-dim)"} fillOpacity={muted ? 0.5 : 0.85} />
    </svg>
  );
}

export function LaneTimeline({
  name,
  offsetS,
  durationS,
  scale,
  snap,
  peaks,
  muted,
  disabled,
  onCommit,
}: {
  name: string;
  offsetS: number;
  durationS: number;
  scale: TimelineScale;
  snap: GridSnap;
  peaks: Peaks | null;
  muted: boolean;
  disabled?: boolean;
  onCommit: (offsetS: number) => void;
}) {
  const [live, setLive] = useState<number | null>(null);
  const drag = useRef<{ startX: number; orig: number } | null>(null);
  const shown = live ?? offsetS;
  const left = (shown - scale.t0) * scale.pxPerSec;
  const width = Math.max(3, durationS * scale.pxPerSec);
  const cropped = shown < 0 ? Math.min(width, -shown * scale.pxPerSec) : 0;
  const zeroX = -scale.t0 * scale.pxPerSec;

  const target = (clientX: number) => {
    const d = drag.current;
    if (!d) return offsetS;
    return snapSeconds(d.orig + (clientX - d.startX) / scale.pxPerSec, scale.bpm, snap, scale.beatsPerBar);
  };

  const nudge = (direction: 1 | -1, big: boolean) => {
    const step = big ? (60 / scale.bpm) * scale.beatsPerBar : (stepSeconds(scale.bpm, snap, scale.beatsPerBar) ?? 0.01);
    onCommit(Math.round((offsetS + direction * step) * 1e6) / 1e6);
  };

  return (
    <div className="relative" style={{ height: LANE_HEIGHT, ...barGridStyle(scale) }}>
      <div className="absolute top-0 bottom-0 w-px bg-pad-dim" style={{ left: zeroX }} aria-hidden title="Layer zero: the first downbeat of the target" />
      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={`${name} offset`}
        aria-valuenow={Math.round(shown * 1000) / 1000}
        aria-valuetext={`${formatBarsBeats(shown, scale.bpm, scale.beatsPerBar)} (${formatSignedSeconds(shown)})`}
        aria-disabled={disabled}
        className={cx(
          "absolute top-1 bottom-1 rounded-sm border overflow-hidden select-none touch-none",
          live !== null ? "border-pad" : "border-rule-strong",
          disabled ? "cursor-default" : "cursor-grab active:cursor-grabbing",
          muted ? "bg-graphite" : "bg-slate",
        )}
        style={{ left, width }}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { startX: e.clientX, orig: offsetS };
          setLive(offsetS);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setLive(target(e.clientX));
        }}
        onPointerUp={(e) => {
          if (!drag.current) return;
          const next = target(e.clientX);
          drag.current = null;
          setLive(null);
          if (Math.abs(next - offsetS) > 1e-6) onCommit(next);
        }}
        onPointerCancel={() => {
          drag.current = null;
          setLive(null);
        }}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            nudge(-1, e.shiftKey);
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            nudge(1, e.shiftKey);
          } else if (e.key === "Home") {
            e.preventDefault();
            onCommit(0);
          }
        }}
        title={`Drag to move (${snap}); arrows nudge, Shift for a bar, Home for zero`}
      >
        {peaks && <PeaksShape peaks={peaks} muted={muted} />}
        {cropped > 0 && <div className="absolute left-0 top-0 bottom-0 bg-graphite/70" style={{ width: cropped }} aria-hidden title="Before the layer's zero: cropped in the render" />}
        <span className="absolute left-1 top-0.5 text-2xs text-chalk-dim truncate max-w-[calc(100%-8px)] pointer-events-none">{name}</span>
      </div>
    </div>
  );
}
