"use client";

// The processing dock, as a component with no context in it — every number it
// shows and every callback it calls is a prop, so the whole surface renders in
// a test without a browser or a provider.
//
// The rules it is built to:
//
//   Bypass is one press and it is real (lib/processing/graph.ts crossfades to
//   a dry path that never went through a filter). "Compare" is the same thing
//   held down, because A/B against bypass is the control a producer reaches
//   for most and a toggle you have to press twice is not it.
//
//   Nothing is hidden. Every band the chain has is a row with its numbers in
//   it, whether a hand or a sentence put them there, and a move a proposal
//   made carries the reason it gave.
//
//   Nothing is destructive. "Take it off" removes the chain; the samples were
//   never touched.

import { useRef, useState } from "react";
import { btn, btnQuiet, cx, input, mono } from "@/components/ui";
import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { activeBands, describeProcessing } from "@/lib/processing/chain";
import { formatDb } from "@/lib/processing/eq";
import { describeTune, timeCostPercent } from "@/lib/processing/tune";
import { COMPLAINT_WORDS } from "@/lib/processing/complaints";
import { MAX_TRIM_DB, MAX_TUNE_CENTS, type BandId, type EqBand, type TrackProcessing } from "@/lib/processing/types";
import { BandRow } from "./BandRow";
import { EqCurve, type BandDrag } from "./EqCurve";

export interface ProposalNote {
  summary: string;
  confidence: number | null;
  lines: string[];
  notes: string[];
  /** which bands it moved, so the curve can mark them */
  bands: BandId[];
  /** the reason it gave for each band it moved */
  why: Partial<Record<BandId, string>>;
}

export interface Lane {
  id: string;
  name: string;
}

