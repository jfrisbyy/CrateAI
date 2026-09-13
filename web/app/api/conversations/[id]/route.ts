// GET /api/conversations/[id] — the conversation and its messages in order.
// DELETE /api/conversations/[id].

import type { ConversationResponse } from "@/lib/api/types";
import { dbError, handle, HttpError, json, requireUser, requireUuid } from "@/lib/http";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "conversation id");
    const [conv, msgs] = await Promise.all([
      supabase.from("conversations").select("*").eq("id", id).maybeSingle(),
      supabase.from("messages").select("*").eq("conversation_id", id).order("created_at", { ascending: true }).limit(500),
    ]);
    if (conv.error) throw dbError(conv.error, "Loading the conversation");
    if (!conv.data) throw new HttpError(404, "Conversation not found.");
    if (msgs.error) throw dbError(msgs.error, "Loading messages");
    const response: ConversationResponse = { conversation: conv.data, messages: msgs.data };
    return json(response);
  });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  return handle(async () => {
    const { supabase } = await requireUser();
    const id = requireUuid((await ctx.params).id, "conversation id");
    const { error, count } = await supabase.from("conversations").delete({ count: "exact" }).eq("id", id);
    if (error) throw dbError(error, "Deleting the conversation");
    if (!count) throw new HttpError(404, "Conversation not found.");
    return json({ ok: true as const });
  });
}
