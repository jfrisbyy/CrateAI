"use client";

// Search state shared between the top-bar box and the library list.

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { api, errorMessage } from "@/lib/api/client";
import type { ParsedQuery } from "@/lib/search/parse";
import type { FileRow } from "@/lib/types/db";

export interface SearchState {
  query: string;
  active: boolean;
  loading: boolean;
  error: string | null;
  results: FileRow[];
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
  const [parsed, setParsed] = useState<ParsedQuery | null>(null);
  const seq = useRef(0);

  const run = useCallback(async (q: string) => {
    const trimmed = q.trim();
    setQuery(trimmed);
    if (!trimmed) {
      setResults([]);
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
    setParsed(null);
    setError(null);
    setLoading(false);
  }, []);

  const value = useMemo<SearchState>(
    () => ({ query, active: query.length > 0, loading, error, results, parsed, run, clear }),
    [query, loading, error, results, parsed, run, clear],
  );
  return <SearchContext.Provider value={value}>{children}</SearchContext.Provider>;
}

export function useSearch(): SearchState {
  const ctx = useContext(SearchContext);
  if (!ctx) throw new Error("useSearch must be used inside SearchProvider");
  return ctx;
}
