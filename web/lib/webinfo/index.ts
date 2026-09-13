// The web information tools wired to the environment: the provider from
// WEB_SEARCH_PROVIDER and its key, the web_cache table through the service
// role, robots.txt cached per host in this process, and the platform fetch.
// Server only (it reaches the admin client through supabaseCache.ts).

import { fetchPage } from "./fetchPage";
import { identifyContext } from "./identify";
import { providerFromEnv } from "./providers";
import { RobotsCache } from "./robots";
import { webSearch } from "./search";
import { createWebCache } from "./supabaseCache";
import type { Fetcher, WebInfo } from "./types";

let robots: RobotsCache | null = null;

export function createWebInfo(): WebInfo {
  const fetcher: Fetcher = (input, init) => fetch(input, init);
  const { provider, reason } = providerFromEnv(
    {
      WEB_SEARCH_PROVIDER: process.env.WEB_SEARCH_PROVIDER,
      BRAVE_SEARCH_API_KEY: process.env.BRAVE_SEARCH_API_KEY,
      TAVILY_API_KEY: process.env.TAVILY_API_KEY,
    },
    fetcher,
  );
  const cache = createWebCache();
  robots ??= new RobotsCache(fetcher);
  const robotsCache = robots;
  const search = (query: string) => webSearch(query, { provider, providerReason: reason, cache });
  return {
    provider: provider?.name ?? null,
    async search(query) {
      const out = await search(query);
      return { results: out.results, cached: out.cached };
    },
    fetchPage: (url) => fetchPage(url, { fetcher, robots: robotsCache, cache }),
    identifyContext: (file) => identifyContext(file, { search: async (q) => (await search(q)).results }),
  };
}

export type { FetchOutcome, Finding, IdentifyInput, IdentifyResult, SearchResult, WebInfo } from "./types";
export { WebInfoError } from "./types";
