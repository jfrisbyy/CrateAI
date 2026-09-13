"use client";

// The picker for a new lane: ready files from the library (the open file
// first), with their vitals, filtered by name.

import { useMemo, useState } from "react";
import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { btnQuiet, cx, input } from "@/components/ui";
import { fmtBpm, fmtDuration } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { effective } from "@/lib/report/effective";
import { useLibrary } from "@/lib/state/LibraryProvider";

export function AddLanePicker({
  currentFileId,
  inLayer,
  onPick,
  onClose,
}: {
  currentFileId: string;
  inLayer: Set<string>;
  onPick: (fileId: string) => void;
  onClose: () => void;
}) {
  const lib = useLibrary();
  const [query, setQuery] = useState("");
  const files = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lib.files
      .filter((f) => f.status === "ready")
      .filter((f) => q === "" || (f.title ?? "").toLowerCase().includes(q) || f.original_filename.toLowerCase().includes(q))
      .sort((a, b) => (a.id === currentFileId ? -1 : b.id === currentFileId ? 1 : (a.title ?? a.original_filename).localeCompare(b.title ?? b.original_filename)))
      .slice(0, 200);
  }, [lib.files, query, currentFileId]);

  return (
    <div className="border-b border-rule bg-slate">
      <div className="px-4 h-9 flex items-center gap-3 border-b border-rule">
        <span className="text-xs text-chalk-dim">Add a lane from the library</span>
        <input
          className={cx(input, "h-6 w-[220px]")}
          placeholder="Filter by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter files"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
        />
        <button type="button" className={cx(btnQuiet, "ml-auto")} onClick={onClose}>
          Close
        </button>
      </div>
      {files.length === 0 ? (
        <p className="px-4 py-3 text-sm text-chalk-dim">No ready files match. Lanes need analyzed files; upload or wait for analysis.</p>
      ) : (
        <ul className="max-h-[240px] overflow-y-auto">
          {files.map((f) => {
            const report = f.report ? effective(f.report) : null;
            const tempo = report?.tempo ?? null;
            const key = report?.key ?? null;
            return (
              <li key={f.id} className="border-b border-rule last:border-b-0">
                <button type="button" className="w-full text-left px-4 py-1 hover:bg-graphite grid grid-cols-[minmax(0,1fr)_80px_88px_100px_48px] items-baseline gap-x-3 text-xs" onClick={() => onPick(f.id)}>
                  <span className="truncate text-sm" title={f.original_filename}>
                    {f.title?.trim() || f.original_filename}
                    {f.id === currentFileId && <span className="ml-2 text-chalk-dim text-xs">open now</span>}
                  </span>
                  <span className="text-chalk-dim">{f.kind.replace("_", " ")}</span>
                  <span className="font-mono flex items-center gap-1 justify-end">
                    {tempo ? (
                      <>
                        {fmtBpm(tempo.bpm)}
                        <ConfidenceDot confidence={tempo.confidence} />
                      </>
                    ) : (
                      <span className="text-chalk-faint">—</span>
                    )}
                  </span>
                  <span className="font-mono flex items-center gap-1 justify-end">
                    {key ? (
                      <>
                        {displayKey(key.tonic, key.mode)}
                        <ConfidenceDot confidence={key.confidence} />
                      </>
                    ) : (
                      <span className="text-chalk-faint">—</span>
                    )}
                  </span>
                  <span className="font-mono text-chalk-dim text-right">{inLayer.has(f.id) ? "in" : fmtDuration(f.duration_s)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
