"use client";

// The Stems tab: pick a split, separate, watch the job, then the stems as rows
// (each a library file with its own analysis) with play, Open and Loop this
// stem. Asking for a different split adds a group.
//
// What is offered is the split — which parts you want the record pulled into —
// and never a model id. Separation is the irreversible step: a weak separator
// throws away high frequencies no EQ downstream puts back, so the best
// separator installed that makes those stems is the one that runs, and the
// worker decides because only it knows what is installed in its image. This tab
// used to offer three identifiers, which asked a producer to make a quality
// decision from a string they have no way to evaluate.

import { useMemo, useState } from "react";
import { StemList } from "@/components/stems/StemList";
import { isInFlight, jobStatusText } from "@/components/stems/jobStatus";
import { useStems } from "@/components/stems/useStems";
import { btnPrimary, btnQuiet, label, select } from "@/components/ui";
import { api } from "@/lib/api/client";
import { DEFAULT_SPLIT, describeAsk, describeStems, splitKey, stemsAskOf, STEM_SPLITS, TIER_NOTE } from "@/lib/api/stems";
import { useSurface } from "./surfaceState";

export function StemsTab() {
  const s = useSurface();
  const { file, jobs } = s;
  const stems = useStems(file.id, jobs);
  const [chosen, setChosen] = useState<string>(splitKey(DEFAULT_SPLIT.stems));
  const [playError, setPlayError] = useState<string | null>(null);
  const split = STEM_SPLITS.find((x) => splitKey(x.stems) === chosen) ?? DEFAULT_SPLIT;

  const stemJobs = useMemo(() => jobs.filter((j) => j.kind === "stems"), [jobs]);
  const inFlight = stemJobs.filter(isInFlight);
  const sameSplitRunning = inFlight.some((j) => {
    const asked = stemsAskOf(j.params);
    return asked.stems !== null && splitKey(asked.stems) === splitKey(split.stems);
  });
  const lastFailed = !inFlight.length && stemJobs[0]?.status === "failed" ? stemJobs[0] : undefined;
  const canSeparate = file.status !== "uploading" && !sameSplitRunning;

  const stopTransport = () => {
    s.waveRef.current?.pause();
    s.stopLoop();
  };

  return (
    <div className="flex flex-col">
      <div className="px-4 py-2 border-b border-rule flex flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor="stem-split" className={label}>
          Separate into
        </label>
        <select id="stem-split" value={chosen} onChange={(e) => setChosen(e.target.value)} className={select}>
          {STEM_SPLITS.map((x) => (
            <option key={splitKey(x.stems)} value={splitKey(x.stems)}>
              {describeStems(x.stems)}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={btnPrimary}
          disabled={!canSeparate}
          onClick={() => void stems.separate({ stems: [...split.stems] })}
          title={sameSplitRunning ? "That split is already running on this file" : `Separate into ${describeStems(split.stems)}`}
        >
          Separate
        </button>
        {inFlight.map((j) => (
          <span key={j.id} className="text-xs text-chalk-dim">
            <span className="text-chalk">{describeAsk(stemsAskOf(j.params))}</span> {jobStatusText(j)}
          </span>
        ))}
        {lastFailed && (
          <span className="text-xs flex items-center gap-2">
            <span>{describeAsk(stemsAskOf(lastFailed.params))}</span> {jobStatusText(lastFailed)}
            <button type="button" className={btnQuiet} onClick={() => void api.jobs.retry(lastFailed.id)}>
              Retry
            </button>
          </span>
        )}
      </div>
      <p className="px-4 pt-2 text-xs text-chalk-dim max-w-[640px]">
        The best separator installed that makes those stems runs: {TIER_NOTE[split.bestTier]}. Each stem lands in the
        library as its own file with its own analysis, and every stem says what produced it.
      </p>

      {(stems.actionError || playError) && (
        <p role="alert" className="mx-4 mt-2 text-xs border-l-2 border-pad pl-2 flex items-center gap-2">
          {stems.actionError ?? playError}
          <button
            type="button"
            className={btnQuiet}
            onClick={() => {
              stems.clearActionError();
              setPlayError(null);
            }}
          >
            Dismiss
          </button>
        </p>
      )}

      {stems.loading ? (
        <p className="px-4 py-3 text-sm text-chalk-dim">Loading stems.</p>
      ) : stems.error ? (
        <p className="px-4 py-3 text-sm">
          Could not load stems: {stems.error}{" "}
          <button type="button" className={btnQuiet} onClick={() => void stems.refetch()}>
            Retry
          </button>
        </p>
      ) : stems.stems.length === 0 ? (
        <p className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">
          {inFlight.length > 0
            ? "Separating. The stems appear here, and in the library, when the job finishes."
            : "No stems yet. Choose what to separate into and press Separate; then open a stem and loop just that part."}
        </p>
      ) : (
        <StemList stems={stems.stems} onBeforePlay={stopTransport} onError={setPlayError} />
      )}
    </div>
  );
}
