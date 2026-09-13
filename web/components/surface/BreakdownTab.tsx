"use client";

// The Breakdown tab (BUILD_PACKET section 11): the document, every number
// linked to the waveform, hedged by its confidence; a version switcher; the
// jobs it is waiting on, live; the mentor's narration above the facts, under
// the grounding contract. Empty state says what to do.

import { useCallback, useEffect, useRef, useState } from "react";
import { BreakdownDocument, type FactRef } from "@/components/breakdown/BreakdownDocument";
import { isPending, jobStatusText } from "@/components/breakdown/jobStatus";
import { EMPTY_NARRATION, NarrationPanel, type NarrationView } from "@/components/breakdown/NarrationPanel";
import { useBreakdown } from "@/components/breakdown/useBreakdown";
import { WaveformSpan } from "@/components/breakdown/WaveformSpan";
import { btn, btnPrimary, btnQuiet, cx, label, segment, segmentItem } from "@/components/ui";
import { breakdownApi, readNarrationStream } from "@/lib/api/breakdown";
import { api, errorMessage } from "@/lib/api/client";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { BreakdownRow, JobRow } from "@/lib/types/db";
import { useSurface } from "./surfaceState";

function fromSaved(row: BreakdownRow | null): NarrationView {
  if (!row?.narration?.trim()) return EMPTY_NARRATION;
  return { status: "done", paragraphs: row.narration.split(/\n\n+/), notes: [], source: "saved", error: null };
}

function generatedText(row: BreakdownRow): string {
  const iso = row.content.generated_at || row.created_at;
  return iso.slice(0, 16).replace("T", " ");
}

