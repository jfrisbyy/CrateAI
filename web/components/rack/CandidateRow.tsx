"use client";

// One candidate: a waveform with its region marked, a play button that starts
// on the downbeat, the measurement that earned it a place with its confidence
// and hedge, where it came from, and one click to commit it to the session.
//
// The control that matters is the first one. It does not audition the file in
// isolation: it puts the candidate on the session's audition lane, looped
// between the locators, under whatever is already playing. Pressing it on the
// next row swaps the lane on the same bar without stopping anything, which is
// the whole reason the rack exists.

import { memo } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "@/components/shell/SessionProvider";
import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { btn, btnQuiet, cx } from "@/components/ui";
import { fmtClock } from "@/lib/format";
import { hedgeWord } from "@/lib/report/hedge";
import type { RackCandidate } from "@/lib/session/rack";
import { PeaksBar } from "./PeaksBar";

/**
 * Memoized, and the handlers take the candidate rather than closing over it, so
 * the thirty rows of a rack do not re-render with the audition playhead. Only
 * the row that is sounding has a moving prop.
 */
export const CandidateRow = memo(function CandidateRow({
  candidate,
  auditioning,
  playheadS,
  onAudition,
  onCommit,
  committed,
}: {
  candidate: RackCandidate;
  auditioning: boolean;
  /** where inside the file the audition is, when this row is the one sounding */
  playheadS: number | null;
  onAudition: (candidate: RackCandidate) => void;
  onCommit: (candidate: RackCandidate) => void;
  committed: boolean;
}) {
  const session = useSession();
  const router = useRouter();
  const fileId = candidate.audio.fileId;
  const decode = session.decodeStateOf(fileId);
  const hedge = hedgeWord(candidate.confidence);
  const p = candidate.provenance;

  // Lazily, on hover or focus: a rack of thirty rows decodes nothing until a
  // producer looks like they are about to press play on one.
  const warm = () => session.warm(fileId);

  return (
    <li
      className={cx("relative border-b border-rule px-4 py-2 grid grid-cols-[22px_28px_minmax(0,1fr)_auto] gap-x-3 items-start", auditioning && "bg-slate")}
      onMouseEnter={warm}
      onFocus={warm}
      data-auditioning={auditioning}
    >
      {auditioning && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-pad" aria-hidden />}
      <span className={cx("font-mono text-xs pt-1.5", auditioning ? "text-pad" : "text-chalk-faint")} title={`ranked ${candidate.rank}; the order is a suggestion`}>
        {candidate.rank}
      </span>

      <button
        type="button"
        className={cx(
          "h-7 w-7 rounded-sm border flex items-center justify-center shrink-0",
          auditioning ? "border-pad text-pad" : "border-rule text-chalk hover:border-rule-strong",
        )}
        onClick={() => onAudition(candidate)}
        aria-pressed={auditioning}
        aria-label={auditioning ? `Stop auditioning ${candidate.title}` : `Audition ${candidate.title} under the session`}
        title={auditioning ? "Stop auditioning" : "Play this under the session, looped, from its downbeat"}
      >
        <span aria-hidden className="font-mono text-xs">
          {auditioning ? "■" : "▶"}
        </span>
      </button>

      <div className="min-w-0">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-sm truncate" title={candidate.title}>
            {candidate.title}
          </span>
          {p.stem && <span className="text-xs text-chalk-dim">{p.stem}</span>}
          {decode === "decoding" && <span className="text-xs text-chalk-dim">decoding</span>}
          {decode === "error" && (
            <span className="text-xs text-chalk" title={session.decodeErrorOf(fileId) ?? undefined}>
              could not decode
            </span>
          )}
        </div>

        <div className="mt-0.5 flex items-baseline gap-2 min-w-0">
          <span className="text-sm text-chalk">{candidate.reason}</span>
          <ConfidenceDot confidence={candidate.confidence} className="translate-y-[-1px]" />
          <span className="text-xs text-chalk-faint truncate" title={candidate.confidenceReason ?? undefined}>
            {candidate.confidence === null
              ? "not measured"
              : hedge === ""
                ? `confidence ${candidate.confidence.toFixed(2)}`
                : `${hedge}${candidate.confidenceReason ? `, ${candidate.confidenceReason}` : ""}`}
          </span>
        </div>

        <div className="mt-1 max-w-[320px]">
          <PeaksBar
            peaks={candidate.peaks}
            durationS={candidate.fileDurationS}
            startS={candidate.audio.startS}
            endS={candidate.audio.endS}
            downbeatS={candidate.audio.downbeatS}
            playheadS={auditioning ? playheadS : null}
            label={`${candidate.title}: ${fmtClock(candidate.audio.startS, 0)} to ${fmtClock(candidate.audio.endS, 0)}`}
          />
        </div>

        <div className="mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 font-mono text-xs text-chalk-dim">
          {candidate.measurements.map((m) => (
            <span key={m.label} title={m.method ?? undefined} className="flex items-baseline gap-1">
              <span className="text-chalk">{m.label}</span>
              <ConfidenceDot confidence={m.confidence} />
            </span>
          ))}
          {candidate.fit && candidate.fit.rate !== 1 && (
            <span title={`Auditioned at ${candidate.fit.rate.toFixed(3)}x, which moves the pitch with the tempo the way a sampler does`}>
              ×{candidate.fit.rate.toFixed(3)}
            </span>
          )}
        </div>

        <div className="mt-0.5 text-xs text-chalk-faint truncate" title={`${p.fileName}, ${fmtClock(p.startS)}–${fmtClock(p.endS)}${p.separationModel ? `, separated with ${p.separationModel}` : ""}`}>
          {p.fileName} · {fmtClock(p.startS, 0)}–{fmtClock(p.endS, 0)}
          {p.separationModel ? ` · ${p.separationModel}` : ""}
        </div>
      </div>

      <div className="flex items-center gap-1">
        <button type="button" className={btnQuiet} onClick={() => router.push(`/f/${fileId}`)} title="Open the record this came from">
          Source
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => onCommit(candidate)}
          disabled={committed}
          title="Put this in the session as a track of its own; the audition lane is freed for the next candidate"
        >
          {committed ? "In the session" : "Commit"}
        </button>
      </div>
    </li>
  );
});
