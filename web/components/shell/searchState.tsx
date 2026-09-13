"use client";

// Search state shared between the top-bar box and the library list.

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "@/lib/api/client";
import type { SearchMode } from "@/lib/search/hybrid";
import type { SearchHit } from "@/lib/search/merge";
import type { ParsedQuery } from "@/lib/search/parse";
import type { FileRow } from "@/lib/types/db";

export interface SearchState {
  query: string;
  active: boolean;
  loading: boolean;
  error: string | null;
  results: FileRow[];
  /** the same rows with the report fields that matched, in rank order */
  hits: SearchHit[];
  mode: SearchMode | null;
  note: string | null;
  parsed: ParsedQuery | null;
  run: (query: string) => Promise<void>;
  clear: () => void;
}

const SearchContext = createContext<SearchState | null>(null);

export function SearchProvider({ children }: { children: ReactNode }) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<FileRow[]>([]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [mode, setMode] = useState<SearchMode | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedQuery | null>(null);
  const seq = useRef(0);

  const run = useCallback(async (q: string) => {
    const trimmed = q.trim();
    setQuery(trimmed);
    if (!trimmed) {
      setResults([]);
      setHits([]);
      setMode(null);
      setNote(null);
      setParsed(null);
      setError(null);
      return;
    }
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const res = await api.search({ query: trimmed });
      if (mine !== seq.current) return;
      setResults(res.files);
      setHits(res.results);
      setMode(res.mode);
      setNote(res.note);
      setParsed(res.parsed);
    } catch (err) {
      if (mine !== seq.current) return;
      setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  const clear = useCallback(() => {
    seq.current++;
    setQuery("");
    setResults([]);
    setHits([]);
    setMode(null);
    setNote(null);
    setParsed(null);
    setError(null);
    setLoading(false);
  }, []);

  const value = useMemo<SearchState>(
    () => ({ query, active: query.length > 0, loading, error, results, hits, mode, note, parsed, run, clear }),
    [query, loading, error, results, hits, mode, note, parsed, run, clear],
  );
  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
}

export function useSearch(): SearchState {
  const ctx = useContext(SearchContext);
  if (!ctx) throw new Error("useSearch must be used inside SearchProvider");
  return ctx;
}
