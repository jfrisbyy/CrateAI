// POST /api/web/fetch { url } — the fetch_page tool as a route (server only).
// The guard refuses media hosts, download and stream paths and media file
// types before the request, robots.txt is respected, and only text, HTML and
// JSON responses are read. A refusal is a 422 with the reason; nothing here
// can write a `files` row.

import { z } from "zod";
import { handle, json, parseBody, requireUser } from "@/lib/http";
import { createWebInfo } from "@/lib/webinfo";

const schema = z.object({ url: z.string().trim().min(1).max(2000) });

export async function POST(req: Request) {
  return handle(async () => {
    await requireUser();
    const body = await parseBody(req, schema);
    const out = await createWebInfo().fetchPage(body.url);
    if (!out.ok) return json({ error: out.reason, stage: out.stage }, { status: 422 });
    return json({ page: out.page, cached: out.cached });
  });
}
