"use client";

// The three chop modes with their controls. Bars read 1-based here and go
// to compute 0-based. Manual markers are placed at the surface cursor.

import { useState } from "react";
import { jobStatusText } from "@/components/stems/jobStatus";
import { btn, btnPrimary, btnQuiet, cx, input, label, segment, segmentItem } from "@/components/ui";
import { api } from "@/lib/api/client";
import { CHOP_DEFAULTS, CHOP_LIMITS, CHOP_MODES, type ChopMode, type ChopRequest } from "@/lib/api/chops";
import { fmtClock } from "@/lib/format";
import type { JobRow } from "@/lib/types/db";

const numberField = cx(input, "font-mono w-[64px] h-6 text-right");

export function ChopControls({
  cursor,
  hasGrid,
  canChop,
  job,
  onChop,
}: {
  cursor: number;
  hasGrid: boolean;
  canChop: boolean;
  /** the in-flight or last failed chop job */
  job: JobRow | undefined;
  onChop: (body: ChopRequest) => void;
}) {
  const [mode, setMode] = useState<ChopMode>("transients");
  const [count, setCount] = useState<number>(CHOP_DEFAULTS.count);
  const [minGap, setMinGap] = useState<number>(CHOP_DEFAULTS.min_gap_ms);
  const [startBar, setStartBar] = useState(1);
  const [endBar, setEndBar] = useState<number>(CHOP_DEFAULTS.bars);
  const [divisions, setDivisions] = useState<number>(CHOP_DEFAULTS.divisions);
  const [markers, setMarkers] = useState<number[]>([]);
  const inFlight = job?.status === "queued" || job?.status === "running";
  const description = CHOP_MODES.find((m) => m.id === mode)?.describe ?? "";

  const request = (): ChopRequest | null => {
    if (mode === "transients") return { mode, count, min_gap_ms: minGap };
    if (mode === "grid") {
      if (!hasGrid) return null;
      const a = Math.max(1, Math.min(startBar, endBar));
      const b = Math.max(startBar, endBar);
      return { mode, start_bar: a - 1, end_bar: b - 1, divisions };
    }
    if (markers.length === 0) return null;
    return { mode, markers_s: markers };
  };
  const body = request();

  const addMarker = () => {
    const t = Math.round(cursor * 1000) / 1000;
    setMarkers((prev) => (prev.some((m) => Math.abs(m - t) < 0.001) ? prev : [...prev, t].sort((x, y) => x - y)).slice(0, CHOP_LIMITS.markers));
  };

  return (
    <div className="px-4 py-2 border-b border-rule">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className={label}>Mode</span>
          <div className={segment} role="group" aria-label="Chop mode">
            {CHOP_MODES.map((m) => (
              <button key={m.id} type="button" data-active={mode === m.id} onClick={() => setMode(m.id)} className={segmentItem}>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {mode === "transients" && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-chalk-dim">
              count
              <input type="number" min={1} max={CHOP_LIMITS.count} value={count} onChange={(e) => setCount(clampInt(e.target.value, 1, CHOP_LIMITS.count, CHOP_DEFAULTS.count))} className={numberField} aria-label="Chop count" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-chalk-dim">
              min gap
              <input type="number" min={5} max={CHOP_LIMITS.min_gap_ms} value={minGap} onChange={(e) => setMinGap(clampInt(e.target.value, 5, CHOP_LIMITS.min_gap_ms, CHOP_DEFAULTS.min_gap_ms))} className={numberField} aria-label="Minimum gap in milliseconds" />
              ms
            </label>
          </>
        )}

        {mode === "grid" && (
          <>
            <label className="flex items-center gap-1.5 text-xs text-chalk-dim">
              bars
              <input type="number" min={1} max={4096} value={startBar} onChange={(e) => setStartBar(clampInt(e.target.value, 1, 4096, 1))} className={numberField} aria-label="Start bar" />
              to
              <input type="number" min={1} max={4096} value={endBar} onChange={(e) => setEndBar(clampInt(e.target.value, 1, 4096, CHOP_DEFAULTS.bars))} className={numberField} aria-label="End bar" />
            </label>
            <label className="flex items-center gap-1.5 text-xs text-chalk-dim">
              per bar
              <input type="number" min={1} max={CHOP_LIMITS.divisions} value={divisions} onChange={(e) => setDivisions(clampInt(e.target.value, 1, CHOP_LIMITS.divisions, CHOP_DEFAULTS.divisions))} className={numberField} aria-label="Divisions per bar" />
            </label>
          </>
        )}

        {mode === "manual" && (
          <button type="button" className={btn} onClick={addMarker} title="Place a marker where the playhead is">
            Add marker at <span className="font-mono">{fmtClock(cursor)}</span>
          </button>
        )}

        <button type="button" className={btnPrimary} disabled={!canChop || inFlight || body === null} onClick={() => body && onChop(body)} title={hasGrid || mode !== "grid" ? "Cut the file into chops; replaces the current set" : "Grid chops need the beat grid; analyze the file first"}>
          Chop
        </button>
        {job && (
          <span className="text-xs text-chalk-dim flex items-center gap-2">
            chop {jobStatusText(job)}
            {job.status === "failed" && (
              <button type="button" className={btnQuiet} onClick={() => void api.jobs.retry(job.id)}>
                Retry
              </button>
            )}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-xs text-chalk-dim max-w-[640px]">
        {description}
        {mode === "grid" && !hasGrid && " Needs the beat grid; analyze the file first."}
        {mode === "manual" && markers.length === 0 && " Move the playhead and add markers; the last chop runs to the end of the file."}
      </p>
      {mode === "manual" && markers.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Markers">
          {markers.map((m) => (
            <li key={m} className="inline-flex items-center gap-1 border border-rule rounded-sm pl-2 h-6 font-mono text-xs">
              {fmtClock(m)}
              <button type="button" className={btnQuiet} onClick={() => setMarkers((prev) => prev.filter((x) => x !== m))} aria-label={`Remove marker at ${fmtClock(m)}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function clampInt(raw: string, lo: number, hi: number, fallback: number): number {
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}
