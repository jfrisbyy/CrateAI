"use client";

// The bar ruler, and the two things a producer does on it: move the playhead,
// and set the locators.
//
// Where the lines go is `rulerTicks` in lib/session/snap.ts — bars always,
// beats and sixteenths only when they are far enough apart to be seen, and
// seconds instead of bars when the session has no measured tempo, because
// drawing bars we have not measured would be the one thing this product does
// not do.

import { memo } from "react";
import { cx, mono } from "@/components/ui";
import { rulerTicks, type Tick } from "@/lib/session/snap";
import type { SessionTempo } from "@/lib/session/time";
import type { TransportLoop } from "@/lib/session/types";

export const RULER_HEIGHT = 22;
/** The top half sets the locators; the bottom half moves the playhead. */
export const LOCATOR_BAND = 8;

export const TimelineRuler = memo(function TimelineRuler({
  fromS,
  toS,
  tempo,
  minSpacingS,
  pxPerSecond,
  widthPx,
  loop,
}: {
  fromS: number;
  toS: number;
  tempo: SessionTempo | null;
  minSpacingS: number;
  pxPerSecond: number;
  widthPx: number;
  loop: TransportLoop | null;
}) {
  const ticks = rulerTicks(fromS, toS, tempo, minSpacingS);
  return (
    <div className="relative h-full" style={{ width: widthPx }} aria-hidden>
      {loop && (
        <div
          className="absolute top-0 bg-pad/25 border-l border-r border-pad"
          style={{ left: loop.startS * pxPerSecond, width: Math.max(1, (loop.endS - loop.startS) * pxPerSecond), height: LOCATOR_BAND }}
        />
      )}
      {ticks.map((tick) => (
        <RulerTick key={`${tick.kind}:${tick.atS.toFixed(5)}`} tick={tick} x={tick.atS * pxPerSecond} />
      ))}
    </div>
  );
});

function RulerTick({ tick, x }: { tick: Tick; x: number }) {
  const strong = tick.kind === "bar" || tick.kind === "second";
  return (
    <>
      <span className={cx("absolute bottom-0", strong ? "bg-rule-strong" : "bg-rule")} style={{ left: x, width: 1, height: strong ? 9 : 4 }} />
      {tick.label !== null && (
        <span className={cx(mono, "absolute top-[7px] pl-1 text-2xs text-chalk-dim select-none")} style={{ left: x }}>
          {tick.label}
        </span>
      )}
    </>
  );
}

/**
 * The grid behind the lanes, as two repeating gradients rather than a line per
 * division. At full zoom over a four-minute song that is the difference
 * between two background layers and forty thousand elements, and it is the
 * reason scrolling stays smooth.
 */
export function laneGridStyle(pxPerSecond: number, tempo: SessionTempo | null): React.CSSProperties {
  if (!tempo || !(tempo.bpm > 0) || !(tempo.beatsPerBar > 0)) return {};
  const beatPx = (60 / tempo.bpm) * pxPerSecond;
  const barPx = beatPx * tempo.beatsPerBar;
  if (!(barPx > 1)) return {};
  const layers = [`repeating-linear-gradient(to right, var(--color-rule-strong) 0 1px, transparent 1px ${barPx}px)`];
  if (beatPx >= 12) layers.push(`repeating-linear-gradient(to right, var(--color-rule) 0 1px, transparent 1px ${beatPx}px)`);
  return { backgroundImage: layers.join(", ") };
}
