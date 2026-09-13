"use client";

// The session transport, one strip, always reachable and never modal. It is
// the same clock the rack auditions on and the same clock a committed track
// plays on, so there is one playhead in the product, not one per panel.

import { useEffect, useRef, useState } from "react";
import { btn, btnQuiet, cx, mono } from "@/components/ui";
import { fmtClock } from "@/lib/format";
import { dbFromGain, gainFromDb } from "@/lib/session/mix";
import { useSession } from "./SessionProvider";

export function TransportBar({ onOpenSession }: { onOpenSession: () => void }) {
  const session = useSession();
  const position = usePlayhead(session.playing);
  const loop = session.loop;
  const lanes = session.tracks.length;

  return (
    <div className="shrink-0 border-t border-rule h-9 px-4 flex items-center gap-3 min-w-0">
      <button
        type="button"
        className={cx(btn, session.playing && "border-pad text-pad")}
        onClick={() => session.toggle()}
        aria-label={session.playing ? "Pause" : "Play"}
        title={session.playing ? "Pause (the panel keeps its place)" : "Play the session"}
      >
        <span aria-hidden className="font-mono">
          {session.playing ? "❚❚" : "▶"}
        </span>
      </button>
      <button type="button" className={btnQuiet} onClick={() => session.stop()} aria-label="Stop" title="Stop and return to the loop start">
        <span aria-hidden className="font-mono">
          ■
        </span>
      </button>

      <span className={cx(mono, "text-sm w-[72px]")} aria-live="off" title="The playhead, in session seconds">
        {fmtClock(position)}
      </span>

      <button
        type="button"
        className={cx(btnQuiet, loop && "text-pad")}
        onClick={() => session.setLoop(loop ? null : { startS: 0, endS: Math.max(1, session.contentEndS) })}
        aria-pressed={loop !== null}
        title={loop ? "Turn the loop off" : "Loop the whole session"}
      >
        Loop
      </button>
      {loop && (
        <span className={cx(mono, "text-xs text-chalk-dim")} title="The locators. Say &ldquo;loop bars 9 to 16&rdquo; to move them.">
          {fmtClock(loop.startS, 0)} – {fmtClock(loop.endS, 0)}
        </span>
      )}

      <button type="button" className={btnQuiet} onClick={onOpenSession} title="The song: regions on a timeline, with mute, solo, level and the lineage of every region">
        {lanes === 0 ? "No lanes yet" : `Song · ${lanes} ${lanes === 1 ? "lane" : "lanes"}`}
      </button>

      {session.waiting.length > 0 && (
        <span className="text-xs text-chalk-dim" title="A lane is still decoding; it joins in progress the moment it lands">
          {session.waiting.length} still decoding
        </span>
      )}

      <div className="ml-auto flex items-center gap-2 min-w-0">
        {session.memory.bytes > 0 && (
          <span
            className={cx(mono, "text-xs", session.memory.overBudget ? "text-chalk" : "text-chalk-faint")}
            title={`Decoded audio held in memory, against a ${Math.round(session.memory.maxBytes / (1024 * 1024))} MB budget. Anything not in the session is dropped first.`}
          >
            {Math.round(session.memory.bytes / (1024 * 1024))} MB
          </span>
        )}
        <label className="flex items-center gap-1.5 text-xs text-chalk-dim" title="Master level">
          Master
          <input
            type="range"
            min={-24}
            max={6}
            step={1}
            value={Math.round(dbFromGain(session.masterGain))}
            onChange={(e) => session.setMasterGain(gainFromDb(Number(e.target.value)))}
            className="w-[90px] accent-[#f0a63a]"
            aria-label="Master level in decibels"
          />
        </label>
      </div>
    </div>
  );
}

/** The playhead on an animation frame; the rest of the shell does not re-render with it. */
function usePlayhead(playing: boolean): number {
  const session = useSession();
  const [at, setAt] = useState(0);
  const frame = useRef(0);
  useEffect(() => {
    setAt(session.position());
    if (!playing) return;
    const tick = () => {
      setAt(session.position());
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [playing, session]);
  return at;
}
