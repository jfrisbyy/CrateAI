"use client";

// The stems as rows grouped by model: name, analysis state (live from the
// library store), duration, BPM and key with their confidence, play, Open,
// and Loop this stem (opens the stem's own surface on its Loops tab).

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { fileTitle, statusText } from "@/components/library/FileRow";
import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { btn, btnQuiet, cx } from "@/components/ui";
import { api } from "@/lib/api/client";
import { baseModelOf, isStandInModel, stemOrderIndex, vitalsOf, type FileVitals, type StemWithFile } from "@/lib/api/stems";
import { fmtBpm, fmtDuration } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { useLibrary } from "@/lib/state/LibraryProvider";
import { FilePlayButton } from "./FilePlayButton";
import { openFile } from "./navigate";

export interface StemGroup {
  model: string;
  standIn: boolean;
  stems: StemWithFile[];
}

/** Newest model first; stems in the canonical order inside a group. */
export function groupStems(stems: readonly StemWithFile[]): StemGroup[] {
  const groups = new Map<string, StemWithFile[]>();
  for (const s of stems) {
    const list = groups.get(s.model);
    if (list) list.push(s);
    else groups.set(s.model, [s]);
  }
  return [...groups.entries()]
    .map(([model, rows]) => ({
      model,
      standIn: isStandInModel(model),
      newest: rows.reduce((m, r) => (r.created_at > m ? r.created_at : m), ""),
      stems: [...rows].sort((a, b) => stemOrderIndex(a.stem) - stemOrderIndex(b.stem)),
    }))
    .sort((a, b) => (a.newest < b.newest ? 1 : a.newest > b.newest ? -1 : 0))
    .map(({ model, standIn, stems: rows }) => ({ model, standIn, stems: rows }));
}

export function StemList({ stems, onBeforePlay, onError }: { stems: StemWithFile[]; onBeforePlay: () => void; onError: (message: string) => void }) {
  const groups = useMemo(() => groupStems(stems), [stems]);
  return (
    <div>
      {groups.map((g) => (
        <section key={g.model} aria-label={g.model}>
          <h2 className="px-4 pt-3 pb-1 text-xs text-chalk-dim flex items-baseline gap-2">
            <span className="font-mono text-chalk">{baseModelOf(g.model)}</span>
            {g.standIn && <span>development stand-in, not a separation model</span>}
          </h2>
          <ul>
            {g.stems.map((stem) => (
              <StemRowView key={stem.id} stem={stem} onBeforePlay={onBeforePlay} onError={onError} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function StemRowView({ stem, onBeforePlay, onError }: { stem: StemWithFile; onBeforePlay: () => void; onError: (message: string) => void }) {
  const lib = useLibrary();
  const router = useRouter();
  const live = lib.fileById(stem.stem_file_id);
  const jobs = lib.jobsForFile(stem.stem_file_id);
  const status = live ? statusText(live, jobs) : { text: stem.file?.status ?? "missing", failed: stem.file === null, queued: false };
  const vitals: FileVitals | null = live ? vitalsOf(live.report) : (stem.file?.vitals ?? null);
  const duration = live?.duration_s ?? stem.file?.duration_s ?? null;
  const name = live ? fileTitle(live) : (stem.file?.original_filename ?? stem.stem);
  const failedJob = jobs.find((j) => j.status === "failed");
  const runningJob = jobs.find((j) => j.status === "running");
  const gone = !live && stem.file === null;

  return (
    <li className="relative border-b border-rule px-4 py-1.5 grid grid-cols-[28px_minmax(0,1fr)_auto] gap-x-3 items-center">
      <FilePlayButton fileId={stem.stem_file_id} label={stem.stem} disabled={gone} onStart={onBeforePlay} onError={onError} />
      <div className="min-w-0">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-sm">{stem.stem}</span>
          <span className="text-xs text-chalk-dim truncate" title={name}>
            {name}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs text-chalk-dim">
          <span className={cx(status.failed && "text-chalk")}>{gone ? "file missing" : status.text}</span>
          <span className="font-mono">{fmtDuration(duration)}</span>
          <span className="font-mono flex items-center gap-1">
            {vitals?.bpm !== null && vitals?.bpm !== undefined ? (
              <>
                <span className="text-chalk">{fmtBpm(vitals.bpm)}</span>
                <ConfidenceDot confidence={vitals.bpm_confidence} />
              </>
            ) : (
              <span className="text-chalk-faint">—</span>
            )}
          </span>
          <span className="font-mono flex items-center gap-1">
            {vitals?.key ? (
              <>
                <span className="text-chalk">{displayKey(vitals.key.tonic, vitals.key.mode)}</span>
                <ConfidenceDot confidence={vitals.key_confidence} />
              </>
            ) : (
              <span className="text-chalk-faint">—</span>
            )}
          </span>
          {failedJob && !runningJob && (
            <button type="button" className={btnQuiet} onClick={() => void api.jobs.retry(failedJob.id)}>
              Retry analysis
            </button>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button type="button" className={btnQuiet} disabled={gone} onClick={() => openFile(router, stem.stem_file_id)} title="Open this stem on the surface">
          Open
        </button>
        <button type="button" className={btn} disabled={gone} onClick={() => openFile(router, stem.stem_file_id, "loops")} title="Open this stem on its Loops tab">
          Loop this stem
        </button>
      </div>
      {runningJob && (
        <div className="absolute left-0 right-0 bottom-0 h-px bg-rule" aria-hidden>
          <div className="h-px bg-pad transition-[width] duration-300" style={{ width: `${Math.round(Math.max(0.03, runningJob.progress ?? 0.03) * 100)}%` }} />
        </div>
      )}
    </li>
  );
}
