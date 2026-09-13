// fetch_page: read one page for citation. The guard runs before the request
// (media hosts, download and stream paths, media extensions) and on every
// redirect target; robots.txt is respected; the content type is checked
// after the response and anything that is not text, HTML or JSON is refused
// by name. There is no way through here to bytes on disk or a `files` row.

import { cacheKey, type WebCache } from "./cache";
import { extractPlain, extractText, titleOf } from "./extract";
import { checkContentType, checkUrl } from "./guard";
import type { RobotsCache } from "./robots";
import { type FetchedPage, type Fetcher, type FetchOutcome, USER_AGENT } from "./types";

export const FETCH_TIMEOUT_MS = 10_000;
export const MAX_REDIRECTS = 3;
/** bytes read from a page body; enough for any article, small enough to bound memory */
export const MAX_BODY_BYTES = 2_000_000;

export interface FetchDeps {
  fetcher: Fetcher;
  robots: RobotsCache;
  cache: WebCache;
  now?: () => Date;
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  }
  const joined = new Uint8Array(Math.min(total, MAX_BODY_BYTES));
  let offset = 0;
  for (const c of chunks) {
    const slice = c.subarray(0, Math.max(0, joined.length - offset));
    joined.set(slice, offset);
    offset += slice.length;
    if (offset >= joined.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}

export async function fetchPage(input: string, deps: FetchDeps): Promise<FetchOutcome> {
  const first = checkUrl(input);
  if (!first.ok) return { ok: false, reason: first.reason, stage: "url" };

  const now = deps.now ?? (() => new Date());
  const key = cacheKey("fetch", "fetch", first.url.toString());
  const hit = await deps.cache.get(key);
  if (hit && hit.response && typeof hit.response === "object") {
    return { ok: true, page: hit.response as FetchedPage, cached: true };
  }

  let url = first.url;
  let res: Response | null = null;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const robots = await deps.robots.check(url);
    if (!robots.allowed) {
      return { ok: false, reason: `the site disallows fetching ${url.pathname} (robots.txt), so I skipped it`, stage: "robots" };
    }
    try {
      res = await deps.fetcher(url.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { accept: "text/html, text/plain, application/json", "user-agent": USER_AGENT },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      return { ok: false, reason: timedOut ? `the page took longer than ${FETCH_TIMEOUT_MS / 1000} s to answer` : `the request failed: ${message}`, stage: "request" };
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      if (hop === MAX_REDIRECTS) return { ok: false, reason: `more than ${MAX_REDIRECTS} redirects`, stage: "redirect" };
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        return { ok: false, reason: "the page redirected somewhere unreadable", stage: "redirect" };
      }
      const verdict = checkUrl(next.toString());
      if (!verdict.ok) return { ok: false, reason: `the page redirects to a link I won't fetch: ${verdict.reason}`, stage: "redirect" };
      url = verdict.url;
      res = null;
      continue;
    }
    break;
  }
  if (!res) return { ok: false, reason: `more than ${MAX_REDIRECTS} redirects`, stage: "redirect" };
  if (!res.ok) return { ok: false, reason: `the page answered ${res.status}`, stage: "request" };

  const type = checkContentType(res.headers.get("content-type"));
  if (!type.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: type.reason, stage: "content_type" };
  }

  const body = await readCapped(res);
  const isHtml = type.type === "text/html" || type.type === "application/xhtml+xml";
  const page: FetchedPage = {
    url: url.toString(),
    title: isHtml ? titleOf(body, url.hostname) : url.hostname,
    text: isHtml ? extractText(body) : extractPlain(body),
    fetched_at: now().toISOString(),
  };
  await deps.cache.set({ key, provider: "fetch", kind: "fetch", query: first.url.toString(), response: page });
  return { ok: true, page, cached: false };
}
