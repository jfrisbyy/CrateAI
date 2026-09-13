"use client";

// What happens to a take after it is played: clean it up without losing it,
// hear variations of it that are strictly its own hits rearranged, and put it
// on a track in the session so it sits in time with everything else.
//
// The played take is never overwritten. "Played" and "Cleaned" are two buttons
// and the producer chooses which one goes anywhere.

import { btn, btnPrimary, btnQuiet, cx, label } from "@/components/ui";
import { describeCleanup, looseness, type CleanedTake } from "@/lib/pads/cleanup";
import type { PatternVariation } from "@/lib/pads/patterns";
import type { Take } from "@/lib/pads/recording";

export type TakeChoice = "played" | "cleaned" | string;

export function TakePanel({
  take,
  cleaned,
  tighten,
  collapseFlams,
  variations,
  chosen,
  sessionNote,
  canKeep,
  onTighten,
  onCollapseFlams,
  onClean,
  onSuggest,
  onChoose,
  onKeep,
}: {
  take: Take | null;
  cleaned: CleanedTake | null;
  tighten: number;
  collapseFlams: boolean;
  variations: PatternVariation[];
  chosen: TakeChoice;
  /** what the session will do with it: where it lands, and at what tempo */
  sessionNote: string | null;
  canKeep: boolean;
  onTighten: (amount: number) => void;
  onCollapseFlams: (on: boolean) => void;
  onClean: () => void;
  onSuggest: () => void;
  onChoose: (choice: TakeChoice) => void;
  onKeep: () => void;
}) {
  if (!take || take.hits.length === 0) return null;

  return (
    <section aria-label="The take" className="mt-3 border-t border-rule pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={label}>Take</span>
        <label className="flex items-center gap-1.5 text-xs text-chalk-dim">
          tighten
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={Math.round(tighten * 100)}
            onChange={(e) => onTighten(Number(e.target.value) / 100)}
            className="w-[100px] accent-[#f0a63a]"
            aria-label="Tighten toward the grid, percent"
          />
          <span className="font-mono text-chalk w-8">{Math.round(tighten * 100)}%</span>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-chalk-dim">
          <input type="checkbox" checked={collapseFlams} onChange={(e) => onCollapseFlams(e.target.checked)} className="accent-[#f0a63a]" />
          collapse flams
        </label>
        <button type="button" className={btn} onClick={onClean} title="Tighten, collapse flams and flag the odd hit; the played take survives">
          Clean up
        </button>
        <button type="button" className={btn} onClick={onSuggest} title="Variations built only from the hits you played">
          Suggest patterns
        </button>
      </div>

      <p className="mt-1.5 text-xs text-chalk-dim max-w-[640px]">
        Played: <span className="font-mono text-chalk">{take.hits.length}</span> hits over{" "}
        <span className="font-mono text-chalk">{take.bars}</span> {take.bars === 1 ? "bar" : "bars"}, on average{" "}
        <span className="font-mono text-chalk">{looseness(take).toFixed(1)}</span> ms off the 16th.
        {cleaned && ` ${describeCleanup(cleaned)}`}
      </p>

      {cleaned && cleaned.changes.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-0.5 max-h-[140px] overflow-y-auto text-xs text-chalk-dim" aria-label="What cleanup changed">
          {cleaned.changes.map((change, i) => (
            <li key={i} className={cx("truncate", change.kind === "flagged" && "text-chalk")} title={change.note}>
              <span className="font-mono">{change.fromS.toFixed(3)}s</span> pad {change.pad + 1} — {change.note}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Which take to keep">
        <TakeOption id="played" chosen={chosen} onChoose={onChoose} label={`Played (${take.hits.length})`} title="The take exactly as you played it" />
        {cleaned && <TakeOption id="cleaned" chosen={chosen} onChoose={onChoose} label={`Cleaned (${cleaned.hits.length})`} title={describeCleanup(cleaned)} />}
        {variations.map((v) => (
          <TakeOption key={v.id} id={v.id} chosen={chosen} onChoose={onChoose} label={`${v.name} (${v.hits.length})`} title={`${v.why} — ${v.derivation.join(" ")}`} />
        ))}
      </div>

      {variations.length > 0 && (
        <p className="mt-1.5 text-xs text-chalk-dim max-w-[640px]">
          Every variation is your own hits, rearranged: {variations[0]?.derivation[0]} Nothing here was invented from a description.
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className={btnPrimary} disabled={!canKeep} onClick={onKeep} title={canKeep ? "Put this take on a track in the session" : "Nothing to put in the session yet"}>
          Keep it in the session
        </button>
        {sessionNote && <span className="text-xs text-chalk-dim max-w-[420px]">{sessionNote}</span>}
      </div>
    </section>
  );
}

function TakeOption({ id, chosen, onChoose, label: text, title }: { id: TakeChoice; chosen: TakeChoice; onChoose: (id: TakeChoice) => void; label: string; title: string }) {
  return (
    <button
      type="button"
      onClick={() => onChoose(id)}
      className={cx(btnQuiet, "border rounded-sm px-2", chosen === id ? "border-pad text-pad" : "border-rule")}
      aria-pressed={chosen === id}
      title={title}
    >
      {text}
    </button>
  );
}
