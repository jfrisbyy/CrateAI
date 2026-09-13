"use client";

// The library search box (Phase 6). Runs the shell's search state (which
// fills the library pane) and, for the same query, the hybrid route directly
// to show the parsed filters as chips and the matched report fields on a
// short results list under the box. The route memoizes a query for 30 s, so
// the second request costs no second parse or embed.

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useSearch } from "@/components/shell/searchState";
import { btnQuiet, cx, input } from "@/components/ui";
import { queueEmbeddings, searchLibrary, type LibrarySearchResponse } from "@/lib/api/search";
import { errorMessage } from "@/lib/api/client";
import { fmtBpm, fmtNumber } from "@/lib/format";
import type { Matched } from "@/lib/search/merge";
import type { ParsedQuery } from "@/lib/search/parse";

function chips(p: ParsedQuery): string[] {
  const out: string[] = [];
  if (p.bpm_min !== null && p.bpm_max !== null) out.push(`${p.bpm_min}–${p.bpm_max} BPM`);
  if (p.tonic && p.mode) out.push(`${p.tonic} ${p.mode}`);
  if (p.kind) out.push(p.kind);
  if (p.has_drums === false) out.push("no drums");
  if (p.has_drums === true) out.push("drums");
  if (p.is_loop_based) out.push("loop-based");
  if (p.similar) out.push(p.similar_to_file_id ? "like the open file" : "like this (open a file)");
  for (const t of p.tags) out.push(`#${t}`);
  if (p.text_query) out.push(`"${p.text_query}"`);
  return out;
}

function matchedParts(m: Matched): string[] {
  const out: string[] = [];
  if (m.bpm !== undefined) out.push(`${fmtBpm(m.bpm)} BPM`);
  if (m.key) out.push(m.key);
  if (m.kind) out.push(m.kind);
  if (m.tags && m.tags.length > 0) out.push(m.tags.join(", "));
  if (m.has_drums === false) out.push("no drums");
  if (m.has_drums === true) out.push("drums");
  if (m.is_loop_based) out.push("loop-based");
  if (m.name) out.push("name");
  return out;
}

export function SearchBox() {
  const search = useSearch();
  const router = useRouter();
  const pathname = usePathname();
  const openFileId = pathname.startsWith("/f/") ? (pathname.slice(3).split("/")[0] ?? null) : null;
  const [text, setText] = useState("");
  const [details, setDetails] = useState<LibrarySearchResponse | null>(null);
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [embedding, setEmbedding] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    if (!search.active) {
      setText("");
      setDetails(null);
      setOpen(false);
    }
  }, [search.active]);

  const run = async (q: string) => {
    const trimmed = q.trim();
    void search.run(trimmed);
    if (!trimmed) {
      setDetails(null);
      setOpen(false);
      return;
    }
    const mine = ++seq.current;
    setNote(null);
    try {
      const res = await searchLibrary({ query: trimmed, limit: 8, current_file_id: openFileId });
      if (mine !== seq.current) return;
      setDetails(res);
      setOpen(true);
    } catch (err) {
      if (mine !== seq.current) return;
      setNote(errorMessage(err));
      setOpen(true);
    }
  };

  const embedMissing = async () => {
    setEmbedding("queueing");
    try {
      const res = await queueEmbeddings();
      setEmbedding(res.queued.length > 0 ? `queued ${res.queued.length} embed job${res.queued.length === 1 ? "" : "s"}${res.dispatch_failures > 0 ? " (compute not reachable)" : ""}` : "nothing to embed");
    } catch (err) {
      setEmbedding(errorMessage(err));
    }
  };

  const parsed = details?.parsed ?? search.parsed;
  const showEmbed = details?.mode === "filters" && details.note !== null && /embed/.test(details.note);

  return (
    <form
      role="search"
      className="relative flex items-center gap-2 w-full max-w-[520px]"
      onSubmit={(e) => {
        e.preventDefault();
        void run(text);
      }}
    >
      <label htmlFor="library-search" className="sr-only">
        Search the library
      </label>
      <input
        id="library-search"
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => details && setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (open) setOpen(false);
            else {
              setText("");
              search.clear();
            }
          }
        }}
        placeholder='Search: "dusty in F minor around 85 with horns, no drums", "kind:stem", "like this"'
        className={cx(input, "w-full")}
        autoComplete="off"
        spellCheck={false}
      />
      {search.active && (
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            search.clear();
          }}
          className="text-xs text-chalk-dim hover:text-chalk whitespace-nowrap"
        >
          Clear
        </button>
      )}
      {open && (details || note) && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-graphite border border-rule rounded-sm text-xs shadow-none" role="region" aria-label="Search details">
          {parsed && (
            <div className="px-2 py-1.5 border-b border-rule flex flex-wrap items-center gap-1">
              {chips(parsed).length === 0 && <span className="text-chalk-dim">no filters recognized; searching by name and sound</span>}
              {chips(parsed).map((c) => (
                <span key={c} className="inline-flex items-center h-5 px-1.5 border border-rule rounded-sm font-mono text-chalk-dim">
                  {c}
                </span>
              ))}
              {details && (
                <span className="ml-auto font-mono text-chalk-faint" title={details.parsed.parser}>
                  {details.mode}
                </span>
              )}
            </div>
          )}
          {(note || details?.note) && (
            <div className="px-2 py-1.5 border-b border-rule flex items-center justify-between gap-2 text-chalk-dim">
              <span className="truncate">{note ?? details?.note}</span>
              {showEmbed && (
                <button type="button" className={btnQuiet} onClick={() => void embedMissing()} disabled={embedding === "queueing"}>
                  {embedding ?? "Embed library"}
                </button>
              )}
            </div>
          )}
          {details && (
            <ul className="max-h-[40vh] overflow-y-auto">
              {details.results.length === 0 && <li className="px-2 py-1.5 text-chalk-dim">Nothing matched.</li>}
              {details.results.map((r) => (
                <li key={r.file.id} className="border-b border-rule last:border-b-0">
                  <button
                    type="button"
                    className="w-full text-left px-2 py-1 grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 hover:bg-slate"
                    onClick={() => {
                      setOpen(false);
                      router.push(`/f/${r.file.id}`);
                    }}
                  >
                    <span className="truncate">
                      {r.file.title?.trim() || r.file.original_filename}
                      <span className="ml-2 font-mono text-chalk-dim">{matchedParts(r.matched).join(" · ")}</span>
                    </span>
                    <span className="font-mono text-chalk-dim">{r.similarity !== undefined ? fmtNumber(r.similarity, 2) : r.file.kind}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  );
}
