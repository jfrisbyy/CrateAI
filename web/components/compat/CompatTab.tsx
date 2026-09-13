"use client";

// The Fits with tab: "what in my crate works with this?"
//
// Compatibility is not similarity. The library already answers "sounds like
// this" with CLAP; this answers the question a producer asks over and over --
// what else that I already own can I put under this, and what would it take.
// Two measured things decide it: whether the grids meet (tempo, octave-folded,
// so 85 and 170 count as one) and whether the harmony works (key, in order of
// strength). Every row says which, and every claim carries the confidence of the
// measurement it rests on.

import { useState } from "react";
import { CompatRow } from "@/components/compat/CompatRow";
import { SHIFT_CHOICES, STRETCH_CHOICES, useCompat } from "@/components/compat/useCompat";
import { btnQuiet, label, segment, segmentItem } from "@/components/ui";
import { fmtBpm } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { useSurface } from "@/components/surface/surfaceState";
import type { Mode } from "@/lib/types/report";

// The tab switch is the `crateai:tab` window event SurfaceTabs listens for
// (TAB_EVENT there; spelled out here so this module does not import the tab
// registry that imports it).
const TAB_EVENT = "crateai:tab";

export function CompatTab() {
  const surface = useSurface();
  const { file, report } = surface;
  const ready = file.status === "ready" && report !== null;
  const [playError, setPlayError] = useState<string | null>(null);
  const c = useCompat(file.id, ready, () => window.dispatchEvent(new CustomEvent(TAB_EVENT, { detail: "layers" })));
  const source = c.data?.source ?? null;
  const matches = c.data?.matches ?? [];

  // auditioning a match should not fight the file playing on the waveform
  const stopTransport = () => {
    surface.waveRef.current?.pause();
    surface.stopLoop();
  };

  return (
    <div className="flex flex-col">
      <div className="px-4 py-2 border-b border-rule flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className={label}>Stretch</span>
          <div className={segment} role="group" aria-label="Stretch tolerance">
            {STRETCH_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                className={segmentItem}
                data-active={c.settings.stretch === choice.id}
                aria-pressed={c.settings.stretch === choice.id}
                title={choice.title}
                onClick={() => c.setSettings({ ...c.settings, stretch: choice.id })}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={label}>Pitch shift</span>
          <div className={segment} role="group" aria-label="Pitch shift allowed">
            {SHIFT_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                className={segmentItem}
                data-active={c.settings.shift === choice.id}
                aria-pressed={c.settings.shift === choice.id}
                title={choice.title}
                onClick={() => c.setSettings({ ...c.settings, shift: choice.id })}
              >
                {choice.label}
              </button>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-chalk-dim select-none" title="A drum break has no key, so it fits anything harmonically">
          <input
            type="checkbox"
            checked={c.settings.includeKeyless}
            onChange={(e) => c.setSettings({ ...c.settings, includeKeyless: e.target.checked })}
          />
          Include material with no key
        </label>
        <button type="button" className={btnQuiet} onClick={() => void c.reload()} disabled={c.loading || !ready}>
          {c.loading ? "Looking" : "Refresh"}
        </button>
      </div>

      <p className="px-4 pt-2 text-xs text-chalk-dim max-w-[680px] flex flex-wrap items-baseline gap-x-2">
        <span>Matching against</span>
        {source?.bpm !== null && source?.bpm !== undefined ? (
          <span className="font-mono text-chalk flex items-baseline gap-1">
            {fmtBpm(source.bpm)} BPM
            <ConfidenceDot confidence={source.bpm_confidence} />
          </span>
        ) : (
          <span className="font-mono">no tempo</span>
        )}
        {source?.tonic && source.mode ? (
          <span className="font-mono text-chalk flex items-baseline gap-1">
            {displayKey(source.tonic, source.mode as Mode)}
            <ConfidenceDot confidence={source.key_confidence} />
          </span>
        ) : (
          <span className="font-mono">no key</span>
        )}
        <span>
          on this file. Half-time and double-time count as the same grid, and a file with no key fits anything. A match is one click from being a
          layer lane.
        </span>
      </p>

      {(c.actionError || playError) && (
        <p role="alert" className="mx-4 mt-2 text-xs border-l-2 border-pad pl-2 flex items-center gap-2">
          {c.actionError ?? playError}
          <button
            type="button"
            className={btnQuiet}
            onClick={() => {
              c.clearActionError();
              setPlayError(null);
            }}
          >
            Dismiss
          </button>
        </p>
      )}

      {!ready ? (
        <p className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">
          This file has not been analyzed yet. Compatibility is measured, not guessed, so there is nothing to match on until the tempo and key are in.
        </p>
      ) : c.error ? (
        <p className="px-4 py-3 text-sm">
          Could not look for matches: {c.error}{" "}
          <button type="button" className={btnQuiet} onClick={() => void c.reload()}>
            Retry
          </button>
        </p>
      ) : c.loading && !c.data ? (
        <p className="px-4 py-3 text-sm text-chalk-dim">Looking through the library.</p>
      ) : matches.length === 0 ? (
        <p className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">
          {c.data?.note ?? "Nothing in the library fits this one yet. Widen the stretch or the pitch shift, or bring in more material."}
        </p>
      ) : (
        <>
          <p className="px-4 pb-2 pt-1 text-xs text-chalk-dim">
            <span className="font-mono text-chalk">{matches.length}</span> {matches.length === 1 ? "file fits" : "files fit"}, out of{" "}
            <span className="font-mono">{c.data?.considered ?? 0}</span> the database put in range.
            {c.data?.note ? ` ${c.data.note}` : ""}
          </p>
          <ul>
            {matches.map((match) => (
              <CompatRow
                key={match.file.id}
                match={match}
                layering={c.layering === match.file.id}
                onLayer={() => void c.layerWith(match.file.id)}
                onBeforePlay={stopTransport}
                onError={setPlayError}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
