"use client";

// What the selected region actually is, and the numbers behind it.
//
// This is the part a normal DAW does not have. A block of audio in Ableton is
// a filename; here it is bars 9 to 16 of a named record, separated a
// particular way, resampled by a particular ratio, and every one of those
// claims has the measurement behind it in its title. Trim the region and the
// bars change, because the bars are derived from what is sounding rather than
// stored from when it arrived (lib/session/lineage.ts).
//
// The numbers are editable, because principle 4 says an output you cannot
// correct is not done — and because "move it to bar 17" has to be reachable
// with a keyboard as well as with a sentence and a drag.

import { btn, btnQuiet, cx, mono } from "@/components/ui";
import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { fmtClock } from "@/lib/format";
import { lineageParts, soundingSpan } from "@/lib/session/lineage";
import { dbFromGain, gainFromDb } from "@/lib/session/mix";
import { secondsPerBar, type SessionTempo } from "@/lib/session/time";
import type { SessionRegion } from "@/lib/session/types";

export function RegionInspector({
  region,
  laneName,
  tempo,
  onMoveToBar,
  onLengthBars,
  onGain,
  onDuplicate,
  onSplit,
  onDelete,
  onLoopRegion,
}: {
  region: SessionRegion | null;
  laneName: string | null;
  tempo: SessionTempo | null;
  onMoveToBar: (bar: number) => void;
  onLengthBars: (bars: number) => void;
  onGain: (gain: number) => void;
  onDuplicate: () => void;
  onSplit: () => void;
  onDelete: () => void;
  onLoopRegion: () => void;
}) {
  if (!region) {
    return (
      <div className="px-3 py-2 text-xs text-chalk-dim border-t border-rule">
        Click a region to see what it is: which record, which of its bars, what was done to it. Drag it to move, drag an edge to trim.
      </div>
    );
  }

  const parts = lineageParts(region, region.lineage);
  const span = soundingSpan(region);
  const barS = tempo ? secondsPerBar(tempo) : 0;
  const startBar = barS > 0 ? region.startS / barS + 1 : null;
  const lengthBars = barS > 0 ? region.durationS / barS : null;
  const db = Math.round(dbFromGain(region.gain));

  return (
    <div className="border-t border-rule px-3 py-2 flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
        {laneName && <span className="text-xs text-chalk-dim shrink-0">{laneName}</span>}
        {parts.map((part, i) => (
          <span key={`${part.label}:${i}`} className={cx(mono, "text-xs text-chalk")} title={part.detail}>
            {part.label}
          </span>
        ))}
        {region.lineage?.reason && (
          <span className="text-xs text-chalk-dim flex items-baseline gap-1" title={region.lineage.confidence === null ? "not measured" : `confidence ${region.lineage.confidence.toFixed(2)}`}>
            {region.lineage.reason}
            <ConfidenceDot confidence={region.lineage.confidence ?? null} />
          </span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <label className="flex items-center gap-1 text-xs text-chalk-dim" title="Where the region starts in the song. The same control a drag moves.">
          at bar
          <input
            type="number"
            min={1}
            step={1}
            value={startBar === null ? "" : Math.round(startBar * 100) / 100}
            disabled={startBar === null}
            onChange={(e) => onMoveToBar(Number(e.target.value))}
            className={cx(mono, "w-[62px] h-6 px-1 rounded-sm bg-slate border border-rule text-xs text-chalk disabled:opacity-40")}
            aria-label="Start bar"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-chalk-dim" title="How long it sounds. The same control the right edge drags.">
          length
          <input
            type="number"
            min={0}
            step={1}
            value={lengthBars === null ? "" : Math.round(lengthBars * 100) / 100}
            disabled={lengthBars === null}
            onChange={(e) => onLengthBars(Number(e.target.value))}
            className={cx(mono, "w-[62px] h-6 px-1 rounded-sm bg-slate border border-rule text-xs text-chalk disabled:opacity-40")}
            aria-label="Length in bars"
          />
          bars
        </label>
        <label className="flex items-center gap-1 text-xs text-chalk-dim" title="This region's own trim, on top of the lane's fader">
          level
          <input
            type="range"
            min={-24}
            max={6}
            step={1}
            value={db}
            onChange={(e) => onGain(gainFromDb(Number(e.target.value)))}
            className="w-[72px] accent-[#f0a63a]"
            aria-label="Region level in decibels"
          />
          <span className={cx(mono, "text-2xs text-chalk-faint w-[34px]")}>{db > 0 ? `+${db}` : db} dB</span>
        </label>
        <span className={cx(mono, "text-2xs text-chalk-faint")} title="The seconds of the record this region is playing right now">
          {fmtClock(span.startS, 0)}–{fmtClock(span.endS, 0)} of the record
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <button type="button" className={btn} onClick={onDuplicate} title="Copy it after itself, lineage and all: four bars become eight">
          Duplicate
        </button>
        <button type="button" className={btn} onClick={onSplit} title="Cut it in two at the playhead; both halves keep the lineage and the join is continuous">
          Split at playhead
        </button>
        <button type="button" className={btn} onClick={onLoopRegion} title="Set the locators to this region and loop it">
          Loop it
        </button>
        <button type="button" className={btnQuiet} onClick={onDelete} title="Take this region out; undo brings it back">
          Delete
        </button>
      </div>
    </div>
  );
}