export function ProcessingPanel({
  lanes,
  trackId,
  processing,
  sampleRate,
  selected,
  proposal,
  busy,
  note,
  onPickLane,
  onSelect,
  onBand,
  onToggleBand,
  onTrim,
  onTune,
  onBypass,
  onReset,
  onRemove,
  onAsk,
  onUndoProposal,
}: {
  lanes: readonly Lane[];
  trackId: string | null;
  processing: TrackProcessing;
  sampleRate: number;
  selected: BandId | null;
  proposal: ProposalNote | null;
  busy: boolean;
  note: string | null;
  onPickLane: (trackId: string) => void;
  onSelect: (id: BandId) => void;
  onBand: (id: BandId, patch: Partial<Pick<EqBand, "frequency" | "gainDb" | "q">>) => void;
  onToggleBand: (id: BandId) => void;
  onTrim: (db: number) => void;
  onTune: (cents: number) => void;
  onBypass: (bypassed: boolean) => void;
  onReset: () => void;
  onRemove: () => void;
  onAsk: (complaint: string) => void;
  onUndoProposal: () => void;
}) {
  const [ask, setAsk] = useState("");
  // Hold-to-compare has to put the chain back where it was, not "on": holding
  // it while already bypassed should let a producer hear the processing, and
  // letting go should leave the bypass exactly as they found it.
  const beforeCompare = useRef<boolean | null>(null);

  if (lanes.length === 0 || !trackId) {
    return (
      <div className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">
        <p>Nothing in the session to work on yet. Commit a candidate from a rack and it becomes a lane, and every lane gets an EQ, a trim and a tune.</p>
        <p className="mt-2">The controls are the same by mouse and by sentence: &ldquo;clean up the trumpet&rdquo;, &ldquo;cut 300 on the drums&rdquo;, &ldquo;a/b the horns&rdquo;.</p>
      </div>
    );
  }

  const engaged = !processing.bypassed;
  const moved = new Set(proposal?.bands ?? []);

  const hold = () => {
    if (beforeCompare.current !== null) return;
    beforeCompare.current = processing.bypassed;
    onBypass(!processing.bypassed);
  };
  const release = () => {
    const was = beforeCompare.current;
    beforeCompare.current = null;
    if (was !== null) onBypass(was);
  };
  const tuneCost = timeCostPercent(processing.tuneCents);

  return (
    <div className="flex flex-col min-h-0">
      <div className="shrink-0 px-3 py-2 flex flex-wrap items-center gap-2 border-b border-rule">
        <label className="sr-only" htmlFor="processing-lane">
          Lane
        </label>
        <select
          id="processing-lane"
          className={cx(input, "max-w-[220px]")}
          value={trackId}
          onChange={(e) => onPickLane(e.target.value)}
          title="Which lane the chain belongs to. Processing is a property of the track and stays with it."
        >
          {lanes.map((lane) => (
            <option key={lane.id} value={lane.id}>
              {lane.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          className={cx(btn, engaged && "border-pad text-pad")}
          aria-pressed={engaged}
          onClick={() => onBypass(engaged)}
          title="Engage or bypass the whole chain. Bypass is the dry signal, not a chain set flat: it never goes through a filter."
        >
          {engaged ? "On" : "Bypassed"}
        </button>

        <button
          type="button"
          className={btn}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            hold();
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            release();
          }}
          onPointerCancel={release}
          onKeyDown={(e) => {
            if (e.key === " " || e.key === "Enter") hold();
          }}
          onKeyUp={(e) => {
            if (e.key === " " || e.key === "Enter") release();
          }}
          onBlur={release}
          title="Hold to hear the other one. This is the A/B: the bypass is a dry path that never went through a filter, and letting go is putting it back exactly as you found it, on the same bar."
        >
          Hold to compare
        </button>

        <button type="button" className={btnQuiet} onClick={onReset} title="Put every band back to nothing, keeping the chain on the lane">
          Reset
        </button>
        <button type="button" className={btnQuiet} onClick={onRemove} title="Take the chain off this lane entirely. The audio was never touched, so there is nothing to undo in the file.">
          Take it off
        </button>
      </div>

      <div className="shrink-0 px-3 pt-2">
        <EqCurve bands={processing.bands} sampleRate={sampleRate} bypassed={processing.bypassed} selected={selected} onSelect={onSelect} onDrag={(id, patch: BandDrag) => onBand(id, patch)} proposed={moved} />
      </div>

      <div className="shrink-0 px-3 py-1.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-rule">
        <label className="flex items-center gap-1.5 text-2xs text-chalk-dim" title="Gain staging, before the filters, so a boost does not run the chain hot. The lane's fader is still the balance control.">
          trim
          <input
            type="range"
            min={-MAX_TRIM_DB}
            max={MAX_TRIM_DB}
            step={0.5}
            value={processing.trimDb}
            onChange={(e) => onTrim(Number(e.target.value))}
            className="w-[96px] accent-[#f0a63a]"
            aria-label="Input trim in decibels"
          />
          <span className={cx(mono, "text-2xs text-chalk-faint w-[46px] text-right")}>{formatDb(processing.trimDb)}</span>
        </label>

        <label
          className="flex items-center gap-1.5 text-2xs text-chalk-dim"
          title="Tuning resamples: pitch and time move together, the way a sampler or a turntable does. Real pitch-shifting with time held is a render, not a playback trick."
        >
          tune
          <input
            type="range"
            min={-MAX_TUNE_CENTS}
            max={MAX_TUNE_CENTS}
            step={5}
            value={processing.tuneCents}
            onChange={(e) => onTune(Number(e.target.value))}
            className="w-[96px] accent-[#f0a63a]"
            aria-label="Tune in cents"
          />
          <span className={cx(mono, "text-2xs text-chalk-faint")}>{describeTune(processing.tuneCents)}</span>
          {processing.tuneCents !== 0 && (
            <span className="text-2xs text-chalk-faint" title="Because this resamples, the same stretch of the record takes this much longer or shorter to go by.">
              ({tuneCost > 0 ? "+" : ""}
              {Math.round(tuneCost * 10) / 10}% time)
            </span>
          )}
        </label>

        <span className={cx("text-2xs text-chalk-faint ml-auto truncate max-w-[280px]")} title={describeProcessing(processing)}>
          {activeBands(processing).length === 0 ? "nothing on it" : describeProcessing(processing)}
        </span>
      </div>

      <ul className="min-h-0 overflow-y-auto">
        {processing.bands.map((band) => (
          <BandRow
            key={band.id}
            band={band}
            selected={selected === band.id}
            why={proposal?.why[band.id] ?? null}
            onSelect={() => onSelect(band.id)}
            onChange={(patch) => onBand(band.id, patch)}
            onToggle={() => onToggleBand(band.id)}
          />
        ))}
      </ul>

      {proposal && (
        <div className="shrink-0 border-t border-rule px-3 py-2 flex flex-col gap-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-xs text-chalk">{proposal.summary}</span>
            <ConfidenceDot confidence={proposal.confidence} />
            <span className={cx(mono, "text-2xs text-chalk-faint")}>{proposal.lines.join(" · ")}</span>
            <button type="button" className={cx(btnQuiet, "ml-auto")} onClick={onUndoProposal} title="Put the chain back to where it was before this">
              Undo that
            </button>
          </div>
          {proposal.notes.map((line, i) => (
            <p key={i} className="text-2xs text-chalk-faint">
              {line}
            </p>
          ))}
        </div>
      )}

      <form
        className="shrink-0 border-t border-rule px-3 py-2 flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const text = ask.trim();
          if (text === "") return;
          onAsk(text);
          setAsk("");
        }}
      >
        <input
          className={cx(input, "flex-1 min-w-0")}
          value={ask}
          onChange={(e) => setAsk(e.target.value)}
          placeholder="What is wrong with it? &ldquo;muddy&rdquo;, &ldquo;dull&rdquo;, &ldquo;clean it up&rdquo;"
          aria-label="What is wrong with this track"
          title={`The same thing said in the chat does the same thing here. Words that land straight away: ${COMPLAINT_WORDS}.`}
        />
        <button type="submit" className={btn} disabled={busy || ask.trim() === ""}>
          {busy ? "Working" : "Fix it"}
        </button>
      </form>

      {note && (
        <p className="shrink-0 px-3 pb-2 text-2xs text-chalk-faint" role="status">
          {note}
        </p>
      )}
    </div>
  );
}
