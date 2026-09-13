// Principle 3, asserted over the source: there is no code path from a URL to
// a `files` row or to storage. Only supabaseCache.ts may import the admin
// client, and it may only touch web_cache.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = new URL(".", import.meta.url).pathname;
const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

function read(name: string): string {
  return readFileSync(join(dir, name), "utf8");
}

describe("lib/webinfo isolation", () => {
  it("lists the modules under test", () => {
    expect(sources).toContain("fetchPage.ts");
    expect(sources).toContain("supabaseCache.ts");
  });

  it("only supabaseCache.ts imports the admin client, and only for web_cache", () => {
    for (const name of sources) {
      const src = read(name);
      const importsAdmin = /from ["']@\/lib\/supabase\/admin["']/.test(src);
      if (name === "supabaseCache.ts") {
        expect(importsAdmin).toBe(true);
        const tables = [...src.matchAll(/\.from\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
        expect(tables.length).toBeGreaterThan(0);
        expect(new Set(tables)).toEqual(new Set(["web_cache"]));
      } else {
        expect(importsAdmin, `${name} must not import the admin client`).toBe(false);
        expect(/@\/lib\/supabase\//.test(src), `${name} must not import any supabase client`).toBe(false);
      }
    }
  });

  it("never writes files, storage, jobs or dispatches compute", () => {
    const forbidden = [
      /\.from\(\s*["']files["']/,
      /\.from\(\s*["']jobs["']/,
      /\.storage\b/,
      /\.upload\(/,
      /createSignedUrl/,
      /@\/lib\/compute/,
      /@\/lib\/storage/,
      /dispatchJob/,
      /writeFile|createWriteStream|node:fs/,
    ];
    for (const name of sources) {
      const src = read(name);
      for (const re of forbidden) {
        expect(re.test(src), `${name} matches ${re}`).toBe(false);
      }
    }
  });

  it("every fetch goes through the guard: fetchPage checks the URL before fetching and the content type after", () => {
    const src = read("fetchPage.ts");
    expect(src.indexOf("checkUrl(input)")).toBeGreaterThan(-1);
    expect(src.indexOf("checkUrl(input)")).toBeLessThan(src.indexOf("deps.fetcher("));
    expect(src.indexOf("checkContentType(")).toBeGreaterThan(src.indexOf("deps.fetcher("));
  });
});
