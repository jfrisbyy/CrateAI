"use client";

// The Stems tab: pick a model, separate, watch the job, then the stems as
// rows (each a library file with its own analysis) with play, Open and
// Loop this stem. Re-separating with another model adds a group.

import { useMemo, useState } from "react";
import { StemList } from "@/components/stems/StemList";
import { isInFlight, jobStatusText, paramOf } from "@/components/stems/jobStatus";
import { useStems } from "@/components/stems/useStems";
import { btnPrimary, btnQuiet, cx, label, select } from "@/components/ui";
import { api } from "@/lib/api/client";
import { DEFAULT_STEM_MODEL, STEM_MODELS, type StemModelId } from "@/lib/api/stems";
import { useSurface } from "./surfaceState";

export function StemsTab() {
  const s = useSurface();
  const { file, jobs } = s;
  const stems = useStems(file.id, jobs);
  const [model, setModel] = useState<StemModelId>(DEFAULT_STEM_MODEL);
  const [playError, setPlayError] = useState<string | null>(null);
  const chosen = STEM_MODELS.find((m) => m.id === model) ?? STEM_MODELS[0]!;

  const stemJobs = useMemo(() => jobs.filter((j) => j.kind === "stems"), [jobs]);
  const inFlight = stemJobs.filter(isInFlight);
  const sameModelRunning = inFlight.some((j) => paramOf(j, "model") === model);
  const lastFailed = !inFlight.length && stemJobs[0]?.status === "failed" ? stemJobs[0] : undefined;
  const canSeparate = file.status !== "uploading" && !sameModelRunning;

  const stopTransport = () => {
    s.waveRef.current?.pause();
    s.stopLoop();
  };

  return (
    <div className="flex flex-col">
      <div className="px-4 py-2 border-b border-rule flex flex-wrap items-center gap-x-4 gap-y-2">
        <label htmlFor="stem-model" className={label}>
          Model
        </label>
        <select id="stem-model" value={model} onChange={(e) => setModel(e.target.value as StemModelId)} className={cx(select, "font-mono")}>
          {STEM_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.id}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={btnPrimary}
          disabled={!canSeparate}
          onClick={() => void stems.separate(model)}
          title={sameModelRunning ? "This model is already running on the file" : `Separate into ${chosen.stems.join(", ")}`}
        >
          Separate
        </button>
        {inFlight.map((j) => (
          <span key={j.id} className="text-xs text-chalk-dim">
            <span className="font-mono text-chalk">{String(paramOf(j, "model") ?? "stems")}</span> {jobStatusText(j)}
          </span>
        ))}
        {lastFailed && (
          <span className="text-xs flex items-center gap-2">
            <span className="font-mono">{String(paramOf(lastFailed, "model") ?? "stems")}</span> {jobStatusText(lastFailed)}
            <button type="button" className={btnQuiet} onClick={() => void api.jobs.retry(lastFailed.id)}>
              Retry
            </button>
          </span>
        )}
      </div>
      <p className="px-4 pt-2 text-xs text-chalk-dim max-w-[640px]">
        {chosen.describe} Each stem lands in the library as its own file and gets its own analysis.
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
            : "No stems yet. Pick a model and press Separate; then open a stem and loop just that part."}
        </p>
      ) : (
        <StemList stems={stems.stems} onBeforePlay={stopTransport} onError={setPlayError} />
      )}
    </div>
  );
}
