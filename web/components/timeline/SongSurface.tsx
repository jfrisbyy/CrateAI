"use client";

// The song surface: the timeline, and the lane list as the narrow view of the
// same thing.
//
// Two views rather than two surfaces, because they are one object under
// discussion — the panel's rule is one surface at a time, with history, and a
// song that took two entries in that history would be a mess. The lane list is
// what is left when the panel is too narrow to arrange in, which on a phone or
// a squeezed divider is most of the time.

import { useState } from "react";
import { SessionPanel } from "@/components/shell/SessionPanel";
import { segment, segmentItem } from "@/components/ui";
import { TimelinePanel } from "./TimelinePanel";

type View = "timeline" | "lanes";

export function SongSurface() {
  const [view, setView] = useState<View>("timeline");
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-3 py-1.5 border-b border-rule flex items-center gap-2">
        <span className={segment} role="group" aria-label="How to show the song">
          <button type="button" className={segmentItem} data-active={view === "timeline"} onClick={() => setView("timeline")} aria-pressed={view === "timeline"} title="Regions on a timeline: drag to move, drag an edge to trim">
            Timeline
          </button>
          <button type="button" className={segmentItem} data-active={view === "lanes"} onClick={() => setView("lanes")} aria-pressed={view === "lanes"} title="Just the lanes, for a narrow panel">
            Lanes
          </button>
        </span>
        <span className="text-xs text-chalk-faint truncate">Arrangement and audition. Processing is a later phase, on purpose.</span>
      </div>
      {view === "timeline" ? (
        <TimelinePanel />
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <SessionPanel />
        </div>
      )}
    </div>
  );
}
