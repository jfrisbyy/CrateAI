"use client";

// The Chops tab: chop three ways, play the file on the keyboard as an
// instrument (components/keyboard), tap a pattern against a count-in and keep
// the feel as MIDI, extract MIDI from the audio, and download the kit.

import { useMemo } from "react";
import { ChopControls } from "@/components/chops/ChopControls";
import { ChopList } from "@/components/chops/ChopList";
import { MidiPanel } from "@/components/chops/MidiPanel";
import { useChops } from "@/components/chops/useChops";
import { useMidi } from "@/components/chops/useMidi";
import { usePads } from "@/components/chops/usePads";
import { KeyboardPanel } from "@/components/keyboard/KeyboardPanel";
import { useKit } from "@/components/keyboard/useKit";
import { jobToShow } from "@/components/stems/jobStatus";
import { useStems } from "@/components/stems/useStems";
import { btnQuiet } from "@/components/ui";
import { errorMessage } from "@/lib/api/client";
import { applyOrder, bindPads } from "@/lib/pads/bindings";
import { padCountOfKit } from "@/lib/pads/kit";
import { useSurface } from "./surfaceState";

/** OPEN_QUESTIONS B.8: the hip-hop prior, used only when the file has no tempo yet. */
const DEFAULT_BPM = 90;

export function ChopsTab() {
  const s = useSurface();
  const { file, jobs, report, grid, cursor } = s;
  const chops = useChops(file.id, jobs);
  const stems = useStems(file.id, jobs);
  const midi = useMidi(file.id, jobs);
  const kitState = useKit();
  // File order first, then the kit's own order over the top: the kit's order is
  // always read against the file-order indices, so ordering twice cannot compose
  // into something neither the producer nor the machine asked for.
  const baseBindings = useMemo(() => bindPads(chops.chops, stems.stems, padCountOfKit(kitState.kit)), [chops.chops, stems.stems, kitState.kit]);
  const bindings = useMemo(() => applyOrder(baseBindings, kitState.kit.order), [baseBindings, kitState.kit.order]);
  const pads = usePads(bindings, kitState.kit);
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
        <div className="px-4 py-3 w-[420px] shrink-0 border-r border-rule">
          <KeyboardPanel
            fileId={file.id}
            fileName={file.original_filename}
            report={report}
            bpm={bpm}
            bpmMeasured={report?.tempo !== null && report?.tempo !== undefined}
            beatsPerBar={grid.beatsPerBar}
            cursor={cursor}
            chops={chops.chops}
            bindings={bindings}
            baseBindings={baseBindings}
            kitState={kitState}
            pads={pads}
            canChop={canChop}
            onChop={(body) => void chops.chop(body)}
            onSavedMidi={midi.add}
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
