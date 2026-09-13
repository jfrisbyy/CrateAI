"use client";

// Transcription: beatbox a pattern against a free tempo or a library file's
// grid; the compute classifies the hits with the profile, keeps the measured
// offsets, and writes MIDI plus the step view. Corrections are saved from
// the step view for the next enrollment.

import { useCallback, useEffect, useMemo, useState } from "react";
import { NumberField } from "@/components/layers/fields";
import { isActive, jobText, RetryButton, useJobDone } from "@/components/layers/shared";
import { btnQuiet, cx, label, segment, segmentItem, select } from "@/components/ui";
import { beatboxApi, DEFAULT_CLASSES, transcriptionMetaOf, type Transcription as TranscriptionRow } from "@/lib/api/beatbox";
import { errorMessage } from "@/lib/api/client";
import { hitsOf } from "@/lib/beatbox/stepview";
import { uploadRecording } from "@/lib/beatbox/upload";
import { fmtBpm } from "@/lib/format";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { BeatboxProfileRow, JobRow, MidiRow } from "@/lib/types/db";
import { Recorder, type Recorded } from "./Recorder";
import { StepView } from "./StepView";

function isTranscribeJob(job: JobRow): boolean {
  return job.kind === "beatbox_transcribe";
}

export function Transcription({ profile }: { profile: BeatboxProfileRow | null }) {
  const lib = useLibrary();
  const [mode, setMode] = useState<"free" | "grid">("free");
  const [bpm, setBpm] = useState(90);
  const [gridFileId, setGridFileId] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [list, setList] = useState<TranscriptionRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const job = jobId ? lib.jobs.find((j) => j.id === jobId) : undefined;
  const gridFiles = useMemo(() => lib.files.filter((f) => f.status === "ready" && f.report?.beats), [lib.files]);
  const classes = profile?.classes?.length ? profile.classes : [...DEFAULT_CLASSES];
  const enabled = profile?.enabled === true;

  const load = useCallback(async () => {
    try {
      const res = await beatboxApi.transcriptions();
      setList(res.transcriptions);
      setListError(null);
    } catch (err) {
      setListError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useJobDone(lib.jobs, isTranscribeJob, () => void load());

  const onRecorded = async (r: Recorded) => {
    setUploading(true);
    setError(null);
    try {
      const up = await uploadRecording(r.blob, `pattern-${Date.now()}`);
      const res = await beatboxApi.transcribe({ recording_path: up.storage_path, ...(mode === "grid" ? { grid_file_id: gridFileId } : { bpm }) });
      lib.upsertJob(res.job);
      setJobId(res.job.id);
      if (res.dispatch && !res.dispatch.ok) setError(`Transcription queued, but ${res.dispatch.reason}.`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(false);
    }
  };

  const replaceMidi = (midi: MidiRow) => setList((prev) => (prev ?? []).map((t) => (t.midi.id === midi.id ? { ...t, midi } : t)));
  const gridReady = mode === "free" || gridFileId !== "";
  const disabledReason = !profile ? "Enroll first: the transcription needs your profile." : !enabled ? "Your profile is under 85 % accuracy; record more examples and train again." : !gridReady ? "Pick a file for the grid." : null;

  return (
    <section aria-label="Transcription">
      <div className="px-4 py-2 border-b border-rule flex flex-wrap items-baseline gap-x-3 text-xs text-chalk-dim">
        <span className="text-chalk text-sm">2. Transcribe</span>
        <span>Beatbox a pattern. Hits are placed on the grid with their measured offsets, so the feel survives; the first hit is the one in free tempo.</span>
      </div>
      <div className="px-4 py-2 border-b border-rule flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <div className={segment} role="group" aria-label="Grid source">
          <button type="button" className={segmentItem} data-active={mode === "free"} onClick={() => setMode("free")}>
            Free tempo
          </button>
          <button type="button" className={segmentItem} data-active={mode === "grid"} onClick={() => setMode("grid")}>
            Grid of a file
          </button>
        </div>
        {mode === "free" ? (
          <span className="flex items-center gap-1.5">
            <span className={label}>tempo</span>
            <NumberField value={bpm} min={30} max={300} step={1} digits={1} ariaLabel="Tempo in BPM" widthClass="w-[64px]" onCommit={(v) => setBpm(v ?? 90)} />
            <span className={label}>BPM</span>
          </span>
        ) : (
          <select className={cx(select, "max-w-[320px]")} value={gridFileId} onChange={(e) => setGridFileId(e.target.value)} aria-label="File whose beat grid to use">
            <option value="">pick a ready file</option>
            {gridFiles.map((f) => (
              <option key={f.id} value={f.id}>
                {f.title?.trim() || f.original_filename}
                {f.report?.tempo ? ` (${fmtBpm(f.report.tempo.bpm)} BPM)` : ""}
              </option>
            ))}
          </select>
        )}
        <Recorder disabled={disabledReason !== null || uploading || isActive(job)} onRecorded={(r) => void onRecorded(r)} label="Record pattern" />
        {disabledReason && <span className="text-chalk-dim">{disabledReason}</span>}
        {uploading && <span className="text-chalk-dim">converting and uploading, then transcribing</span>}
        {job && isActive(job) && <span className="text-chalk-dim">transcription {jobText(job)}</span>}
        {job?.status === "failed" && (
          <span className="flex items-center gap-2">
            transcription {jobText(job)} <RetryButton job={job} onRetried={lib.upsertJob} />
          </span>
        )}
        {error && <span role="alert">{error}</span>}
      </div>

      {list === null && !listError ? (
        <p className="px-4 py-3 text-sm text-chalk-dim">Loading transcriptions.</p>
      ) : listError ? (
        <p className="px-4 py-3 text-sm">
          Could not load transcriptions: {listError}{" "}
          <button type="button" className={btnQuiet} onClick={() => void load()}>
            Retry
          </button>
        </p>
      ) : list!.length === 0 ? (
        <p className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">No transcriptions yet. {enabled ? "Press Record pattern, beatbox a bar or two, stop, and the MIDI appears here with its step view." : "Enroll above first."}</p>
      ) : (
        <ul>
          {list!.map((t) => {
            const meta = transcriptionMetaOf(t.midi);
            const gridFile = meta.grid_file_id ? lib.fileById(meta.grid_file_id) : undefined;
            const hits = hitsOf(t.midi.notes);
            return (
              <li key={t.midi.id} className="border-b border-rule">
                <div className="px-4 py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <span className="font-mono">{new Date(t.midi.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                  <span className="font-mono text-chalk-dim">
                    <span className="text-chalk">{hits.length}</span> hits
                  </span>
                  <span className="font-mono text-chalk-dim">{meta.bpm ? `${fmtBpm(meta.bpm)} BPM` : ""}</span>
                  <span className="text-chalk-dim truncate max-w-[280px]">{gridFile ? `grid of ${gridFile.title?.trim() || gridFile.original_filename}` : meta.grid_file_id ? "grid of a file" : "free tempo"}</span>
                  {t.download_url ? (
                    <a href={t.download_url} className={cx(btnQuiet, "ml-auto")} download title="Signed link, 10 minutes">
                      Download MIDI
                    </a>
                  ) : (
                    <span className="ml-auto text-chalk-dim">no download link</span>
                  )}
                </div>
                <StepView key={t.midi.id} midi={t.midi} classes={classes} onSaved={replaceMidi} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
