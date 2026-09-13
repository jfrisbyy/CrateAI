import { describe, expect, it } from "vitest";
import { cacheKey, MemoryWebCache, normalizeQuery } from "./cache";
import { braveProvider, providerFromEnv, tavilyProvider } from "./providers";
import { webSearch } from "./search";
import type { Fetcher, SearchProvider, SearchResult } from "./types";
import { WebInfoError } from "./types";

function countingProvider(results: SearchResult[]): SearchProvider & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: "brave",
    calls,
    async search(q) {
      calls.push(q);
      return results;
    },
  };
}

describe("webSearch", () => {
  it("serves the second identical query from the cache without calling the provider", async () => {
    const provider = countingProvider([{ title: "A", url: "https://a.example/", snippet: "s" }]);
    const cache = new MemoryWebCache();
    const first = await webSearch("who produced the record", { provider, cache });
    const second = await webSearch("  Who   produced the RECORD ", { provider, cache });
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(second.results).toEqual(first.results);
    expect(provider.calls).toHaveLength(1);
  });

  it("expires after 24 hours", async () => {
    let t = Date.parse("2026-09-13T00:00:00Z");
    const cache = new MemoryWebCache(() => new Date(t));
    const provider = countingProvider([]);
    await webSearch("q", { provider, cache });
    t += 23 * 60 * 60 * 1000;
    await webSearch("q", { provider, cache });
    expect(provider.calls).toHaveLength(1);
    t += 2 * 60 * 60 * 1000;
    await webSearch("q", { provider, cache });
    expect(provider.calls).toHaveLength(2);
  });

  it("fails clearly when no provider is configured", async () => {
    await expect(webSearch("q", { provider: null, providerReason: "BRAVE_SEARCH_API_KEY is not set", cache: new MemoryWebCache() })).rejects.toThrow(WebInfoError);
    await expect(webSearch("q", { provider: null, cache: new MemoryWebCache() })).rejects.toThrow(/isn't configured/);
  });

  it("keys the cache by provider, kind and normalized query", () => {
    expect(normalizeQuery("  Who   PRODUCED it ")).toBe("who produced it");
    expect(cacheKey("brave", "search", "a b")).toBe(cacheKey("brave", "search", " A   B "));
    expect(cacheKey("brave", "search", "a")).not.toBe(cacheKey("tavily", "search", "a"));
    expect(cacheKey("brave", "search", "a")).not.toBe(cacheKey("brave", "fetch", "a"));
  });
});

describe("providers", () => {
  it("brave: GET with the subscription token, results from web.results", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify({ web: { results: [{ title: "T", url: "https://x.example/p", description: "D" }, { title: "bad", url: "javascript:1" }] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const results = await braveProvider("KEY", fetcher).search("mpc 3000");
    expect(results).toEqual([{ title: "T", url: "https://x.example/p", snippet: "D" }]);
    expect(calls[0]?.url).toContain("https://api.search.brave.com/res/v1/web/search?q=mpc%203000");
    expect((calls[0]?.init?.headers as Record<string, string>)["X-Subscription-Token"]).toBe("KEY");
  });

  it("tavily: POST with the key, results from results[]", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: Fetcher = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ results: [{ title: "T", url: "https://x.example/p", content: "C" }] }), { status: 200 });
    };
    const results = await tavilyProvider("KEY", fetcher).search("q");
    expect(results).toEqual([{ title: "T", url: "https://x.example/p", snippet: "C" }]);
    expect(calls[0]?.url).toBe("https://api.tavily.com/search");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init?.body)).query).toBe("q");
  });

  it("selects the provider from the environment", () => {
    const f: Fetcher = async () => new Response("");
    expect(providerFromEnv({ WEB_SEARCH_PROVIDER: "brave", BRAVE_SEARCH_API_KEY: "k" }, f).provider?.name).toBe("brave");
    expect(providerFromEnv({ WEB_SEARCH_PROVIDER: "tavily", TAVILY_API_KEY: "k" }, f).provider?.name).toBe("tavily");
    expect(providerFromEnv({}, f)).toMatchObject({ provider: null, reason: "BRAVE_SEARCH_API_KEY is not set" });
    expect(providerFromEnv({ WEB_SEARCH_PROVIDER: "bing" }, f).provider).toBeNull();
  });
});
