// Web information tools (BUILD_PACKET section 13). Reading only: search for
// information, fetch a page for citation, build the queries a producer would
// run for a track. Nothing here can turn a URL into audio or a `files` row
// (principle 3), and a test greps this directory to keep it that way.

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type ProviderName = "brave" | "tavily";

export interface SearchProvider {
  readonly name: ProviderName;
  search(query: string): Promise<SearchResult[]>;
}

export interface FetchedPage {
  url: string;
  title: string;
  text: string;
  fetched_at: string;
}

export type FetchStage = "url" | "robots" | "request" | "redirect" | "content_type";

export type FetchOutcome =
  | { ok: true; page: FetchedPage; cached: boolean }
  | { ok: false; reason: string; stage: FetchStage };

export type FindingKind = "producer" | "sample" | "sampled_by" | "interview" | "gear";

export interface Citation {
  url: string;
  title: string;
}

export interface Finding {
  kind: FindingKind;
  /** one sentence, taken from the snippet as it was written */
  text: string;
  citation: Citation;
}

/** The file fields identify_context reads. Never the audio, never the storage path. */
export interface IdentifyInput {
  original_filename: string;
  title: string | null;
  artist: string | null;
}

export interface IdentifyResult {
  identified: boolean;
  artist: string | null;
  title: string | null;
  queries: string[];
  findings: Finding[];
  searches_run: number;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface WebInfo {
  readonly provider: ProviderName | null;
  search(query: string): Promise<{ results: SearchResult[]; cached: boolean }>;
  fetchPage(url: string): Promise<FetchOutcome>;
  identifyContext(file: IdentifyInput): Promise<IdentifyResult>;
}

/** Search is unavailable (no provider configured, provider error). Callers turn it into "I couldn't search". */
export class WebInfoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebInfoError";
  }
}

export const USER_AGENT = "CrateAI/0.1 (reads pages for citations, never media)";
