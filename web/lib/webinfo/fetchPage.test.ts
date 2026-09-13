import { describe, expect, it } from "vitest";
import { MemoryWebCache } from "./cache";
import { fetchPage, MAX_REDIRECTS } from "./fetchPage";
import { RobotsCache } from "./robots";
import type { Fetcher } from "./types";

interface Scripted {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
}

/** A fetch that records every call and answers from a table keyed by URL. */
function fakeFetch(table: Record<string, Scripted>, robotsText: Record<string, string> = {}) {
  const calls: string[] = [];
  const fetcher: Fetcher = async (input) => {
    calls.push(input);
    const u = new URL(input);
    if (u.pathname === "/robots.txt") {
      const text = robotsText[u.origin];
      return text === undefined
        ? new Response("not found", { status: 404 })
        : new Response(text, { status: 200, headers: { "content-type": "text/plain" } });
    }
    const hit = table[input];
    if (!hit) return new Response("missing", { status: 404 });
    return new Response(hit.body ?? "", { status: hit.status ?? 200, headers: hit.headers ?? {} });
  };
  return { fetcher, calls };
}

function deps(f: ReturnType<typeof fakeFetch>) {
  return { fetcher: f.fetcher, robots: new RobotsCache(f.fetcher), cache: new MemoryWebCache(), now: () => new Date("2026-09-13T12:00:00Z") };
}

describe("fetchPage", () => {
  it("rejects media URLs before any request is made", async () => {
    const f = fakeFetch({});
    for (const url of [
      "https://www.youtube.com/watch?v=abc",
      "https://soundcloud.com/x/y/stream",
      "https://example.com/song.mp3",
      "https://example.com/download/123",
    ]) {
      const out = await fetchPage(url, deps(f));
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.stage).toBe("url");
    }
    expect(f.calls).toEqual([]);
  });

  it("refuses an audio response after the fact, naming the type", async () => {
    const f = fakeFetch({ "https://example.com/track": { headers: { "content-type": "audio/mpeg" }, body: "ID3..." } });
    const out = await fetchPage("https://example.com/track", deps(f));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("content_type");
      expect(out.reason).toContain("audio/mpeg");
    }
  });

  it("refuses octet-stream and video too", async () => {
    const f = fakeFetch({
      "https://example.com/a": { headers: { "content-type": "application/octet-stream" }, body: "x" },
      "https://example.com/b": { headers: { "content-type": "video/mp4" }, body: "x" },
    });
    for (const u of ["https://example.com/a", "https://example.com/b"]) {
      const out = await fetchPage(u, deps(f));
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.stage).toBe("content_type");
    }
  });

  it("skips paths robots.txt disallows and says so", async () => {
    const f = fakeFetch(
      { "https://example.com/private/page": { headers: { "content-type": "text/html" }, body: "<p>secret</p>" } },
      { "https://example.com": "User-agent: *\nDisallow: /private/\n" },
    );
    const out = await fetchPage("https://example.com/private/page", deps(f));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.stage).toBe("robots");
      expect(out.reason).toContain("the site disallows fetching");
    }
    expect(f.calls).toEqual(["https://example.com/robots.txt"]);
  });

  it("extracts title and readable text from HTML and caches it for 24 h", async () => {
    const html = `<html><head><title>Who produced It &amp; why</title><script>alert(1)</script></head>
      <body><nav>menu</nav><h1>The record</h1><p>It was produced by <b>Someone</b>.</p><style>p{}</style><footer>foot</footer></body></html>`;
    const f = fakeFetch({ "https://example.com/article": { headers: { "content-type": "text/html; charset=utf-8" }, body: html } });
    const d = deps(f);
    const out = await fetchPage("https://example.com/article", d);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.page.title).toBe("Who produced It & why");
      expect(out.page.text).toContain("# The record");
      expect(out.page.text).toContain("It was produced by Someone.");
      expect(out.page.text).not.toContain("alert");
      expect(out.page.text).not.toContain("menu");
      expect(out.page.fetched_at).toBe("2026-09-13T12:00:00.000Z");
      expect(out.cached).toBe(false);
    }
    const again = await fetchPage("https://example.com/article", d);
    expect(again.ok && again.cached).toBe(true);
    expect(f.calls.filter((c) => c.endsWith("/article"))).toHaveLength(1);
  });

  it("follows at most three redirects and checks every hop against the guard", async () => {
    const f = fakeFetch({
      "https://example.com/1": { status: 302, headers: { location: "/2" } },
      "https://example.com/2": { status: 301, headers: { location: "https://www.youtube.com/watch?v=x" } },
      "https://example.com/r0": { status: 302, headers: { location: "/r1" } },
      "https://example.com/r1": { status: 302, headers: { location: "/r2" } },
      "https://example.com/r2": { status: 302, headers: { location: "/r3" } },
      "https://example.com/r3": { status: 302, headers: { location: "/r4" } },
      "https://example.com/r4": { headers: { "content-type": "text/plain" }, body: "end" },
    });
    const toMedia = await fetchPage("https://example.com/1", deps(f));
    expect(toMedia.ok).toBe(false);
    if (!toMedia.ok) expect(toMedia.stage).toBe("redirect");
    expect(f.calls).not.toContain("https://www.youtube.com/watch?v=x");

    const tooMany = await fetchPage("https://example.com/r0", deps(f));
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.reason).toContain(`${MAX_REDIRECTS}`);
    expect(f.calls).not.toContain("https://example.com/r4");
  });

  it("reads JSON and plain text as-is", async () => {
    const f = fakeFetch({ "https://api.example.com/credits": { headers: { "content-type": "application/json" }, body: '{"producer":"Someone"}' } });
    const out = await fetchPage("https://api.example.com/credits", deps(f));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.page.text).toBe('{"producer":"Someone"}');
  });

  it("reports timeouts and network failures without throwing", async () => {
    const fetcher: Fetcher = async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    };
    const out = await fetchPage("https://example.com/slow", { fetcher, robots: new RobotsCache(async () => new Response("", { status: 404 })), cache: new MemoryWebCache() });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain("longer than 10 s");
  });
});
