"use client";

// The Compare tab (BUILD_PACKET section 11, Compare): this file against a
// second one from the library, same structure side by side, with the deltas.
// The open file is "mine", the picked one "the reference".

import { useMemo } from "react";
import { isPending, jobStatusText } from "@/components/breakdown/jobStatus";
import { ComparisonView } from "@/components/compare/ComparisonView";
import { useComparison } from "@/components/compare/useComparison";
import { fileTitle } from "@/components/library/FileRow";
import { btnPrimary, btnQuiet, label, select } from "@/components/ui";
import { fmtBpm } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { effective } from "@/lib/report/effective";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { FileRow } from "@/lib/types/db";
import { useSurface } from "./surfaceState";

function optionText(f: FileRow): string {
  const report = f.report ? effective(f.report) : null;
  const parts = [fileTitle(f)];
  if (f.kind !== "original") parts.push(f.kind.replace("_", " "));
  if (report?.tempo) parts.push(`${fmtBpm(report.tempo.bpm)} BPM`);
  if (report?.key) parts.push(displayKey(report.key.tonic, report.key.mode));
  return parts.join(", ");
}

export function CompareTab() {
  const s = useSurface();
  const lib = useLibrary();
  const { file } = s;
  const c = useComparison(file.id);
  const ready = file.status === "ready" && s.report !== null;

  const candidates = useMemo(
    () =>
      lib.files
        .filter((f) => f.id !== file.id && f.status === "ready" && f.report !== null)
        .sort((a, b) => (a.kind === b.kind ? fileTitle(a).localeCompare(fileTitle(b)) : a.kind === "original" ? -1 : b.kind === "original" ? 1 : 0)),
    [lib.files, file.id],
  );
  const reference = c.referenceId ? lib.fileById(c.referenceId) : undefined;
  const pending = isPending(c.job);

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2">
          <span className={label}>Reference</span>
          <select
            className={`${select} max-w-[360px]`}
            value={c.referenceId ?? ""}
            onChange={(e) => c.setReferenceId(e.target.value || null)}
            aria-label="Reference file"
          >
            <option value="">pick a file from the library</option>
            {candidates.map((f) => (
              <option key={f.id} value={f.id}>
                {optionText(f)}
              </option>
            ))}
            {reference && !candidates.some((f) => f.id === reference.id) && (
              <option value={reference.id}>{optionText(reference)}</option>
            )}
          </select>
        </div>
        <button
          type="button"
          className={btnPrimary}
          disabled={!ready || !c.referenceId || pending}
          onClick={() => void c.run()}
          title={ready ? "Compare this file (mine) against the reference" : "Available once this file is analyzed"}
        >
          {c.comparison ? "Compare again" : "Compare"}
        </button>
        {c.job && c.job.status !== "done" && <span className="text-xs text-chalk-dim">comparison {jobStatusText(c.job)}</span>}
        {c.job?.status === "failed" && (
          <button type="button" className={btnQuiet} onClick={() => void c.retry()}>
            Retry
          </button>
        )}
      </div>

      {c.error && (
        <p role="alert" className="mt-2 text-xs border-l-2 border-pad pl-2 flex items-center gap-2">
          {c.error}
          <button type="button" className={btnQuiet} onClick={c.clearError}>
            Dismiss
          </button>
        </p>
      )}

      {c.loading ? (
        <p className="mt-3 text-sm text-chalk-dim">Loading.</p>
      ) : c.comparison ? (
        <div className="mt-3">
          <ComparisonView content={c.comparison.content} aTitle={fileTitle(file)} bTitle={reference ? fileTitle(reference) : "the reference"} />
        </div>
      ) : (
        <p className="mt-3 text-sm text-chalk-dim max-w-[560px]">
          {candidates.length === 0
            ? "Compare needs a second analyzed file in the library. Upload one, or wait for analysis to finish."
            : c.referenceId
              ? pending
                ? "Comparing."
                : "Press Compare to see this file (mine) against the reference: tempo, key, swing, structure, chops, drums, bass, chords and mix, with the deltas."
              : "Pick a second file and press Compare. This file is mine; the one you pick is the reference."}
        </p>
      )}
    </div>
  );
}
