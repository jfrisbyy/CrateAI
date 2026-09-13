// Hybrid library search (BUILD_PACKET section 12, Phase 6).
//
//   query -> rules parser -> (Claude structured parser when free text remains)
//         -> structured filters   -> library_filter
//         -> text                 -> compute /embed_text -> search_embeddings (same filters)
//         -> "like this"          -> similar_files
//         -> merge: vector hits by similarity, then filter-only hits
//
// When compute is unreachable or has no embedder the search falls back to
// filters plus a name match and says so in `note`. Every dependency is
// injected so the tests run without Supabase, compute or the model.

import type { FileKind, FileRow, SearchEmbeddingsArgs, SimilarFilesArgs, TagRow, VectorMatch } from "@/lib/types/db";
import { mergeParsed, parseWithClaude, type ParseClient } from "./claudeParser";
import { EmbedUnavailableError, type EmbedResult } from "./embedText";
import { mergeHits, passesFilters, fileTagNames, type SearchHit } from "./merge";
import { parseQuery, type ParsedQuery } from "./parse";
import { expandTags } from "./vocabulary";

/** The full argument list of the library_filter RPC after the search migration. */
export interface LibraryFilterFullArgs {
  p_bpm_min?: number | null;
  p_bpm_max?: number | null;
  p_tonic?: string | null;
  p_mode?: string | null;
  p_kind?: string | null;
  p_limit?: number | null;
  p_has_drums?: boolean | null;
  p_is_loop_based?: boolean | null;
  p_tags?: string[] | null;
  p_text?: string | null;
}

export interface HybridDeps {
  libraryFilter(args: LibraryFilterFullArgs): Promise<FileRow[]>;
  searchEmbeddings(args: SearchEmbeddingsArgs): Promise<VectorMatch[]>;
  similarFiles(args: SimilarFilesArgs): Promise<VectorMatch[]>;
  getFiles(ids: string[]): Promise<FileRow[]>;
  getTags(fileIds: string[]): Promise<TagRow[]>;
  /** how many of the caller's files carry an embedding (0 means text search cannot work yet) */
  countEmbeddings(): Promise<number>;
  embedText(texts: string[]): Promise<EmbedResult>;
  /** null when ANTHROPIC_API_KEY is not set: the rules parser stands alone */
  parseClient: ParseClient | null;
}

export interface HybridOptions {
  limit?: number;
  kind?: FileKind;
  /** the open file, for "like this" */
  currentFileId?: string | null;
}

export type SearchMode = "vector" | "filters";

export interface HybridSearchResult {
  results: SearchHit[];
  parsed: ParsedQuery;
  mode: SearchMode;
  /** why the search ran in filters mode, when it did not run as asked */
  note: string | null;
}

export const DEFAULT_LIMIT = 50;
export const TEXT_FALLBACK_NOTE = "text search needs the embed job / compute";

/** Rules first; Claude only when free text remains and a client exists. */
export async function hybridParse(query: string, parseClient: ParseClient | null): Promise<ParsedQuery> {
  const rules = parseQuery(query);
  if (!parseClient || !rules.text_query) return rules;
  const claude = await parseWithClaude(query, parseClient);
  return mergeParsed(rules, claude);
}

function hardFilters(parsed: ParsedQuery): Pick<LibraryFilterFullArgs, "p_bpm_min" | "p_bpm_max" | "p_tonic" | "p_mode" | "p_kind" | "p_has_drums" | "p_is_loop_based"> {
  return {
    p_bpm_min: parsed.bpm_min,
    p_bpm_max: parsed.bpm_max,
    p_tonic: parsed.tonic,
    p_mode: parsed.mode,
    p_kind: parsed.kind,
    p_has_drums: parsed.has_drums,
    p_is_loop_based: parsed.is_loop_based,
  };
}

function hasHardFilters(parsed: ParsedQuery): boolean {
  return parsed.bpm_min !== null || parsed.tonic !== null || parsed.kind !== null || parsed.has_drums !== null || parsed.is_loop_based !== null;
}

