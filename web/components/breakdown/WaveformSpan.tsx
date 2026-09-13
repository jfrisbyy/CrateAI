"use client";

// A highlight over the waveform for the span a fact came from. The waveform
// belongs to components/surface/Waveform.tsx; this portals one non-interactive
// div into its `.waveform` element (positioned in percent of the duration, so
// it needs no resize handling) and removes it on unmount.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

export function WaveformSpan({ start, end, duration }: { start: number; end: number; duration: number }) {
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => {
    setHost(document.querySelector(".waveform"));
  }, []);
  if (!host || !(duration > 0) || end <= start) return null;
  const left = Math.max(0, Math.min(100, (start / duration) * 100));
  const width = Math.max(0.2, Math.min(100 - left, ((end - start) / duration) * 100));
  return createPortal(
    <div
      aria-hidden
      data-breakdown-span
      className="absolute top-0 bottom-0 pointer-events-none"
      style={{
        left: `${left}%`,
        width: `${width}%`,
        background: "rgba(240, 166, 58, 0.14)",
        boxShadow: "inset 1px 0 0 var(--color-pad), inset -1px 0 0 var(--color-pad)",
        zIndex: 5,
      }}
    />,
    host,
  );
}
