import { describe, expect, it } from "vitest";
import { buildQueries, findingsFrom, identityOf, identifyContext, MAX_IDENTIFY_SEARCHES } from "./identify";
import type { SearchResult } from "./types";

describe("identityOf", () => {
  it("prefers the row's title and artist", () => {
    expect(identityOf({ original_filename: "x.wav", title: "The Song", artist: "Someone" })).toEqual({ artist: "Someone", title: "The Song", identified: true });
  });
  it("reads 'Artist - Title' from the filename", () => {
    expect(identityOf({ original_filename: "Roy Ayers - Everybody Loves The Sunshine.flac", title: null, artist: null })).toEqual({
      artist: "Roy Ayers",
      title: "Everybody Loves The Sunshine",
      identified: true,
    });
    expect(identityOf({ original_filename: "03 - Someone - A Song (Official Audio).mp3", title: null, artist: null })).toMatchObject({ artist: "Someone", title: "A Song" });
  });
  it("is unidentified for a bare filename", () => {
    expect(identityOf({ original_filename: "drums_take3.wav", title: null, artist: null })).toEqual({ artist: null, title: null, identified: false });
  });
});

describe("buildQueries", () => {
  it("builds the five queries a producer would run, in order", () => {
    const q = buildQueries({ artist: "Roy Ayers", title: "Everybody Loves The Sunshine", identified: true });
    expect(q.map((p) => p.query)).toEqual([
      "Roy Ayers Everybody Loves The Sunshine producer",
      "Everybody Loves The Sunshine sample source",
      "who sampled Everybody Loves The Sunshine",
      "Roy Ayers Everybody Loves The Sunshine interview production",
      "Roy Ayers Everybody Loves The Sunshine gear",
    ]);
    expect(q.map((p) => p.kind)).toEqual(["producer", "sample", "sampled_by", "interview", "gear"]);
    expect(q.length).toBeLessThanOrEqual(MAX_IDENTIFY_SEARCHES);
  });
  it("builds nothing without a title", () => {
    expect(buildQueries({ artist: null, title: null, identified: false })).toEqual([]);
  });
});

describe("findingsFrom / identifyContext", () => {
  it("drops results without a URL and keeps one sentence per finding with its citation", () => {
    const results: SearchResult[] = [
      { title: "WhoSampled", url: "https://www.whosampled.com/x", snippet: "Produced by Someone in 1976. It was recorded at a studio." },
      { title: "no url", url: "", snippet: "Nothing to cite here." },
      { title: "empty", url: "https://empty.example/", snippet: "   " },
    ];
    const f = findingsFrom("producer", results);
    expect(f).toEqual([{ kind: "producer", text: "Produced by Someone in 1976.", citation: { url: "https://www.whosampled.com/x", title: "WhoSampled" } }]);
  });

  it("runs at most five searches, tolerates a failing one, and never touches audio", async () => {
    const asked: string[] = [];
    const res = await identifyContext(
      { original_filename: "Roy Ayers - Everybody Loves The Sunshine.wav", title: null, artist: null },
      {
        search: async (q) => {
          asked.push(q);
          if (q.startsWith("who sampled")) throw new Error("provider down");
          return [{ title: `r:${q}`, url: `https://x.example/${asked.length}`, snippet: `Answer for ${q}. More.` }];
        },
      },
    );
    expect(asked).toHaveLength(5);
    expect(res.searches_run).toBe(5);
    expect(res.identified).toBe(true);
    expect(res.findings).toHaveLength(4);
    for (const f of res.findings) {
      expect(f.citation.url).toMatch(/^https:\/\//);
      expect(f.text.endsWith(".")).toBe(true);
    }
  });

  it("returns no queries and no findings for an unidentified file", async () => {
    const res = await identifyContext({ original_filename: "loop.wav", title: null, artist: null }, { search: async () => [] });
    expect(res).toMatchObject({ identified: false, queries: [], findings: [], searches_run: 0 });
  });
});
