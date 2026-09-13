// POST /api/chat { conversation_id?, content, file_ids? } — streaming chat.
//
// Phase 0/1: stores the user message, stores a fixed assistant reply saying
// the chat tools arrive in Phase 8, and streams that reply as text so the
// client code is final. Phase 8 replaces the reply generator with the
// Anthropic call and tool loop; the response shape (a text stream with
// x-conversation-id / x-message-id headers) does not change.
//
// Message content is stored as Anthropic-style content blocks:
//   [{ "type": "text", "text": "..." }]

import { z } from "zod";
import { dbError, handle, HttpError, parseBody, requireUser, UUID_RE } from "@/lib/http";
import type { Json } from "@/lib/types/db";

const schema = z.object({
  conversation_id: z.string().regex(UUID_RE).nullable().optional(),
  content: z.string().trim().min(1).max(8000),
  file_ids: z.array(z.string().regex(UUID_RE)).max(50).optional(),
});

const PHASE_NOTE =
  "The chat tools arrive in Phase 8. Until then the header strip and the Loops tab are where edits happen, " +
  "and every change you make there is logged as a correction. I have kept your message; when the tools land, " +
  "this conversation continues from here.";

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, schema);

    let conversationId = body.conversation_id ?? null;
    if (conversationId) {
      const { data, error } = await supabase.from("conversations").select("id").eq("id", conversationId).maybeSingle();
      if (error) throw dbError(error, "Loading the conversation");
      if (!data) throw new HttpError(404, "Conversation not found.");
    } else {
      const title = body.content.length > 60 ? `${body.content.slice(0, 57)}...` : body.content;
      const created = await supabase
        .from("conversations")
        .insert({ user_id: user.id, title, file_ids: body.file_ids ?? [] })
        .select("id")
        .single();
      if (created.error) throw dbError(created.error, "Starting the conversation");
      conversationId = created.data.id;
    }

    const userMessage = await supabase
      .from("messages")
      .insert({
        user_id: user.id,
        conversation_id: conversationId,
        role: "user",
        content: [{ type: "text", text: body.content }] as Json,
      })
      .select("id")
      .single();
    if (userMessage.error) throw dbError(userMessage.error, "Saving your message");

    const replyText = PHASE_NOTE;
    const assistantMessage = await supabase
      .from("messages")
      .insert({
        user_id: user.id,
        conversation_id: conversationId,
        role: "assistant",
        content: [{ type: "text", text: replyText }] as Json,
        tool_calls: null,
        citations: null,
      })
      .select("id")
      .single();
    if (assistantMessage.error) throw dbError(assistantMessage.error, "Saving the reply");

    // touch updated_at so the conversation list reorders
    await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversationId);

    const encoder = new TextEncoder();
    const chunks = replyText.match(/\S+\s*/g) ?? [replyText];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-conversation-id": conversationId,
        "x-message-id": assistantMessage.data.id,
        "x-user-message-id": userMessage.data.id,
      },
    });
  });
}
