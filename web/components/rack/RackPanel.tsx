"use client";

// The candidate rack.
//
// "A ranked table is how a machine decides and pressing play is how a producer
// decides." So the ranking is still here — the rows arrive in order and each
// one says what earned it its place — but the order is a suggestion and the
// row is an instrument. Every row plays under the session, looped between the
// locators, and the next row takes over on the same bar.

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/components/shell/SessionProvider";
import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { btn, btnQuiet, label } from "@/components/ui";
import { fmtBpm } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { candidateLength, stepCandidate, trackIdFor, type RackCandidate } from "@/lib/session/rack";
import { CandidateRow } from "./CandidateRow";
import type { RackState } from "./useRack";

export function RackPanel({ state }: { state: RackState }) {
  const session = useSession();
  const { rack, loading, error } = state;
  const auditioning = session.auditioning;
  const playheadS = useAuditionPlayhead(auditioning, session.playing);
  const committed = new Set(session.tracks.map((t) => t.id));

  const step = (direction: 1 | -1) => {
    const next = stepCandidate(rack, auditioning, direction);
    if (next) void session.audition(next);
  };

  const auditionId = auditioning?.id ?? null;
  const audition = session.audition;
  const commit = session.commit;
  const onAudition = useCallback((candidate: RackCandidate) => void audition(auditionId === candidate.id ? null : candidate), [audition, auditionId]);
  const onCommit = useCallback((candidate: RackCandidate) => void commit(candidate), [commit]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 px-4 py-2 border-b border-rule flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          className={btn}
          onClick={() => step(-1)}
          disabled={!rack || rack.candidates.length === 0}
          title="Audition the row above, on the same bar"
        >
          Previous
        </button>
        <button
          type="button"
          className={btn}
          onClick={() => step(1)}
          disabled={!rack || rack.candidates.length === 0}
          title="Audition the next row, on the same bar; the session keeps playing"
        >
          Next
        </button>
        <button type="button" className={btnQuiet} onClick={() => void session.audition(null)} disabled={!auditioning}>
          Stop auditioning
        </button>
        <span className="text-xs text-chalk-dim">
          {auditioning ? (
            <>
              under the session: <span className="text-chalk">{auditioning.title}</span>
            </>
          ) : (
            "press play on a row to hear it under the session"
          )}
        </span>
        <button type="button" className={btnQuiet} onClick={() => void state.reload()} disabled={loading || !state.request}>
          {loading ? "Looking" : "Refresh"}
        </button>
      </div>

      {rack?.source && (
        <p className="px-4 pt-2 text-xs text-chalk-dim max-w-[680px] flex flex-wrap items-baseline gap-x-2">
          <span>Matching against</span>
          <span className="font-mono text-chalk flex items-baseline gap-1">
            {rack.source.bpm === null ? "no tempo" : `${fmtBpm(rack.source.bpm)} BPM`}
            <ConfidenceDot confidence={rack.source.bpmConfidence} />
          </span>
          <span className="font-mono text-chalk flex items-baseline gap-1">
            {rack.source.tonic && rack.source.mode ? displayKey(rack.source.tonic, rack.source.mode) : "no key"}
            <ConfidenceDot confidence={rack.source.keyConfidence} />
          </span>
          <span title={rack.method ?? undefined}>on {rack.source.name}. The order is what the measurements suggest; the ear decides.</span>
        </p>
      )}

      {error && (
        <p role="alert" className="mx-4 mt-2 text-xs border-l-2 border-pad pl-2 flex items-center gap-2">
          {error}
          <button type="button" className={btnQuiet} onClick={() => void state.reload()}>
            Retry
          </button>
        </p>
      )}

      {session.error && (
        <p role="alert" className="mx-4 mt-2 text-xs border-l-2 border-pad pl-2 flex items-center gap-2">
          {session.error}
          <button type="button" className={btnQuiet} onClick={session.clearError}>
            Dismiss
          </button>
        </p>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading && !rack ? (
          <p className="px-4 py-3 text-sm text-chalk-dim">Looking through the crate.</p>
        ) : !rack ? (
          <EmptyRack />
        ) : rack.candidates.length === 0 ? (
          <p className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">{rack.note ?? "Nothing in the crate fits this one yet. Bring in more material, or widen the search on the Fits with tab."}</p>
        ) : (
          <>
            <p className="px-4 pb-2 pt-2 text-xs text-chalk-dim">
              <span className="font-mono text-chalk">{rack.candidates.length}</span> {rack.candidates.length === 1 ? "candidate" : "candidates"}, ranked by{" "}
              <span title={rack.method ?? undefined}>{shortMethod(rack.method)}</span>. {rack.note ?? ""}
            </p>
            <ul>
              {rack.candidates.map((candidate) => (
                <CandidateRow
                  key={candidate.id}
                  candidate={candidate}
                  auditioning={auditionId === candidate.id}
                  playheadS={auditionId === candidate.id ? playheadS : null}
                  committed={committed.has(trackIdFor(candidate))}
                  onAudition={onAudition}
                  onCommit={onCommit}
                />
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="shrink-0 border-t border-rule px-4 py-1.5 flex items-center gap-3">
        <span className={label}>Say it instead</span>
        <span className="text-xs text-chalk-faint">&ldquo;next&rdquo;, &ldquo;play the third one under this&rdquo;, &ldquo;keep it&rdquo;, &ldquo;loop bars 9 to 16&rdquo;</span>
      </div>
    </div>
  );
}

function EmptyRack() {
  return (
    <div className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">
      <p>
        A rack is a list of candidates you can hear. Ask the chat for what fits the open file, or open one from the Fits with tab, and every answer
        arrives as a row with a play button instead of a number in a table.
      </p>
      <p className="mt-2">Each row plays under whatever the session is already playing, looped, so the choice is made in context.</p>
    </div>
  );
}

function shortMethod(method: string | null): string {
  if (!method) return "the measurements";
  const first = method.split(";")[0] ?? method;
  return first.length > 64 ? `${first.slice(0, 61)}…` : first;
}

/**
 * Where the audition is inside the candidate's own file, for the marker on its
 * waveform. Read on an animation frame rather than in React state: the playhead
 * moves sixty times a second and the rack must not re-render with it.
 */
function useAuditionPlayhead(candidate: RackCandidate | null, playing: boolean): number | null {
  const session = useSession();
  const [at, setAt] = useState<number | null>(null);
  const frame = useRef(0);
  useEffect(() => {
    if (!candidate || !playing) {
      setAt(null);
      return;
    }
    const loop = session.loop;
    const cycle = candidateLength(candidate);
    const rate = candidate.fit?.rate ?? 1;
    if (cycle <= 0) return;
    // Throttled, and only when it has visibly moved: the marker is two pixels
    // wide and the rack is thirty rows.
    let last = 0;
    const tick = (now: number) => {
      if (now - last > 60) {
        last = now;
        const position = session.position();
        const from = loop ? loop.startS : 0;
        const within = (((position - from) % cycle) + cycle) % cycle;
        setAt(candidate.audio.downbeatS + within * rate);
      }
      frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [candidate, playing, session]);
  return at;
}
