"use client";

// The lanes in the session: what is in it, where each lane came from, and the
// three controls a producer reaches for while deciding — mute, solo, level.
//
// This is not the song timeline (that is Surface 2, and it is a later phase).
// It is the minimum a committed candidate needs so that "commit" means
// something you can then hear against, turn down, and take out again.

import { useSession } from "./SessionProvider";
import { btnQuiet, cx, mono } from "@/components/ui";
import { anySoloed, dbFromGain, gainFromDb } from "@/lib/session/mix";
import { AUDITION_TRACK_ID } from "@/lib/session/rack";

export function SessionPanel() {
  const session = useSession();
  const soloMode = anySoloed(session.tracks);

  if (session.tracks.length === 0) {
    return (
      <div className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">
        <p>Nothing in the session yet. Commit a candidate from a rack and it becomes a lane here, on the same clock as everything else.</p>
        <p className="mt-2">Lanes keep their lineage: which record, which span, which separation, so the breakdown and the corrections still work.</p>
      </div>
    );
  }

  return (
    <ul>
      {session.tracks.map((track) => {
        const audible = track.muted ? false : soloMode ? track.soloed : true;
        const db = Math.round(dbFromGain(track.gain));
        const ephemeral = track.id === AUDITION_TRACK_ID;
        const waiting = session.regions.some((r) => r.trackId === track.id && session.waiting.includes(r.sourceId));
        return (
          <li key={track.id} className={cx("border-b border-rule px-4 py-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 items-start", ephemeral && "bg-slate")}>
            <div className="min-w-0">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className={cx("text-sm truncate", !audible && "text-chalk-dim")} title={track.name}>
                  {track.name}
                </span>
                {ephemeral && <span className="text-xs text-pad">auditioning</span>}
                {waiting && <span className="text-xs text-chalk-dim">decoding</span>}
              </div>
              {track.provenance && (
                <div className="mt-0.5 text-xs text-chalk-faint truncate" title={track.provenance}>
                  {track.provenance}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                className={cx("h-6 px-1.5 rounded-sm border text-xs", track.muted ? "border-pad text-pad" : "border-rule text-chalk-dim hover:text-chalk")}
                aria-pressed={track.muted}
                onClick={() => session.setMute(track.id, !track.muted)}
                title="Mute this lane; the audio keeps running, so unmuting lands on the beat"
              >
                M
              </button>
              <button
                type="button"
                className={cx("h-6 px-1.5 rounded-sm border text-xs", track.soloed ? "border-pad text-pad" : "border-rule text-chalk-dim hover:text-chalk")}
                aria-pressed={track.soloed}
                onClick={() => session.setSolo(track.id, !track.soloed)}
                title="Solo this lane against the session"
              >
                S
              </button>
              <input
                type="range"
                min={-24}
                max={6}
                step={1}
                value={db}
                onChange={(e) => session.setGain(track.id, gainFromDb(Number(e.target.value)))}
                className="w-[88px] accent-[#f0a63a]"
                aria-label={`${track.name} level in decibels`}
                title="Level"
              />
              <span className={cx(mono, "text-xs text-chalk-dim w-[38px] text-right")}>{db > 0 ? `+${db}` : db} dB</span>
              <button type="button" className={btnQuiet} onClick={() => session.removeTrack(track.id)} aria-label={`Remove ${track.name}`} title="Take this lane out of the session">
                ×
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
