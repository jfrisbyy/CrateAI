import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots, RobotsCache } from "./robots";

describe("robots", () => {
  const rules = parseRobots(`
# comment
User-agent: *
Disallow: /private/
Allow: /private/public-page
Disallow: /tmp/*.html$

User-agent: CrateAI
Disallow: /only-for-us/
`);

  it("parses groups", () => {
    expect(rules.groups).toHaveLength(2);
    expect(rules.groups[0]?.disallow).toEqual(["/private/", "/tmp/*.html$"]);
    expect(rules.groups[0]?.allow).toEqual(["/private/public-page"]);
  });

  it("applies the longest match, allow on ties, wildcard and end anchor", () => {
    expect(isAllowed(rules, "/anything", "other-bot")).toBe(true);
    expect(isAllowed(rules, "/private/x", "other-bot")).toBe(false);
    expect(isAllowed(rules, "/private/public-page", "other-bot")).toBe(true);
    expect(isAllowed(rules, "/tmp/a.html", "other-bot")).toBe(false);
    expect(isAllowed(rules, "/tmp/a.html?x=1", "other-bot")).toBe(true);
  });

  it("prefers our own group when the site names us", () => {
    expect(isAllowed(rules, "/only-for-us/x")).toBe(false);
    expect(isAllowed(rules, "/private/x")).toBe(true);
  });

  it("caches robots.txt once per host", async () => {
    const calls: string[] = [];
    const cache = new RobotsCache(async (url) => {
      calls.push(url);
      return new Response("User-agent: *\nDisallow: /no/", { status: 200, headers: { "content-type": "text/plain" } });
    });
    expect((await cache.check(new URL("https://a.example/no/1"))).allowed).toBe(false);
    expect((await cache.check(new URL("https://a.example/yes"))).allowed).toBe(true);
    expect((await cache.check(new URL("https://b.example/no/1"))).allowed).toBe(false);
    expect(calls).toEqual(["https://a.example/robots.txt", "https://b.example/robots.txt"]);
  });

  it("treats an unreadable robots.txt as open", async () => {
    const cache = new RobotsCache(async () => {
      throw new Error("network");
    });
    expect((await cache.check(new URL("https://c.example/anything"))).allowed).toBe(true);
  });
});
