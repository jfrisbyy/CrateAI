// Search providers behind one interface (OPEN_QUESTIONS F.24). Brave is the
// default; Tavily is a config change. Both return titles, snippets and URLs
// and nothing else: no media, no downloads.

import { type Fetcher, type ProviderName, type SearchProvider, type SearchResult, USER_AGENT, WebInfoError } from "./types";

export const RESULTS_PER_QUERY = 8;
const TIMEOUT_MS = 10_000;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function clean(results: Array<{ title: unknown; url: unknown; snippet: unknown }>): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  for (const r of results) {
    const url = asString(r.url).trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: asString(r.title).trim() || url, url, snippet: asString(r.snippet).replace(/\s+/g, " ").trim() });
  }
  return out;
}

export function braveProvider(apiKey: string, fetcher: Fetcher): SearchProvider {
  return {
    name: "brave",
    async search(query) {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${RESULTS_PER_QUERY}&text_decorations=false`;
      const res = await fetcher(url, {
        method: "GET",
        headers: { accept: "application/json", "X-Subscription-Token": apiKey, "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new WebInfoError(`Brave search returned ${res.status}`);
      const body = (await res.json()) as { web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> } };
      const rows = body.web?.results ?? [];
      return clean(rows.map((r) => ({ title: r.title, url: r.url, snippet: r.description })));
    },
  };
}

export function tavilyProvider(apiKey: string, fetcher: Fetcher): SearchProvider {
  return {
    name: "tavily",
    async search(query) {
      const res = await fetcher("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${apiKey}`,
          "user-agent": USER_AGENT,
        },
        body: JSON.stringify({ query, max_results: RESULTS_PER_QUERY, search_depth: "basic", include_answer: false, include_raw_content: false }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new WebInfoError(`Tavily search returned ${res.status}`);
      const body = (await res.json()) as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> };
      return clean((body.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content })));
    },
  };
}

export interface ProviderEnv {
  WEB_SEARCH_PROVIDER?: string;
  BRAVE_SEARCH_API_KEY?: string;
  TAVILY_API_KEY?: string;
}

/** Pick the provider from the environment; null (with the reason) when none is configured. */
export function providerFromEnv(env: ProviderEnv, fetcher: Fetcher): { provider: SearchProvider | null; reason: string | null } {
  const wanted: ProviderName | string = (env.WEB_SEARCH_PROVIDER ?? "brave").trim().toLowerCase();
  if (wanted === "tavily") {
    return env.TAVILY_API_KEY
      ? { provider: tavilyProvider(env.TAVILY_API_KEY, fetcher), reason: null }
      : { provider: null, reason: "WEB_SEARCH_PROVIDER is tavily but TAVILY_API_KEY is not set" };
  }
  if (wanted === "brave") {
    return env.BRAVE_SEARCH_API_KEY
      ? { provider: braveProvider(env.BRAVE_SEARCH_API_KEY, fetcher), reason: null }
      : { provider: null, reason: "BRAVE_SEARCH_API_KEY is not set" };
  }
  return { provider: null, reason: `WEB_SEARCH_PROVIDER must be brave or tavily, not ${wanted}` };
}
