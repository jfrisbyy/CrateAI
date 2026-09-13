"use client";

// The curve, which is the whole point.
//
// PRODUCT_DIRECTION: "'This trumpet sounds awful, clean it up' should produce
// a real, visible, editable EQ curve — not a black box, and not a menu the
// user has to learn." So whatever moved the chain — a drag here, a number in a
// row below, a sentence in the chat, a model's proposal — the line drawn here
// is the response of the filters that are actually running, computed with the
// formulas the browser's own BiquadFilterNode uses, at the sample rate that is
// sounding (lib/processing/eq.ts).
//
// Drag a handle and it moves the same band `setBand` moves. There is no second
// path.

import { useCallback, useMemo, useRef } from "react";
import { cx, mono } from "@/components/ui";
import { AXIS_HZ, dbToRatio, formatDb, formatHz, freqToRatio, ratioToDb, ratioToFreq, responseCurve } from "@/lib/processing/eq";
import { BAND_NAMES, type BandId, type EqBand } from "@/lib/processing/types";

const W = 1000;
const H = 300;
/** The dB the display covers either side of flat. Wide enough for a 12 dB move to still look like one. */
export const SPAN_DB = 18;

export interface BandDrag {
  frequency?: number;
  gainDb?: number;
}

export function EqCurve({
  bands,
  sampleRate,
  bypassed,
  selected,
  onSelect,
  onDrag,
  proposed,
}: {
  bands: readonly EqBand[];
  sampleRate: number;
  bypassed: boolean;
  selected: BandId | null;
  onSelect: (id: BandId) => void;
  onDrag: (id: BandId, patch: BandDrag) => void;
  /** bands a proposal has just moved, marked so the producer can see what the AI touched */
  proposed?: ReadonlySet<BandId>;
}) {
  const svgRef = useRef<SVGSVGElement>(null);

  const path = useMemo(() => {
    const curve = responseCurve(bands, { sampleRate, points: 220 });
    return curve
      .map((point, i) => `${i === 0 ? "M" : "L"}${(freqToRatio(point.hz) * W).toFixed(2)} ${(dbToRatio(point.db, SPAN_DB) * H).toFixed(2)}`)
      .join(" ");
  }, [bands, sampleRate]);

  const pointTo = useCallback((clientX: number, clientY: number) => {
    const box = svgRef.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return null;
    const xRatio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    const yRatio = Math.min(1, Math.max(0, (clientY - box.top) / box.height));
    return { hz: ratioToFreq(xRatio), db: ratioToDb(yRatio, SPAN_DB) };
  }, []);

  const active = bands.filter((band) => band.enabled);

  return (
    <div className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className={cx("w-full h-[150px] block touch-none select-none", bypassed && "opacity-40")}
        role="img"
        aria-label={`EQ curve${bypassed ? ", bypassed" : ""}`}
      >
        <rect x={0} y={0} width={W} height={H} className="fill-[color:var(--color-slate)]" />
        {AXIS_HZ.map((hz) => (
          <g key={hz}>
            <line x1={freqToRatio(hz) * W} y1={0} x2={freqToRatio(hz) * W} y2={H} className="stroke-[color:var(--color-rule)]" strokeWidth={1} />
          </g>
        ))}
        {[-12, -6, 6, 12].map((db) => (
          <line key={db} x1={0} y1={dbToRatio(db, SPAN_DB) * H} x2={W} y2={dbToRatio(db, SPAN_DB) * H} className="stroke-[color:var(--color-rule)]" strokeWidth={1} strokeDasharray="4 6" />
        ))}
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} className="stroke-[color:var(--color-rule-strong)]" strokeWidth={1} />

        <path d={path} fill="none" className="stroke-[#f0a63a]" strokeWidth={3} strokeLinejoin="round" vectorEffect="non-scaling-stroke" data-testid="eq-curve" />

        {active.map((band) => {
          const x = freqToRatio(band.frequency) * W;
          const y = dbToRatio(band.kind === "highpass" || band.kind === "lowpass" ? 0 : band.gainDb, SPAN_DB) * H;
          const isSelected = selected === band.id;
          const wasProposed = proposed?.has(band.id) ?? false;
          return (
            <g key={band.id}>
              <line x1={x} y1={0} x2={x} y2={H} className={cx(isSelected ? "stroke-[#f0a63a]" : "stroke-[color:var(--color-rule-strong)]")} strokeWidth={1} />
              <circle
                cx={x}
                cy={y}
                r={isSelected ? 11 : 8}
                className={cx("cursor-grab", wasProposed ? "fill-[#f0a63a]" : "fill-[color:var(--color-slate)]", "stroke-[#f0a63a]")}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  onSelect(band.id);
                }}
                onPointerMove={(e) => {
                  if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
                  const at = pointTo(e.clientX, e.clientY);
                  if (!at) return;
                  const patch: BandDrag = { frequency: at.hz };
                  if (band.kind !== "highpass" && band.kind !== "lowpass") patch.gainDb = at.db;
                  onDrag(band.id, patch);
                }}
                onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
              >
                {/* one text child: React renders a <title> with several of them as empty */}
                <title>{`${BAND_NAMES[band.id]} — ${formatHz(band.frequency)}${band.kind === "highpass" || band.kind === "lowpass" ? "" : ` ${formatDb(band.gainDb)}`}. Drag to move it; the numbers below do the same thing.`}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      {/* the labels sit at the same x the gridlines do, so the eye can find 1 kHz */}
      <div className="relative h-3.5" aria-hidden>
        {AXIS_HZ.filter((hz) => hz === 50 || hz === 200 || hz === 1000 || hz === 5000 || hz === 20000).map((hz) => (
          <span
            key={hz}
            className={cx(mono, "absolute top-0 text-2xs text-chalk-faint -translate-x-1/2 whitespace-nowrap")}
            style={{ left: `${(freqToRatio(hz) * 100).toFixed(2)}%` }}
          >
            {formatHz(hz)}
          </span>
        ))}
      </div>
    </div>
  );
}
