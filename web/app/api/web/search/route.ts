// POST /api/web/search { query } — the web_search tool as a route (server
// only; docs/CONTRACTS.md section 7). Titles, snippets and URLs, cached for
// 24 h, counted against the free tier's daily web searches. The chat tool
// calls the same lib/webinfo function; this route exists for the surface tabs
// (a breakdown's context section) and for checking the provider from a shell.

import { z } from "zod";
import { FREE_TIER, readUsage, supabaseUsageSource, WEB_QUOTA_MESSAGE, webSearchesLeft } from "@/lib/chat/limits";
import { handle, HttpError, json, parseBody, requireUser } from "@/lib/http";
import { createWebInfo, WebInfoError } from "@/lib/webinfo";

const schema = z.object({ query: z.string().trim().min(1).max(400) });

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const body = await parseBody(req, schema);
    const usage = await readUsage(supabaseUsageSource(supabase));
    if (webSearchesLeft(usage) <= 0) throw new HttpError(429, WEB_QUOTA_MESSAGE);
    const web = createWebInfo();
    try {
      const out = await web.search(body.query);
      return json({ ...out, provider: web.provider, quota: { used_today: usage.web_searches_today, per_day: FREE_TIER.web_searches_per_day } });
    } catch (err) {
      if (err instanceof WebInfoError) throw new HttpError(503, err.message);
      throw err;
    }
  });
}
