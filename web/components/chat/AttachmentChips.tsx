"use client";

// The files in this conversation: the open file by default, plus any ready
// file from the library. Chips in a row, mono vitals, the list to attach
// from folds open under them.

import { useMemo, useState } from "react";
import { fileTitle } from "@/components/library/FileRow";
import { btnQuiet, cx, input } from "@/components/ui";
import { fmtBpm } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { effective } from "@/lib/report/effective";
import type { FileRow } from "@/lib/types/db";

function vitals(file: FileRow): string {
  const report = file.report ? effective(file.report) : null;
  const parts: string[] = [];
  if (report?.tempo) parts.push(fmtBpm(report.tempo.bpm));
  if (report?.key) parts.push(displayKey(report.key.tonic, report.key.mode));
  return parts.join(" ");
}

export function AttachmentChips({
  files,
  attached,
  openFileId,
  onToggle,
}: {
  files: FileRow[];
  attached: string[];
  openFileId: string | null;
  onToggle: (id: string, on: boolean) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");
  const byId = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const candidates = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return files
      .filter((f) => f.status === "ready" && !attached.includes(f.id))
      .filter((f) => !needle || fileTitle(f).toLowerCase().includes(needle))
      .slice(0, 40);
  }, [files, attached, filter]);

  return (
    <div className="shrink-0 border-b border-rule px-4 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-chalk-dim">Files</span>
        {attached.length === 0 && <span className="text-chalk-faint">none; open a file or attach one</span>}
        {attached.map((id) => {
          const f = byId.get(id);
          if (!f) return null;
          return (
            <span key={id} className={cx("inline-flex items-center gap-1.5 h-6 pl-2 pr-1 border border-rule rounded-sm max-w-[220px]", id === openFileId && "border-rule-strong")} title={f.original_filename}>
              <span className="truncate">{fileTitle(f)}</span>
              <span className="font-mono text-chalk-dim shrink-0">{vitals(f)}</span>
              <button type="button" className="text-chalk-dim hover:text-chalk px-1" aria-label={`Detach ${fileTitle(f)}`} onClick={() => onToggle(id, false)}>
                ×
              </button>
            </span>
          );
        })}
        <button type="button" className={btnQuiet} onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
          {picking ? "Done" : "Attach"}
        </button>
      </div>
      {picking && (
        <div className="mt-1.5 border-t border-rule pt-1.5">
          {files.filter((f) => f.status === "ready").length > 8 && (
            <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter files" className={cx(input, "w-full mb-1")} aria-label="Filter files to attach" />
          )}
          {candidates.length === 0 ? (
            <p className="text-chalk-dim">No other ready files.</p>
          ) : (
            <ul className="max-h-[30vh] overflow-y-auto">
              {candidates.map((f) => (
                <li key={f.id} className="border-b border-rule last:border-b-0">
                  <button type="button" className="w-full text-left py-1 flex items-baseline justify-between gap-2 hover:text-pad" onClick={() => onToggle(f.id, true)}>
                    <span className="truncate">{fileTitle(f)}</span>
                    <span className="font-mono text-chalk-dim shrink-0">{vitals(f)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
