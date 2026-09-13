"use client";

// Enrollment in three steps (kick, snare, hat): record about 20 hits per
// class, upload each take, then Train. The compute segments the recordings,
// trains the per-user classifier, and reports cross-validated accuracy;
// under 85 % the profile stays disabled and the message says to record more.

import { useCallback, useMemo, useState } from "react";
import { isActive, jobText, RetryButton, useJobDone } from "@/components/layers/shared";
import { btnPrimary, btnQuiet } from "@/components/ui";
import { beatboxApi, DEFAULT_CLASSES, MIN_ACCURACY, TARGET_HITS_PER_CLASS, trainResultOf } from "@/lib/api/beatbox";
import { errorMessage } from "@/lib/api/client";
import { uploadRecording } from "@/lib/beatbox/upload";
import { fmtDuration, fmtPercent } from "@/lib/format";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { BeatboxProfileRow, JobRow } from "@/lib/types/db";
import { Recorder, type Recorded } from "./Recorder";

interface Take {
  id: string;
  cls: string;
  storage_path: string;
  hits: number;
  duration_s: number | null;
  format: string;
}

const HINTS: Record<string, string> = {
  kick: 'a low "boom" or "puh" from the chest',
  snare: 'a sharp "pss" or "kah"',
  hat: 'a short "ts" between the teeth',
};

function isTrainJob(job: JobRow): boolean {
  return job.kind === "beatbox_train";
}

export function Enrollment({ profile, onTrained }: { profile: BeatboxProfileRow | null; onTrained: () => void }) {
  const lib = useLibrary();
  const classes = useMemo(() => Array.from(new Set([...DEFAULT_CLASSES, ...(profile?.classes ?? [])])), [profile]);
  const [takes, setTakes] = useState<Take[]>([]);
  const [uploading, setUploading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = jobId ? lib.jobs.find((j) => j.id === jobId) : undefined;
  const result = trainResultOf(job);
  const trained = useCallback(() => onTrained(), [onTrained]);
  useJobDone(lib.jobs, isTrainJob, trained);

  const onRecorded = async (cls: string, r: Recorded) => {
    setUploading(cls);
    setError(null);
    try {
      const up = await uploadRecording(r.blob, `${cls}-${Date.now()}`);
      setTakes((prev) => [...prev, { id: up.storage_path, cls, storage_path: up.storage_path, hits: r.hits, duration_s: up.duration_s ?? r.durationMs / 1000, format: up.format }]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setUploading(null);
    }
  };

  const train = async () => {
    setError(null);
    try {
      const res = await beatboxApi.train({ examples: takes.map((t) => ({ class: t.cls, storage_path: t.storage_path })) });
      lib.upsertJob(res.job);
      setJobId(res.job.id);
      if (res.dispatch && !res.dispatch.ok) setError(`Training queued, but ${res.dispatch.reason}.`);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const hitsFor = (cls: string) => takes.filter((t) => t.cls === cls).reduce((sum, t) => sum + t.hits, 0);
  const busy = uploading !== null || isActive(job);
  const canTrain = DEFAULT_CLASSES.every((c) => takes.some((t) => t.cls === c)) && !busy;

  return (
    <section aria-label="Enrollment" className="border-b border-rule">
      <div className="px-4 py-2 border-b border-rule flex flex-wrap items-baseline gap-x-3 text-xs text-chalk-dim">
        <span className="text-chalk text-sm">1. Enroll</span>
        <span>
          Record about <span className="font-mono text-chalk">{TARGET_HITS_PER_CLASS}</span> hits of each sound, one after another with a short gap. The recording is converted to
          WAV in the browser and cut into examples by the compute.
        </span>
      </div>
      <ol>
        {classes.map((cls, i) => {
          const own = takes.filter((t) => t.cls === cls);
          return (
            <li key={cls} className="border-b border-rule px-4 py-2 grid grid-cols-[120px_minmax(0,1fr)] gap-x-4 items-start">
              <div>
                <div className="text-sm">
                  {i + 1}. {cls}
                </div>
                <div className="font-mono text-xs text-chalk-dim">
                  <span className={hitsFor(cls) >= TARGET_HITS_PER_CLASS ? "text-chalk" : ""}>{hitsFor(cls)}</span> / {TARGET_HITS_PER_CLASS} hits
                </div>
              </div>
              <div className="flex flex-col gap-1 min-w-0">
                <Recorder targetHits={TARGET_HITS_PER_CLASS} disabled={busy} onRecorded={(r) => void onRecorded(cls, r)} label={`Record ${cls}`} />
                {uploading === cls && <span className="text-xs text-chalk-dim">converting to WAV and uploading</span>}
                {own.map((t) => (
                  <div key={t.id} className="text-xs text-chalk-dim font-mono flex items-center gap-2">
                    take: {t.hits} hits, {fmtDuration(t.duration_s)}, {t.format}
                    <button type="button" className={btnQuiet} onClick={() => setTakes((prev) => prev.filter((x) => x.id !== t.id))} disabled={busy}>
                      remove
                    </button>
                  </div>
                ))}
                {own.length === 0 && HINTS[cls] && <span className="text-xs text-chalk-dim">Try {HINTS[cls]}.</span>}
              </div>
            </li>
          );
        })}
      </ol>
      <div className="px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <button type="button" className={btnPrimary} disabled={!canTrain} onClick={() => void train()} title="Train the per-user classifier on the uploaded takes">
          Train
        </button>
        {job && isActive(job) && <span className="text-chalk-dim">training {jobText(job)}</span>}
        {job?.status === "failed" && (
          <span className="flex items-center gap-2">
            training {jobText(job)} <RetryButton job={job} onRetried={lib.upsertJob} />
          </span>
        )}
        {result && (
          <span className="font-mono">
            cross-validated accuracy <span className="text-chalk">{fmtPercent(result.cv_accuracy)}</span>
            {result.enabled ? ": profile enabled" : `: under ${fmtPercent(MIN_ACCURACY)}, record more examples`}
            {Object.keys(result.per_class_counts).length > 0 && (
              <span className="text-chalk-dim">
                {" "}
                ({Object.entries(result.per_class_counts)
                  .map(([k, v]) => `${k} ${v}`)
                  .join(", ")}
                )
              </span>
            )}
          </span>
        )}
        {!result && !job && <span className="text-chalk-dim">Train needs at least one take for each of kick, snare and hat{profile ? "; a new training replaces the current profile" : ""}.</span>}
        {error && <span role="alert">{error}</span>}
      </div>
    </section>
  );
}
