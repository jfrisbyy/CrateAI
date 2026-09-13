// GET /api/conversations — the caller's conversations, most recent first.
// POST /api/conversations { title?, file_ids? } — start one.

import { z } from "zod";
import type { ConversationsListResponse } from "@/lib/api/types";
import { dbError, handle, json, parseBody, requireUser, UUID_RE } from "@/lib/http";

export async function GET() {
  return handle(async () => {
    const { supabase } = await requireUser();
    const { data, error } = await supabase
      .from("conversations")
      .select("*")
      .order("updated_at", { ascending: false })
      .limit(100);
    if (error) throw dbError(error, "Listing conversations");
    const response: ConversationsListResponse = { conversations: data };
    return json(response);
  });
}

const createSchema = z.object({
  title: z.string().trim().max(200).nullable().optional(),
  file_ids: z.array(z.string().regex(UUID_RE)).max(50).optional(),
});

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = req.headers.get("content-length") === "0" ? {} : await parseBody(req, createSchema);
    const inserted = await supabase
      .from("conversations")
      .insert({ user_id: user.id, title: body.title ?? null, file_ids: body.file_ids ?? [] })
      .select("*")
      .single();
    if (inserted.error) throw dbError(inserted.error, "Starting the conversation");
    return json({ conversation: inserted.data }, { status: 201 });
  });
}
