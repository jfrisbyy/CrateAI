// The hybrid search wired to the request: RPCs through the caller's session
// client (RLS), compute through the dispatch env, Claude through the shared
// client. Server only.

import "server-only";

import { getAnthropic, hasAnthropicKey } from "@/lib/anthropic/client";
import { serverEnv } from "@/lib/env";
import type { ServerSupabase } from "@/lib/supabase/server";
import type { LibraryFilterArgs } from "@/lib/types/db";
import type { ParseClient } from "./claudeParser";
import { embedText } from "./embedText";
import { hybridSearch, type HybridDeps, type HybridOptions, type HybridSearchResult } from "./hybrid";
import { TtlMemo } from "./memo";

const MEMO_TTL_MS = 30_000;
const memo = new TtlMemo<HybridSearchResult>(MEMO_TTL_MS);

function parseClient(): ParseClient | null {
  if (!hasAnthropicKey()) return null;
  return {
    parse: (params) => getAnthropic().messages.parse(params),
  };
}

export function createHybridDeps(supabase: ServerSupabase): HybridDeps {
  return {
    async libraryFilter(args) {
      // the RPC gained four optional parameters in the search migration; the
      // hand-written Args type (lib/types/db.ts) still lists the first six
      const { data, error } = await supabase.rpc("library_filter", args as LibraryFilterArgs);
      if (error) throw new Error(`library_filter: ${error.message}`);
      return data;
    },
    async searchEmbeddings(args) {
      const { data, error } = await supabase.rpc("search_embeddings", args);
      if (error) throw new Error(`search_embeddings: ${error.message}`);
      return data;
    },
    async similarFiles(args) {
      const { data, error } = await supabase.rpc("similar_files", args);
      if (error) throw new Error(`similar_files: ${error.message}`);
      return data;
    },
    async getFiles(ids) {
      if (ids.length === 0) return [];
      const { data, error } = await supabase.from("files").select("*").in("id", ids);
      if (error) throw new Error(`files: ${error.message}`);
      return data;
    },
    async getTags(fileIds) {
      if (fileIds.length === 0) return [];
      const { data, error } = await supabase.from("tags").select("*").in("file_id", fileIds).limit(2000);
      if (error) throw new Error(`tags: ${error.message}`);
      return data;
    },
    async countEmbeddings() {
      const { count, error } = await supabase.from("embeddings").select("id", { count: "exact", head: true });
      if (error) throw new Error(`embeddings: ${error.message}`);
      return count ?? 0;
    },
    embedText: (texts) =>
      embedText(texts, {
        baseUrl: serverEnv("COMPUTE_DISPATCH_URL"),
        secret: serverEnv("COMPUTE_DISPATCH_SECRET"),
        fetcher: (input, init) => fetch(input, init),
      }),
    parseClient: parseClient(),
  };
}

/** The route's entry point: one parse and one embed per user, query and window. */
export async function runLibrarySearch(supabase: ServerSupabase, userId: string, query: string, opts: HybridOptions): Promise<HybridSearchResult> {
  const key = JSON.stringify([userId, query.trim().toLowerCase(), opts.limit ?? null, opts.kind ?? null, opts.currentFileId ?? null]);
  const hit = memo.get(key);
  if (hit) return hit;
  const result = await hybridSearch(query, opts, createHybridDeps(supabase));
  memo.set(key, result);
  return result;
}
