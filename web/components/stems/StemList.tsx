"use client";

// The stems as rows grouped by the separation that made them: what it was, how
// good it is, then each stem's name, analysis state (live from the library
// store), duration, BPM and key with their confidence, play, Open, and Loop
// this stem (opens the stem's own surface on its Loops tab).
//
// The group header carries the quality, because separation is the irreversible
// step and a producer who cannot see which tier made a stem has no way to know
// why one sounds soft. A published SDR is never shown without the sentence
// saying what the number is — a bare "9.0" is worse than nothing.

import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { fileTitle, statusText } from "@/components/library/FileRow";
import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { btn, btnQuiet, cx } from "@/components/ui";
import { api } from "@/lib/api/client";
import { modelSpec, qualityOf, stemOrderIndex, vitalsOf, type FileVitals, type StemQuality, type StemWithFile } from "@/lib/api/stems";
import { fmtBpm, fmtDuration } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { useLibrary } from "@/lib/state/LibraryProvider";
import { FilePlayButton } from "./FilePlayButton";
import { openFile } from "./navigate";

export interface StemGroup {
  model: string;
  quality: StemQuality;
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
      quality: qualityOf(rows[0]!),
      newest: rows.reduce((m, r) => (r.created_at > m ? r.created_at : m), ""),
      stems: [...rows].sort((a, b) => stemOrderIndex(a.stem) - stemOrderIndex(b.stem)),
    }))
    .sort((a, b) => (a.newest < b.newest ? 1 : a.newest > b.newest ? -1 : 0))
    .map(({ model, quality, stems: rows }) => ({ model, quality, stems: rows }));
}

export function StemList({ stems, onBeforePlay, onError }: { stems: StemWithFile[]; onBeforePlay: () => void; onError: (message: string) => void }) {
  const groups = useMemo(() => groupStems(stems), [stems]);
  return (
    <div>
      {groups.map((g) => (
        <section key={g.model} aria-label={g.model}>
          <SeparationHeader model={g.model} quality={g.quality} stems={g.stems.length} />
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

/**
 * What made these stems, and how far to trust them.
 *
 * The tier leads, because that is the part a producer can act on; the model id
 * is there for someone who wants it. An untrusted separation (a stand-in, a
 * weak or baseline model, or a row from before the quality columns existed)
 * says so where it cannot be missed rather than in a tooltip.
 */
export function SeparationHeader({ model, quality, stems }: { model: string; quality: StemQuality; stems: number }) {
  const spec = modelSpec(model);
  return (
    <h2 className="px-4 pt-3 pb-1 text-xs text-chalk-dim">
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={cx("text-chalk", quality.untrusted && "text-pad")}>{quality.tier.replace("_", " ")}</span>
        <span className="font-mono">{spec?.id ?? model}</span>
        {quality.sdr !== null && quality.sdrBasis && (
          <span title={quality.sdrBasis}>
            {quality.sdr.toFixed(2)} dB SDR<span className="sr-only"> — {quality.sdrBasis}</span>
          </span>
        )}
        <span className="sr-only">{stems} stems</span>
      </span>
      <span className={cx("block max-w-[640px] pt-0.5", quality.untrusted && "text-pad")}>{quality.note}</span>
    </h2>
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
