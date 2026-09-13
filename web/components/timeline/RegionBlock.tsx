"use client";

// One region on the timeline: a block you can drag to move and whose edges you
// can drag to trim, with the record's own waveform drawn inside it and the
// line that says what it actually is underneath.
//
// The block decides nothing. Where a drag lands, what a trim is allowed to
// reveal and what the region then claims to be are all worked out in
// lib/session (arrangement.ts, snap.ts, lineage.ts) and asserted in node; this
// file turns a pointer into an event and a region into a rectangle.
//
// Memoized, and the handlers take the region rather than closing over it, so a
// song with four hundred regions re-renders exactly the one being dragged.

import { memo, type PointerEvent as ReactPointerEvent } from "react";
import { cx } from "@/components/ui";
import { wavePath } from "@/lib/audio/peaks";
import { describeLineage, sourceBars } from "@/lib/session/lineage";
import { handleWidthPx, MIN_GRABBABLE_PX } from "@/lib/session/viewport";
import type { SessionRegion } from "@/lib/session/types";
import type { Peaks } from "@/lib/types/db";
import type { DragKind } from "@/lib/session/arrangement";

export const LANE_HEIGHT = 58;

export interface RegionBlockProps {
  region: SessionRegion;
  /** left edge in pixels from the start of the lane strip */
  x: number;
  widthPx: number;
  selected: boolean;
  /** the lane it is being dragged over, when that is not its own */
  ghosted: boolean;
  /** this region's source has not decoded yet */
  waiting: boolean;
  peaks: Peaks | null;
  /** the whole source's length, so the peaks can be cut to the region's span */
  sourceDurationS: number | null;
  onGrab: (region: SessionRegion, kind: DragKind, event: ReactPointerEvent<HTMLElement>) => void;
  onSelect: (region: SessionRegion) => void;
}

export const RegionBlock = memo(function RegionBlock({ region, x, widthPx, selected, ghosted, waiting, peaks, sourceDurationS, onGrab, onSelect }: RegionBlockProps) {
  const width = Math.max(2, widthPx);
  const handle = handleWidthPx(width);
  const grabbable = width >= MIN_GRABBABLE_PX;
  const bars = sourceBars(region, region.lineage);
  const title = describeLineage(region, region.lineage);

  return (
    <div
      className={cx(
        "absolute top-[3px] bottom-[3px] rounded-sm border overflow-hidden select-none touch-none",
        selected ? "border-pad bg-pad/15" : "border-rule-strong bg-slate hover:border-rule-strong",
        ghosted && "opacity-60",
      )}
      style={{ left: x, width }}
      data-region={region.id}
      data-selected={selected}
      title={title}
    >
      {/* The body: grabbing anywhere but the edges moves the region. */}
      <button
        type="button"
        className="absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing text-left"
        style={{ paddingLeft: handle, paddingRight: handle }}
        onPointerDown={(e) => {
          onSelect(region);
          if (e.button === 0) onGrab(region, "move", e);
        }}
        aria-label={`${title}. Drag to move; the arrow keys nudge it by one grid step.`}
      >
        <RegionWave peaks={peaks} region={region} sourceDurationS={sourceDurationS} muted={waiting} />
        <span className="relative block px-1 pt-0.5 text-2xs font-mono text-chalk-dim truncate pointer-events-none">
          {waiting ? "decoding" : bars ? `bars ${bars.fromBar}–${bars.toBar}` : region.lineage?.fileName ?? "region"}
        </span>
        {region.lineage && (
          <span className="relative block px-1 text-2xs text-chalk-faint truncate pointer-events-none">
            {region.lineage.fileName}
            {region.lineage.stem ? ` · ${region.lineage.stem}` : ""}
          </span>
        )}
      </button>

      {/* The edges. Trimming the head and trimming the tail are different
          edits — the head moves the audio's start with it, the tail does not —
          so they are two controls, not one. */}
      {grabbable && (
        <>
          <span
            role="separator"
            aria-orientation="vertical"
            aria-label="Trim the start: moves where the region begins and which second of the record it begins at"
            className="absolute left-0 top-0 bottom-0 cursor-ew-resize bg-pad/0 hover:bg-pad/50"
            style={{ width: handle }}
            onPointerDown={(e) => {
              onSelect(region);
              if (e.button === 0) onGrab(region, "trim-head", e);
            }}
          />
          <span
            role="separator"
            aria-orientation="vertical"
            aria-label="Trim the end: changes only how long the region sounds"
            className="absolute right-0 top-0 bottom-0 cursor-ew-resize bg-pad/0 hover:bg-pad/50"
            style={{ width: handle }}
            onPointerDown={(e) => {
              onSelect(region);
              if (e.button === 0) onGrab(region, "trim-tail", e);
            }}
          />
        </>
      )}
    </div>
  );
});

/**
 * The record's stored peaks, cut to the seconds this region is actually
 * sounding. No decode: a timeline of thirty regions would be a gigabyte of
 * PCM, and `files.peaks` is already in the library row.
 */
function RegionWave({ peaks, region, sourceDurationS, muted }: { peaks: Peaks | null; region: SessionRegion; sourceDurationS: number | null; muted: boolean }) {
  if (!peaks || !sourceDurationS || sourceDurationS <= 0) return null;
  const rate = region.rate && region.rate > 0 ? region.rate : 1;
  const from = region.offsetS / sourceDurationS;
  const to = (region.offsetS + region.durationS * rate) / sourceDurationS;
  const points = Math.min(peaks.min.length, peaks.max.length);
  const start = Math.max(0, Math.min(points, Math.floor(from * points)));
  const end = Math.max(start + 1, Math.min(points, Math.ceil(to * points)));
  const slice: Peaks = { ...peaks, points: end - start, min: peaks.min.slice(start, end), max: peaks.max.slice(start, end) };
  const { path } = wavePath(slice, 100, 30, 120);
  return (
    <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden>
      <path d={path} fill={muted ? "var(--color-chalk-faint)" : "var(--color-chalk-dim)"} fillOpacity={0.7} />
    </svg>
  );
}
