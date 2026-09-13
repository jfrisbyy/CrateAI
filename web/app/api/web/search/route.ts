// POST /api/web/search { query } — the web_search tool as a route (server
// only; docs/CONTRACTS.md section 7). Titles, snippets and URLs, cached for
// 24 h, counted against the plan's daily and monthly web searches. The chat
// tool calls the same lib/webinfo function; this route exists for the surface
// tabs (a breakdown's context section) and for checking the provider from a
// shell.
//
// Every call here meters a `usage_events` row. Before the launch pass this
// route was free: the caps were derived from the tool calls recorded on chat
// messages, so a search made from the surface — or from a shell with a
// session cookie — spent the provider's quota and our money without ever
// being counted.

import { z } from "zod";
import { meterWebSearches, readUsage, webQuotaMessage, webSearchesLeft } from "@/lib/chat/limits";
import { handle, HttpError, json, parseBody, requireUser } from "@/lib/http";
import { createWebInfo, WebInfoError } from "@/lib/webinfo";

const schema = z.object({ query: z.string().trim().min(1).max(400) });

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, schema);
    const usage = await readUsage(supabase, user.id);
    if (webSearchesLeft(usage) <= 0) throw new HttpError(429, webQuotaMessage(usage));
    const web = createWebInfo();
    try {
      const out = await web.search(body.query);
      await meterWebSearches(user.id, 1);
      return json({
        ...out,
        provider: web.provider,
        quota: {
          used_today: usage.usage.web_searches_today,
          per_day: usage.limits.web_searches_per_day,
          used_month: usage.usage.web_searches_month,
          per_month: usage.limits.web_searches_per_month,
        },
      });
    } catch (err) {
      if (err instanceof WebInfoError) throw new HttpError(503, err.message);
      throw err;
    }
  });
}
