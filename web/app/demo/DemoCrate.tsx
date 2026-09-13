"use client";

// The crate: what is in the library, with what was measured on it.
//
// The rail in the app is components/library/LibraryPane, which uploads, polls
// and searches; none of that exists here, so this is the reading half of it —
// the rows, their measured tempo and key, and the same confidence dot the rest
// of the product uses. The two buttons are the ones the panel header carries,
// and they go out on the same `crateai:rack` event the app's do.

import { openRack } from "@/components/rack/rackEvents";
import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { btnQuiet, cx, mono } from "@/components/ui";
import { fmtBpm, fmtClock } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { vitalsOf } from "@/lib/session/rack";
import type { FileRow } from "@/lib/types/db";
import { BED_ID } from "@/lib/demo/material";

const LOOPS_IN = "demo-masquerade-drums";

export function DemoCrate({ files }: { files: readonly FileRow[] }) {
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 h-9 px-3 border-b border-rule flex items-center gap-2">
        <span className="text-sm">Crate</span>
        <span className={cx(mono, "text-xs text-chalk-dim")}>{files.length}</span>
      </div>
      <ul className="flex-1 min-h-0 overflow-y-auto">
        {files.map((file) => {
          const v = vitalsOf(file);
          const stem = file.kind === "stem";
          return (
            <li key={file.id} className="border-b border-rule px-3 py-2">
              <div className="text-sm truncate" title={file.title ?? file.original_filename}>
                {file.title ?? file.original_filename}
              </div>
              <div className="text-xs text-chalk-faint truncate">
                {file.artist}
                {stem ? " · stem" : ""}
              </div>
              <div className="mt-0.5 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className={cx(mono, "text-xs text-chalk flex items-baseline gap-1")} title={v.bpm === null ? "no tempo could be measured on this one" : "tempo from the analysis"}>
                  {v.bpm === null ? "no tempo" : `${fmtBpm(v.bpm)} BPM`}
                  <ConfidenceDot confidence={v.bpm_confidence} />
                </span>
                <span className={cx(mono, "text-xs text-chalk flex items-baseline gap-1")} title={v.tonic && v.mode ? "key from the analysis" : "drums: nothing tonal to measure"}>
                  {v.tonic && v.mode ? displayKey(v.tonic, v.mode) : "no key"}
                  <ConfidenceDot confidence={v.key_confidence} />
                </span>
                <span className={cx(mono, "text-xs text-chalk-faint")}>{fmtClock(file.duration_s ?? 0, 0)}</span>
              </div>
              {file.id === BED_ID && (
                <button type="button" className={cx(btnQuiet, "mt-1")} onClick={() => openRack({ source: "compat", fileId: file.id })} title="Everything in the crate that fits this, as a rack you can play">
                  What fits this
                </button>
              )}
              {file.id === LOOPS_IN && (
                <button type="button" className={cx(btnQuiet, "mt-1")} onClick={() => openRack({ source: "loops", fileId: file.id })} title="The loops found in this file, as a rack you can play">
                  Loops here
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <p className="shrink-0 border-t border-rule px-3 py-2 text-xs text-chalk-faint">
        Synthesised in your browser when the page loaded. No uploads, no network, no account.
      </p>
    </div>
  );
}
