"use client";

// Where the cuts go, proposed and never placed silently: every cut carries the
// measurement behind it and a reason, and none of them are cut until the
// producer presses Cut here. A cut can be dragged (nudged by a step, or typed)
// or removed, and a moved cut is kept as a correction against what was
// proposed — which is the accuracy dataset, not a log line.

import { useState } from "react";
import { btn, btnPrimary, btnQuiet, cx, label, segment, segmentItem } from "@/components/ui";
import { fmtClock } from "@/lib/format";
import { SLICE_MATERIALS, describeProposal, markersFor, type SliceMaterial, type SliceProposal } from "@/lib/pads/slices";

export function SlicePanel({
  proposal,
  material,
  guessWhy,
  canChop,
  onPropose,
  onMove,
  onRemove,
  onAdd,
  cursor,
  onCut,
  corrections,
}: {
  proposal: SliceProposal | null;
  material: SliceMaterial | null;
  /** why the material was read that way, from the measurements */
  guessWhy: string;
  canChop: boolean;
  onPropose: (material: SliceMaterial | null) => void;
  onMove: (id: string, toS: number) => void;
  onRemove: (id: string) => void;
  onAdd: (timeS: number) => void;
  cursor: number;
  onCut: (markers: number[]) => void;
  corrections: number;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section aria-label="Where the cuts go" className="mt-3 border-t border-rule pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={label}>Cuts</span>
        <div className={segment} role="group" aria-label="Material">
          {SLICE_MATERIALS.map((m) => (
            <button key={m.id} type="button" data-active={material === m.id} onClick={() => onPropose(m.id)} className={segmentItem} title={m.describe}>
              {m.label}
            </button>
          ))}
        </div>
        <button type="button" className={btn} onClick={() => onPropose(null)} title="Read the material and propose cuts from what was measured">
          Propose
        </button>
        {proposal && proposal.points.length > 0 && (
          <>
            <button type="button" className={btnPrimary} disabled={!canChop} onClick={() => onCut(markersFor(proposal))} title="Cut the file at these points; every chop becomes a library file">
              Cut {proposal.points.length}
            </button>
            <button type="button" className={btnQuiet} onClick={() => onAdd(cursor)} title="Add a cut where the playhead is">
              Add at {fmtClock(cursor)}
            </button>
            <button type="button" className={btnQuiet} onClick={() => setOpen((v) => !v)}>
              {open ? "Hide" : `Show ${proposal.points.length}`}
            </button>
          </>
        )}
      </div>

      <p className="mt-1.5 text-xs text-chalk-dim max-w-[640px]">
        {proposal ? describeProposal(proposal) : guessWhy}
        {corrections > 0 && ` ${corrections} ${corrections === 1 ? "cut" : "cuts"} moved by hand; the moves are kept as corrections.`}
      </p>

      {proposal?.notes.map((note) => (
        <p key={note} className="mt-1 text-xs text-chalk-dim max-w-[640px]">
          {note}
        </p>
      ))}

      {proposal && open && proposal.points.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1 max-h-[220px] overflow-y-auto" aria-label="Proposed cuts">
          {proposal.points.map((point, i) => (
            <li key={point.id} className="flex items-center gap-2 text-xs border border-rule rounded-sm px-2 h-7">
              <span className="font-mono text-chalk-dim w-5 text-right">{i + 1}</span>
              <span className="font-mono text-chalk w-[74px]">{point.timeS.toFixed(3)}s</span>
              <span className={cx("truncate flex-1", point.origin === "proposed" ? "text-chalk-dim" : "text-chalk")} title={`${point.reason} — ${point.method}, confidence ${point.confidence.toFixed(2)}`}>
                {point.reason}
              </span>
              <span className="font-mono text-2xs text-chalk-faint" title={`method: ${point.method}`}>
                {point.confidence.toFixed(2)}
              </span>
              <button type="button" className={btnQuiet} onClick={() => onMove(point.id, point.timeS - 0.01)} aria-label={`Move cut ${i + 1} 10 ms earlier`}>
                ‹
              </button>
              <button type="button" className={btnQuiet} onClick={() => onMove(point.id, point.timeS + 0.01)} aria-label={`Move cut ${i + 1} 10 ms later`}>
                ›
              </button>
              <button type="button" className={btnQuiet} onClick={() => onMove(point.id, cursor)} aria-label={`Move cut ${i + 1} to the playhead`} title="Move this cut to the playhead">
                ⌖
              </button>
              <button type="button" className={btnQuiet} onClick={() => onRemove(point.id)} aria-label={`Remove cut ${i + 1}`}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
