"use client";

// A lane's head: what it is, where it came from, and the three controls a
// producer reaches for while deciding — mute, solo, level — plus the two the
// timeline adds, restacking and taking it out.
//
// Mute, solo and level move gain nodes and stop nothing (lib/session/mix.ts),
// which is why they are here rather than behind a menu: they are the fastest
// question a producer can ask of an arrangement.

import { memo } from "react";
import { btnQuiet, cx, mono } from "@/components/ui";
import { dbFromGain, gainFromDb } from "@/lib/session/mix";
import type { SessionTrack } from "@/lib/session/types";

export const LANE_HEADER_WIDTH = 178;

export const LaneHeader = memo(function LaneHeader({
  track,
  audible,
  waiting,
  regionCount,
  onMute,
  onSolo,
  onGain,
  onRemove,
  onMoveUp,
  onMoveDown,
  canMoveUp,
  canMoveDown,
}: {
  track: SessionTrack;
  audible: boolean;
  waiting: boolean;
  regionCount: number;
  onMute: (trackId: string, muted: boolean) => void;
  onSolo: (trackId: string, soloed: boolean) => void;
  onGain: (trackId: string, gain: number) => void;
  onRemove: (trackId: string) => void;
  onMoveUp: (trackId: string) => void;
  onMoveDown: (trackId: string) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
}) {
  const db = Math.round(dbFromGain(track.gain));
  return (
    <div className="h-full px-2 py-1 flex flex-col justify-between min-w-0">
      <div className="flex items-baseline gap-1.5 min-w-0">
        <span className={cx("text-xs truncate", audible ? "text-chalk" : "text-chalk-dim")} title={track.provenance ?? track.name}>
          {track.name}
        </span>
        {waiting && <span className="text-2xs text-chalk-dim shrink-0">decoding</span>}
        <span className={cx(mono, "ml-auto text-2xs text-chalk-faint shrink-0")} title={`${regionCount} region${regionCount === 1 ? "" : "s"} on this lane`}>
          {regionCount}
        </span>
      </div>

      <div className="flex items-center gap-1">
        <button
          type="button"
          className={cx("h-5 px-1 rounded-sm border text-2xs", track.muted ? "border-pad text-pad" : "border-rule text-chalk-dim hover:text-chalk")}
          aria-pressed={track.muted}
          onClick={() => onMute(track.id, !track.muted)}
          title="Mute; the audio keeps running, so unmuting lands on the beat"
        >
          M
        </button>
        <button
          type="button"
          className={cx("h-5 px-1 rounded-sm border text-2xs", track.soloed ? "border-pad text-pad" : "border-rule text-chalk-dim hover:text-chalk")}
          aria-pressed={track.soloed}
          onClick={() => onSolo(track.id, !track.soloed)}
          title="Solo this lane against the rest of the song"
        >
          S
        </button>
        <input
          type="range"
          min={-24}
          max={6}
          step={1}
          value={db}
          onChange={(e) => onGain(track.id, gainFromDb(Number(e.target.value)))}
          className="w-[52px] accent-[#f0a63a]"
          aria-label={`${track.name} level in decibels`}
          title={`${db > 0 ? `+${db}` : db} dB`}
        />
        <span className="ml-auto flex items-center">
          <button type="button" className={cx(btnQuiet, "px-0.5")} onClick={() => onMoveUp(track.id)} disabled={!canMoveUp} aria-label={`Move ${track.name} up`} title="Restack">
            <span aria-hidden>↑</span>
          </button>
          <button type="button" className={cx(btnQuiet, "px-0.5")} onClick={() => onMoveDown(track.id)} disabled={!canMoveDown} aria-label={`Move ${track.name} down`} title="Restack">
            <span aria-hidden>↓</span>
          </button>
          <button type="button" className={cx(btnQuiet, "px-0.5")} onClick={() => onRemove(track.id)} aria-label={`Take ${track.name} out of the song`} title="Take this lane out; undo brings it back">
            <span aria-hidden>×</span>
          </button>
        </span>
      </div>
    </div>
  );
});
