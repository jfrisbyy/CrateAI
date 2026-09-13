"use client";

// A rack row's waveform: the whole file drawn from its stored peaks, with the
// candidate's region marked in amber, its downbeat dashed, and the audition's
// playhead solid while this row is the one sounding. No decode — thirty rows of
// decoded audio would be a gigabyte, and the peaks are already in the row.

import { useId } from "react";
import { markerX, spanBox, wavePath } from "@/lib/audio/peaks";
import type { Peaks } from "@/lib/types/db";

export function PeaksBar({
  peaks,
  durationS,
  startS,
  endS,
  downbeatS,
  playheadS,
  width = 260,
  height = 34,
  label,
}: {
  peaks: Peaks | null;
  durationS: number | null;
  startS: number;
  endS: number;
  downbeatS?: number | null;
  /** where the audition is inside the file, when this row is the one sounding */
  playheadS?: number | null;
  width?: number;
  height?: number;
  label: string;
}) {
  const clipId = useId();
  const { path } = wavePath(peaks, width, height);
  const region = spanBox(startS, endS, durationS, width);
  const down = downbeatS === null || downbeatS === undefined ? null : markerX(downbeatS, durationS, width);
  const head = playheadS === null || playheadS === undefined ? null : markerX(playheadS, durationS, width);
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className="block w-full h-[34px] bg-slate rounded-sm"
    >
      <path d={path} fill="var(--color-chalk-faint)" />
      <g>
        <rect x={region.x} y={0} width={region.width} height={height} fill="rgba(240, 166, 58, 0.16)" />
        <clipPath id={clipId}>
          <rect x={region.x} y={0} width={region.width} height={height} />
        </clipPath>
        {/* the region is drawn in full ink over the dim whole-file shape */}
        <path d={path} fill="var(--color-chalk)" clipPath={`url(#${clipId})`} />
        <line x1={region.x} x2={region.x} y1={0} y2={height} stroke="var(--color-pad)" strokeWidth={1} />
        <line x1={region.x + region.width} x2={region.x + region.width} y1={0} y2={height} stroke="var(--color-pad)" strokeWidth={1} />
      </g>
      {down !== null && <line x1={down} x2={down} y1={0} y2={height} stroke="var(--color-pad)" strokeWidth={1} strokeDasharray="2 2" />}
      {head !== null && <line x1={head} x2={head} y1={0} y2={height} stroke="var(--color-pad)" strokeWidth={1.5} />}
    </svg>
  );
}
