"use client";

// Left pane: upload zone, upload queue, the library grouped by kind (or
// search results when a query is active).

import { usePathname, useRouter } from "next/navigation";
import { useMemo } from "react";
import { useSearch } from "@/components/shell/searchState";
import { describeParsed } from "@/lib/search/parse";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { FileKind, FileRow as FileRowType } from "@/lib/types/db";
import { FileRow } from "./FileRow";
import { UploadQueue } from "./UploadQueue";
import { UploadZone } from "./UploadZone";

const GROUPS: ReadonlyArray<{ kind: FileKind; title: string }> = [
  { kind: "original", title: "Originals" },
  { kind: "stem", title: "Stems" },
  { kind: "chop", title: "Chops" },
  { kind: "loop_render", title: "Loops" },
  { kind: "layer_render", title: "Layers" },
  { kind: "revoice_render", title: "Re-voices" },
];

export function LibraryPane() {
  const { files, jobs, uploads } = useLibrary();
  const search = useSearch();
  const router = useRouter();
  const pathname = usePathname();
  const selectedId = pathname.startsWith("/f/") ? pathname.slice(3).split("/")[0] ?? null : null;

  const jobsByFile = useMemo(() => {
    const map = new Map<string, typeof jobs>();
    for (const j of jobs) {
      if (!j.file_id) continue;
      const list = map.get(j.file_id);
      if (list) list.push(j);
      else map.set(j.file_id, [j]);
    }
    return map;
  }, [jobs]);

  const grouped = useMemo(() => {
    const byKind = new Map<FileKind, FileRowType[]>();
    for (const f of files) {
      const list = byKind.get(f.kind);
      if (list) list.push(f);
      else byKind.set(f.kind, [f]);
    }
    return GROUPS.map((g) => ({ ...g, files: byKind.get(g.kind) ?? [] })).filter((g) => g.files.length > 0);
  }, [files]);

  const open = (id: string) => router.push(`/f/${id}`);
  const row = (f: FileRowType) => (
    <FileRow key={f.id} file={f} jobs={jobsByFile.get(f.id) ?? []} selected={f.id === selectedId} onOpen={() => open(f.id)} />
  );

  return (
    <div className="flex flex-col min-h-0 h-full">
      <UploadZone />
      <div className="mt-3 flex-1 min-h-0 overflow-y-auto">
        <UploadQueue />
        {search.active ? (
          <section aria-label="Search results">
            <div className="px-4 h-8 flex items-center justify-between text-xs text-chalk-dim border-b border-rule">
              <span className="truncate">
                {search.loading ? "Searching" : `${search.results.length} result${search.results.length === 1 ? "" : "s"}`}
                {search.parsed && describeParsed(search.parsed).length > 0 && (
                  <span className="font-mono ml-2">{describeParsed(search.parsed).join(", ")}</span>
                )}
              </span>
            </div>
            {search.error && <p className="px-4 py-2 text-sm">{search.error}</p>}
            {!search.loading && !search.error && search.results.length === 0 && (
              <p className="px-4 py-3 text-sm text-chalk-dim">
                Nothing matched. Filters work on analyzed files; try a wider range like &quot;80-95&quot;.
              </p>
            )}
            <ul>{search.results.map(row)}</ul>
          </section>
        ) : files.length === 0 && uploads.length === 0 ? (
          <p className="px-4 py-3 text-sm text-chalk-dim">
            The library is empty. Drop a folder of samples above; each file is hashed, checked against what you already
            have, uploaded, and analyzed.
          </p>
        ) : (
          grouped.map((g) => (
            <section key={g.kind} aria-label={g.title}>
              <div className="px-4 h-8 flex items-center justify-between text-xs text-chalk-dim border-b border-rule sticky top-0 bg-graphite">
                <span>{g.title}</span>
                <span className="font-mono">{g.files.length}</span>
              </div>
              <ul>{g.files.map(row)}</ul>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
