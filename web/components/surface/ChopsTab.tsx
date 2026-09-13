"use client";

// The Chops tab: chop three ways, audition on sixteen pads (1–8, Q–I), tap a
// pattern against a count-in and keep the feel as MIDI, extract MIDI from
// the audio, and download the kit.

import { useMemo } from "react";
import { ChopControls } from "@/components/chops/ChopControls";
import { ChopList } from "@/components/chops/ChopList";
import { MidiPanel } from "@/components/chops/MidiPanel";
import { PadGrid } from "@/components/chops/PadGrid";
import { RecordPanel } from "@/components/chops/RecordPanel";
import { useChops } from "@/components/chops/useChops";
import { useMidi } from "@/components/chops/useMidi";
import { usePads } from "@/components/chops/usePads";
import { jobToShow } from "@/components/stems/jobStatus";
import { useStems } from "@/components/stems/useStems";
import { btnQuiet } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { bindPads } from "@/lib/pads/bindings";
import { useSurface } from "./surfaceState";

/** OPEN_QUESTIONS B.8: the hip-hop prior, used only when the file has no tempo yet. */
const DEFAULT_BPM = 90;

export function ChopsTab() {
  const s = useSurface();
  const { file, jobs, report, grid, cursor } = s;
  const chops = useChops(file.id, jobs);
  const stems = useStems(file.id, jobs);
  const midi = useMidi(file.id, jobs);
  const bindings = useMemo(() => bindPads(chops.chops, stems.stems), [chops.chops, stems.stems]);
  const pads = usePads(bindings);
  const hasPads = bindings.some((b) => b !== null);
  const bpm = report?.tempo?.bpm ?? DEFAULT_BPM;
  const chopJob = jobToShow(jobs, "chop");
  const canChop = file.status !== "uploading";
  const error = chops.actionError ?? midi.actionError;

  return (
    <div className="flex flex-col">
      <ChopControls cursor={cursor} hasGrid={report !== null} canChop={canChop} job={chopJob} onChop={(body) => void chops.chop(body)} />

      {error && (
        <p role="alert" className="mx-4 mt-2 text-xs border-l-2 border-pad pl-2 flex items-center gap-2">
          {error}
          <button
            type="button"
            className={btnQuiet}
            onClick={() => {
              chops.setActionError(null);
              midi.setActionError(null);
            }}
          >
            Dismiss
          </button>
        </p>
      )}

      <div className="flex flex-wrap items-start">
        <div className="px-4 py-3 w-[300px] shrink-0 border-r border-rule">
          <PadGrid bindings={bindings} lit={pads.lit} statuses={pads.statuses} onTrigger={pads.trigger} />
          <p className="mt-1.5 text-xs text-chalk-dim">
            {hasPads
              ? bindings[0]?.source === "chop"
                ? "Pads play the first sixteen chops in order. Keys 1–8 and Q–I."
                : "No chops yet, so the pads play the stems. Keys 1–8 and Q–I."
              : "Pads fill with the file's chops, or its stems until there are chops."}
          </p>
          <RecordPanel
            fileId={file.id}
            bpm={bpm}
            bpmMeasured={report?.tempo !== null && report?.tempo !== undefined}
            beatsPerBar={grid.beatsPerBar}
            recorder={pads.recorder}
            recording={pads.recording}
            bindings={bindings}
            hasPads={hasPads}
            onSaved={midi.add}
          />
        </div>

        <div className="flex-1 min-w-[320px]">
          {chops.loading ? (
            <p className="px-4 py-3 text-sm text-chalk-dim">Loading chops.</p>
          ) : chops.error ? (
            <p className="px-4 py-3 text-sm">
              Could not load chops: {chops.error}{" "}
              <button type="button" className={btnQuiet} onClick={() => void chops.refetch()}>
                Retry
              </button>
            </p>
          ) : chops.chops.length === 0 ? (
            <p className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">
              {chopJob?.status === "queued" || chopJob?.status === "running"
                ? "Chopping. The chops appear here, on the pads, and in the library when the job finishes."
                : "No chops yet. Pick a mode above and press Chop; every chop becomes a library file with its own analysis."}
            </p>
          ) : (
            <ChopList
              chops={chops.chops}
              bindings={bindings}
              isPlaying={pads.isFilePlaying}
              onPlay={(id) => pads.playFile(id).catch((err: unknown) => chops.setActionError(errorMessage(err)))}
              onRename={(id, name) => void chops.rename(id, name)}
            />
          )}
        </div>
      </div>

      <MidiPanel
        fileId={file.id}
        midi={midi.midi}
        loading={midi.loading}
        error={midi.error}
        jobs={jobs}
        canExtract={report !== null && file.status === "ready"}
        canBundle={chops.chops.length > 0 || midi.midi.length > 0}
        onExtract={(kind) => void midi.extract(kind)}
        onRefetch={() => void midi.refetch()}
      />
    </div>
  );
}