function unionFiles(a: FileRow[], b: FileRow[]): FileRow[] {
  const seen = new Set(a.map((f) => f.id));
  return [...a, ...b.filter((f) => !seen.has(f.id))];
}

export async function hybridSearch(query: string, opts: HybridOptions, deps: HybridDeps): Promise<HybridSearchResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, 200));
  const parsed = await hybridParse(query, deps.parseClient);
  if (opts.kind) parsed.kind = opts.kind;
  if (parsed.similar) parsed.similar_to_file_id = opts.currentFileId ?? null;

  const hard = hardFilters(parsed);
  const anyHard = hasHardFilters(parsed);
  let vector: VectorMatch[] = [];
  let mode: SearchMode = "filters";
  let note: string | null = null;
  let similarSource: string | null = null;

  if (parsed.similar) {
    if (!parsed.similar_to_file_id) {
      note = "\"like this\" needs an open file; open one and search again";
    } else {
      similarSource = parsed.similar_to_file_id;
      vector = await deps.similarFiles({ p_file_id: parsed.similar_to_file_id, p_limit: limit });
      if (vector.length === 0) {
        note = "that file has no embedding yet; run the embed job and search again";
      } else {
        mode = "vector";
      }
    }
  } else if (parsed.text_query) {
    try {
      const embedded = await deps.countEmbeddings();
      if (embedded === 0) throw new EmbedUnavailableError("no files are embedded yet");
      const emb = await deps.embedText([parsed.text_query]);
      const vec = emb.vectors[0];
      if (!vec) throw new EmbedUnavailableError("compute returned no vector");
      vector = await deps.searchEmbeddings({ p_query: vec, p_model: emb.model, p_limit: limit, ...hard, p_kind: parsed.kind, p_mode: parsed.mode });
      mode = "vector";
    } catch (err) {
      const reason = err instanceof EmbedUnavailableError ? err.reason : err instanceof Error ? err.message : String(err);
      note = `${TEXT_FALLBACK_NOTE} (${reason}); showing filter and name matches`;
      mode = "filters";
    }
  }

  // Filter-only hits: always in filters mode; in vector mode only when the
  // query had structured filters, so files without an embedding still show.
  let filtered: FileRow[] = [];
  if (mode === "filters" || anyHard) {
    const textForNames = mode === "filters" ? parsed.text_query : null;
    filtered = await deps.libraryFilter({ ...hard, p_limit: limit, p_text: textForNames });
    if (mode === "filters" && parsed.tags.length > 0) {
      const byTag = await deps.libraryFilter({ ...hard, p_limit: limit, p_tags: expandTags(parsed.tags) });
      filtered = unionFiles(filtered, byTag);
    }
    if (mode === "filters" && textForNames && filtered.length === 0 && anyHard) {
      // the words matched no name; the structured filters alone are still the answer
      filtered = await deps.libraryFilter({ ...hard, p_limit: limit });
    }
  }

  // the file "like this" refers to is never its own neighbour
  if (similarSource) filtered = filtered.filter((f) => f.id !== similarSource);
  const vectorIds = vector.map((v) => v.file_id).filter((id) => id !== similarSource);
  vector = vector.filter((v) => v.file_id !== similarSource);
  const need = vectorIds.filter((id) => !filtered.some((f) => f.id === id));
  const fetched = need.length > 0 ? await deps.getFiles(need) : [];
  const filesById = new Map<string, FileRow>();
  for (const f of [...filtered, ...fetched]) filesById.set(f.id, f);
  const tagRows = filesById.size > 0 ? await deps.getTags([...filesById.keys()]) : [];

  if (similarSource) {
    // similar_files takes no filters; apply the parsed ones here
    vector = vector.filter((v) => {
      const f = filesById.get(v.file_id);
      return f ? passesFilters(f, parsed, fileTagNames(f, tagRows)) : false;
    });
  }

  const results = mergeHits({ vector, filtered, filesById, tagRows, parsed, limit, nameMatch: mode === "filters" });
  return { results, parsed, mode, note };
}
