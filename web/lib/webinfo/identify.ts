// identify_context: from a file's title and artist (or a filename that reads
// "Artist - Title"), the searches a producer would run, and the findings with
// their citations. Never fingerprints audio, never fetches media; the audio
// is not even an input here.

import { firstSentence } from "./extract";
import type { Finding, FindingKind, IdentifyInput, IdentifyResult, SearchResult } from "./types";

export const MAX_IDENTIFY_SEARCHES = 5;
const RESULTS_PER_KIND = 3;

export interface Identity {
  artist: string | null;
  title: string | null;
  identified: boolean;
}

function stripExtension(name: string): string {
  return name.replace(/\.[a-z0-9]{2,5}$/i, "");
}

function tidy(s: string): string {
  return s
    .replace(/[_]+/g, " ")
    .replace(/\s*\((?:official|audio|video|lyrics?|hd|hq|remaster(?:ed)?|\d{4}\s*remaster(?:ed)?)[^)]*\)\s*/gi, " ")
    .replace(/\s*\[(?:official|audio|video|lyrics?|hd|hq)[^\]]*\]\s*/gi, " ")
    .replace(/^\s*\d{1,2}\s*[-.]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Title and artist from the row, else from a filename shaped "Artist - Title". */
export function identityOf(file: IdentifyInput): Identity {
  const title = file.title?.trim() || null;
  const artist = file.artist?.trim() || null;
  if (title) return { artist, title, identified: true };
  const stem = tidy(stripExtension(file.original_filename));
  const m = /^(.+?)\s+[-–—]\s+(.+)$/.exec(stem);
  if (m && m[1] && m[2]) {
    const a = m[1].trim();
    const t = m[2].trim();
    if (a.length >= 2 && t.length >= 2 && !/^\d+$/.test(a)) return { artist: a, title: t, identified: true };
  }
  return { artist, title: null, identified: false };
}

export interface PlannedQuery {
  kind: FindingKind;
  query: string;
}

/** The queries, in the order a producer would run them; capped at MAX_IDENTIFY_SEARCHES. */
export function buildQueries(identity: Identity): PlannedQuery[] {
  if (!identity.title) return [];
  const t = identity.title;
  const at = identity.artist ? `${identity.artist} ${t}` : t;
  const planned: PlannedQuery[] = [
    { kind: "producer", query: `${at} producer` },
    { kind: "sample", query: `${t} sample source` },
    { kind: "sampled_by", query: `who sampled ${t}` },
    { kind: "interview", query: `${at} interview production` },
    { kind: "gear", query: `${at} gear` },
  ];
  return planned.slice(0, MAX_IDENTIFY_SEARCHES);
}

export interface IdentifyDeps {
  search: (query: string) => Promise<SearchResult[]>;
}

/** Findings from search results: one sentence each, verbatim from the snippet, always with a URL. */
export function findingsFrom(kind: FindingKind, results: SearchResult[]): Finding[] {
  const out: Finding[] = [];
  for (const r of results.slice(0, RESULTS_PER_KIND)) {
    if (!r.url || !/^https?:\/\//i.test(r.url)) continue;
    const text = firstSentence(r.snippet);
    if (!text) continue;
    out.push({ kind, text, citation: { url: r.url, title: r.title || r.url } });
  }
  return out;
}

export async function identifyContext(file: IdentifyInput, deps: IdentifyDeps): Promise<IdentifyResult> {
  const identity = identityOf(file);
  const planned = buildQueries(identity);
  const findings: Finding[] = [];
  const seen = new Set<string>();
  let searchesRun = 0;
  for (const p of planned) {
    if (searchesRun >= MAX_IDENTIFY_SEARCHES) break;
    searchesRun++;
    let results: SearchResult[] = [];
    try {
      results = await deps.search(p.query);
    } catch {
      continue; // one failed query does not fail the identification
    }
    for (const f of findingsFrom(p.kind, results)) {
      const dedupe = `${f.kind}|${f.citation.url}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      findings.push(f);
    }
  }
  return {
    identified: identity.identified,
    artist: identity.artist,
    title: identity.title,
    queries: planned.map((p) => p.query),
    findings,
    searches_run: searchesRun,
  };
}
