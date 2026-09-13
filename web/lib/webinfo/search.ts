// web_search: the provider behind the 24-hour cache. Returns titles,
// snippets and URLs; the caller attaches them as citations.

import { cacheKey, type WebCache } from "./cache";
import type { SearchProvider, SearchResult } from "./types";
import { WebInfoError } from "./types";

export interface SearchDeps {
  provider: SearchProvider | null;
  /** why `provider` is null, for the error message */
  providerReason?: string | null;
  cache: WebCache;
}

export interface SearchOutcome {
  results: SearchResult[];
  cached: boolean;
  provider: string;
}

export const MAX_QUERY_CHARS = 400;

export async function webSearch(rawQuery: string, deps: SearchDeps): Promise<SearchOutcome> {
  const query = rawQuery.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
  if (!query) throw new WebInfoError("The search query is empty.");
  if (!deps.provider) {
    throw new WebInfoError(`Web search isn't configured: ${deps.providerReason ?? "set WEB_SEARCH_PROVIDER and its API key"}.`);
  }
  const provider = deps.provider.name;
  const key = cacheKey(provider, "search", query);
  const hit = await deps.cache.get(key);
  if (hit && Array.isArray(hit.response)) {
    return { results: hit.response as SearchResult[], cached: true, provider };
  }
  const results = await deps.provider.search(query);
  await deps.cache.set({ key, provider, kind: "search", query, response: results });
  return { results, cached: false, provider };
}