export function BreakdownTab() {
  const s = useSurface();
  const lib = useLibrary();
  const { file, duration } = s;
  const b = useBreakdown(file.id);
  const ready = file.status === "ready" && s.report !== null;
  const selected = b.selected;

  // ---- waveform links ------------------------------------------------------------
  const [selectedFact, setSelectedFact] = useState<{ key: string; start: number; end: number | null } | null>(null);
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    setSelectedFact(null);
  }, [selectedId]);
  const seek = useCallback(
    (ref: FactRef) => {
      const t = ref.fact.time_s;
      if (t === null || t === undefined) return;
      s.waveRef.current?.setTime(t);
      s.setCursor(t);
      setSelectedFact({ key: ref.key, start: t, end: ref.fact.end_s ?? null });
    },
    [s],
  );

  // ---- narration -------------------------------------------------------------------
  const [narration, setNarration] = useState<NarrationView>(EMPTY_NARRATION);
  const narrationFor = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    // a different version on screen: show its saved narration (or nothing)
    if (narrationFor.current === (selected?.id ?? null)) return;
    abortRef.current?.abort();
    abortRef.current = null;
    narrationFor.current = selected?.id ?? null;
    setNarration(fromSaved(selected));
  }, [selected]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const narrate = useCallback(async () => {
    if (!selected) return;
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;
    narrationFor.current = selected.id;
    setNarration({ status: "streaming", paragraphs: [], notes: [], source: null, error: null });
    try {
      const res = await breakdownApi.narrate(file.id, { version: selected.version }, abort.signal);
      await readNarrationStream(res, (event) => {
        if (abort.signal.aborted) return;
        setNarration((prev) => {
          switch (event.type) {
            case "paragraph":
              return { ...prev, paragraphs: [...prev.paragraphs, event.text] };
            case "note":
              return { ...prev, notes: [...prev.notes, event.text] };
            case "reset":
              return { ...prev, paragraphs: [] };
            case "done":
              return { ...prev, status: "done", source: event.source, paragraphs: event.text ? event.text.split(/\n\n+/) : prev.paragraphs };
            case "error":
              return { ...prev, status: "error", error: event.message };
            default:
              return prev;
          }
        });
      });
      setNarration((prev) => (prev.status === "streaming" ? { ...prev, status: prev.paragraphs.length ? "done" : "error", error: prev.paragraphs.length ? null : "The narration ended without a result." } : prev));
    } catch (err) {
      if (abort.signal.aborted) {
        setNarration((prev) => ({ ...prev, status: prev.paragraphs.length ? "done" : "idle", notes: [...prev.notes, "Stopped."] }));
        return;
      }
      setNarration((prev) => ({ ...prev, status: "error", error: errorMessage(err) }));
    } finally {
      if (abortRef.current === abort) abortRef.current = null;
    }
  }, [selected, file.id]);

  const stopNarration = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // ---- actions on jobs --------------------------------------------------------------
  const retry = useCallback(
    async (job: JobRow) => {
      try {
        const res = await api.jobs.retry(job.id);
        lib.upsertJob(res.job);
      } catch (err) {
        alert(errorMessage(err));
      }
    },
    [lib],
  );

  const composing = isPending(b.breakdownJob);
  const versions = b.rows ?? [];

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          className={versions.length === 0 ? btnPrimary : btn}
          disabled={!ready || composing}
          onClick={() => void b.run()}
          title={ready ? "Compose a new version from what is measured now; queues stems and the Phase 4 stages if they haven't run" : "Available once the file is analyzed"}
        >
          {versions.length === 0 ? "Run breakdown" : "Refresh breakdown"}
        </button>
        {b.breakdownJob && <span className="text-xs text-chalk-dim">composing {jobStatusText(b.breakdownJob)}</span>}
        {b.breakdownJob?.status === "failed" && (
          <button type="button" className={btnQuiet} onClick={() => void retry(b.breakdownJob as JobRow)}>
            Retry
          </button>
        )}

        {versions.length > 1 && (
          <div className="flex items-center gap-2">
            <span className={label}>Version</span>
            <div className={segment} role="group" aria-label="Breakdown version">
              {[...versions].reverse().map((row) => (
                <button
                  key={row.id}
                  type="button"
                  data-active={selected?.id === row.id}
                  className={cx(segmentItem, "font-mono")}
                  onClick={() => b.selectVersion(row.version === versions[0]?.version ? null : row.version)}
                  title={`generated ${generatedText(row)}`}
                >
                  v{row.version}
                </button>
              ))}
            </div>
          </div>
        )}

        {selected && (
          <span className="text-xs text-chalk-dim">
            generated <span className="font-mono text-chalk">{generatedText(selected)}</span>, analysis{" "}
            <span className="font-mono text-chalk">v{selected.content.analysis_version}</span>
            {selected.content.identified && selected.content.title && (
              <>
                , identified as <span className="text-chalk">{selected.content.title}</span>
              </>
            )}
          </span>
        )}
      </div>

      {b.latest && b.waitingOn.length > 0 && (
        <p className="mt-2 text-xs text-chalk-dim border-l-2 border-pad pl-2" role="status">
          waiting on:{" "}
          {b.waitingOn.map((w, i) => (
            <span key={w.requirement}>
              {i > 0 && ", "}
              <span className="text-chalk">{w.requirement}</span>
              {w.job && <span className="font-mono"> {jobStatusText(w.job)}</span>}
            </span>
          ))}
          . The document fills in as they finish.
        </p>
      )}

      {b.error && (
        <p role="alert" className="mt-2 text-xs border-l-2 border-pad pl-2 flex items-center gap-2">
          {b.error}
          <button type="button" className={btnQuiet} onClick={b.clearError}>
            Dismiss
          </button>
        </p>
      )}

      {b.loading ? (
        <p className="mt-3 text-sm text-chalk-dim">Loading the breakdown.</p>
      ) : versions.length === 0 ? (
        <p className="mt-3 text-sm text-chalk-dim max-w-[560px]">
          Run the breakdown to see how this was made.{" "}
          {ready
            ? "It reads the analysis and the stems, queues what hasn't run yet, and links every number to the waveform."
            : "It becomes available when analysis finishes."}
        </p>
      ) : selected ? (
        <div className="mt-3">
          <NarrationPanel view={narration} canNarrate={narration.status !== "streaming"} onNarrate={() => void narrate()} onStop={stopNarration} />
          <BreakdownDocument
            content={selected.content}
            onSeek={seek}
            selectedKey={selectedFact?.key ?? null}
            jobFor={b.jobFor}
            canQueue={b.canQueue}
            onQueue={(job) => void b.queueMissing(job)}
            onRetry={(job) => void retry(job)}
          />
        </div>
      ) : null}

      {selectedFact && selectedFact.end !== null && <WaveformSpan start={selectedFact.start} end={selectedFact.end} duration={duration || (s.waveRef.current?.getDuration() ?? 0)} />}
    </div>
  );
}
