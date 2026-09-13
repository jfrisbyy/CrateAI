"use client";

// MIDI for the file: queue an extraction (melody, drums, chords, groove),
// the list of .mid rows with Download, and the kit bundle.

import { useState } from "react";
import { isInFlight, jobStatusText, paramOf } from "@/components/stems/jobStatus";
import { btn, btnQuiet, cx } from "@/components/ui";
import { chopsApi } from "@/lib/api/chops";
import { api } from "@/lib/api/client";
import { MIDI_EXTRACT_KINDS, type MidiWithUrl } from "@/lib/api/midi";
import type { JobRow } from "@/lib/types/db";

export function MidiPanel({
  fileId,
  midi,
  loading,
  error,
  jobs,
  canExtract,
  canBundle,
  onExtract,
  onRefetch,
}: {
  fileId: string;
  midi: MidiWithUrl[];
  loading: boolean;
  error: string | null;
  jobs: JobRow[];
  canExtract: boolean;
  canBundle: boolean;
  onExtract: (kind: (typeof MIDI_EXTRACT_KINDS)[number]["id"]) => void;
  onRefetch: () => void;
}) {
  const midiJobs = jobs.filter((j) => j.kind === "midi");
  const inFlight = midiJobs.filter(isInFlight);
  const lastFailed = inFlight.length === 0 && midiJobs[0]?.status === "failed" ? midiJobs[0] : undefined;
  const [bundling, setBundling] = useState(false);
  const [bundleError, setBundleError] = useState<string | null>(null);

  const downloadKit = async () => {
    setBundling(true);
    setBundleError(null);
    try {
      const { blob, filename } = await chopsApi.bundle(fileId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      setBundleError(err instanceof Error ? err.message : String(err));
    } finally {
      setBundling(false);
    }
  };

  return (
    <section aria-label="MIDI" className="border-t border-rule">
      <div className="px-4 py-2 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-sm font-medium">MIDI</span>
        {MIDI_EXTRACT_KINDS.map((k) => {
          const running = inFlight.some((j) => paramOf(j, "kind") === k.id);
          return (
            <button key={k.id} type="button" className={btn} disabled={!canExtract || running} onClick={() => onExtract(k.id)} title={canExtract ? k.describe : "Needs the analysis; it becomes available when the file is ready"}>
              {k.label}
            </button>
          );
        })}
        {inFlight.map((j) => (
          <span key={j.id} className="text-xs text-chalk-dim">
            <span className="font-mono text-chalk">{String(paramOf(j, "kind") ?? "midi")}</span> {jobStatusText(j)}
          </span>
        ))}
        {lastFailed && (
          <span className="text-xs flex items-center gap-2">
            <span className="font-mono">{String(paramOf(lastFailed, "kind") ?? "midi")}</span> {jobStatusText(lastFailed)}
            <button type="button" className={btnQuiet} onClick={() => void api.jobs.retry(lastFailed.id)}>
              Retry
            </button>
          </span>
        )}
        <span className="flex-1" />
        <button type="button" className={btn} disabled={!canBundle || bundling} onClick={() => void downloadKit()} title="A zip of every chop WAV, every .mid and manifest.json">
          {bundling ? "Building kit" : "Download kit"}
        </button>
      </div>
      {bundleError && (
        <p role="alert" className="mx-4 mb-2 text-xs border-l-2 border-pad pl-2">
          {bundleError}
        </p>
      )}

      {loading ? (
        <p className="px-4 pb-3 text-sm text-chalk-dim">Loading MIDI.</p>
      ) : error ? (
        <p className="px-4 pb-3 text-sm">
          Could not load MIDI: {error}{" "}
          <button type="button" className={btnQuiet} onClick={onRefetch}>
            Retry
          </button>
        </p>
      ) : midi.length === 0 ? (
        <p className="px-4 pb-3 text-sm text-chalk-dim max-w-[560px]">No MIDI yet. Extract a part above, or record a pattern on the pads and save it.</p>
      ) : (
        <ul>
          {midi.map((m) => (
            <li key={m.id} className="border-t border-rule px-4 py-1.5 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 items-center">
              <div className="min-w-0 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs">
                <span className="text-sm">{m.kind}</span>
                <span className="font-mono text-chalk-dim truncate">{m.filename}</span>
                <span className="font-mono text-chalk-dim">
                  {noteCount(m.notes)} notes{sourceOf(m.notes) === "pads" ? ", from the pads" : ""}
                </span>
                <span className="font-mono text-chalk-dim">{m.created_at.slice(0, 16).replace("T", " ")}</span>
              </div>
              {m.download_url ? (
                <a href={m.download_url} download={m.filename} className={cx(btnQuiet, "no-underline")}>
                  Download
                </a>
              ) : (
                <span className="text-xs text-chalk-dim">no link</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function noteCount(notes: MidiWithUrl["notes"]): number {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) return 0;
  const list = notes.notes;
  return Array.isArray(list) ? list.length : 0;
}

function sourceOf(notes: MidiWithUrl["notes"]): string | null {
  if (!notes || typeof notes !== "object" || Array.isArray(notes)) return null;
  const meta = notes.meta;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  return typeof meta.source === "string" ? meta.source : null;
}
