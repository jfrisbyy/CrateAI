// POST /api/chat { conversation_id?, message, file_ids?, open_file_id?, batch? }
// — the chat front door (BUILD_PACKET section 14, Phase 8).
//
// Streams application/x-ndjson, one event per line (lib/chat/protocol.ts):
// text deltas as they arrive, tool_call / tool_result with the card the pane
// renders, citations, then done with the stored message id. Persists the user
// message and one assistant message whose content is the final text, whose
// tool_calls carry every call with its input and summarized result, and whose
// citations are every web citation used.
//
// `message` is the field name; `content` (the Phase 0 client) is accepted too.
// `batch` is the confirmation re-send from the confirm card: the batch tool
// runs when it is called again with those operations.

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { describeAnthropicError, getAnthropic, hasAnthropicKey } from "@/lib/anthropic/client";
import { CHAT_MAX_TOKENS, CHAT_MODEL } from "@/lib/anthropic/models";
import { supabaseChatDb } from "@/lib/chat/db";
import { batchFingerprint, runTool, type ToolContext } from "@/lib/chat/handlers";
import { HISTORY_LIMIT, historyFromRows } from "@/lib/chat/history";
import { chatQuotaMessage, chatTurnsLeft, meterChatTurn, meterWebSearches, readUsage, webSearchesIn, webSearchesLeft } from "@/lib/chat/limits";
import { runToolLoop, type ChatModel, type ToolLoopResult } from "@/lib/chat/loop";
import { CHAT_CONTENT_TYPE, encodeEvent, type ChatEvent } from "@/lib/chat/protocol";
import { buildContextBlock, SYSTEM_PROMPT } from "@/lib/chat/system";
import { CHAT_TOOLS } from "@/lib/chat/tools";
import { dispatchJob } from "@/lib/compute/dispatch";
import { dbError, handle, HttpError, parseBody, requireUser, UUID_RE } from "@/lib/http";
import { runLibrarySearch } from "@/lib/search/server";
import type { Json } from "@/lib/types/db";
import { createWebInfo } from "@/lib/webinfo";

// A turn with several tool rounds can run past a minute.
export const maxDuration = 300;

const batchSchema = z.object({
  operations: z.array(z.object({ tool: z.string().min(1).max(64), input_json: z.string().max(20_000) })).min(1).max(20),
  confirmed: z.literal(true),
});

const schema = z
  .object({
    conversation_id: z.string().regex(UUID_RE).nullable().optional(),
    message: z.string().trim().min(1).max(8000).optional(),
    content: z.string().trim().min(1).max(8000).optional(),
    file_ids: z.array(z.string().regex(UUID_RE)).max(50).optional(),
    open_file_id: z.string().regex(UUID_RE).nullable().optional(),
    batch: batchSchema.optional(),
  })
  .refine((b) => Boolean(b.message ?? b.content), { message: "message is required", path: ["message"] });

function unique(ids: string[]): string[] {
  return [...new Set(ids)];
}

export async function POST(req: Request) {
  return handle(async () => {
    const { supabase, user } = await requireUser();
    const body = await parseBody(req, schema);
    const text = (body.message ?? body.content) as string;
    if (!hasAnthropicKey()) throw new HttpError(503, "Chat needs ANTHROPIC_API_KEY; add it to web/.env.local.");

    // One read answers both caps (today's burst and this month's ceiling) and
    // carries the caller's plan, so a Pro account is not held to free limits.
    const usage = await readUsage(supabase, user.id);
    if (chatTurnsLeft(usage) <= 0) throw new HttpError(429, chatQuotaMessage(usage));

    // ---- conversation ------------------------------------------------------
    let conversationId = body.conversation_id ?? null;
    let storedFileIds: string[] = [];
    if (conversationId) {
      const { data, error } = await supabase.from("conversations").select("id, file_ids").eq("id", conversationId).maybeSingle();
      if (error) throw dbError(error, "Loading the conversation");
      if (!data) throw new HttpError(404, "Conversation not found.");
      storedFileIds = data.file_ids;
    } else {
      const title = text.length > 60 ? `${text.slice(0, 57)}...` : text;
      const created = await supabase
        .from("conversations")
        .insert({ user_id: user.id, title, file_ids: unique(body.file_ids ?? []) })
        .select("id")
        .single();
      if (created.error) throw dbError(created.error, "Starting the conversation");
      conversationId = created.data.id;
    }
    const attachedIds = unique(body.file_ids ?? storedFileIds).slice(0, 50);
    const allIds = unique([...attachedIds, ...storedFileIds]).slice(0, 50);
    if (allIds.length !== storedFileIds.length || allIds.some((id, i) => storedFileIds[i] !== id)) {
      await supabase.from("conversations").update({ file_ids: allIds }).eq("id", conversationId);
    }

    // ---- history, then the new user message --------------------------------
    const prior = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);
    if (prior.error) throw dbError(prior.error, "Loading messages");
    const history = historyFromRows([...prior.data].reverse());

    const userMessage = await supabase
      .from("messages")
      .insert({ user_id: user.id, conversation_id: conversationId, role: "user", content: [{ type: "text", text }] as Json })
      .select("id")
      .single();
    if (userMessage.error) throw dbError(userMessage.error, "Saving your message");
    // Metered here, not at the end: a turn that dies mid-stream still spent
    // input tokens, so it still counts. Best effort; it never fails the turn.
    await meterChatTurn(user.id);

    // ---- context and tools ---------------------------------------------------
    const db = supabaseChatDb(supabase, user.id);
    const attached = await db.getFiles(attachedIds);
    const files = attachedIds.map((id) => attached.find((f) => f.id === id)).filter((f): f is NonNullable<typeof f> => f !== undefined);
    const openFileId = body.open_file_id && files.some((f) => f.id === body.open_file_id) ? body.open_file_id : (files[0]?.id ?? null);
    const contextBlock = buildContextBlock(files, openFileId);
    const confirmedBatch = body.batch ? batchFingerprint(body.batch.operations) : null;

    const ctx: ToolContext = {
      db,
      userId: user.id,
      dispatch: (jobId) => dispatchJob(jobId, supabase),
      web: createWebInfo(),
      librarySearch: (query, limit) => runLibrarySearch(supabase, user.id, query, { limit, currentFileId: openFileId }),
      usage: { webSearchesLeft: webSearchesLeft(usage) },
      now: () => new Date(),
      currentFileId: openFileId,
      confirmedBatch,
    };

    let userText = text;
    if (body.batch) {
      userText += `\n\n[The producer pressed Run on the batch confirmation ${confirmedBatch}. Call the batch tool now with confirmed=true and exactly these operations: ${JSON.stringify(body.batch.operations)}]`;
    }
    const messages: Anthropic.MessageParam[] = [...history, { role: "user", content: userText }];
    // The cache is a prefix match and the render order is tools, then system,
    // then messages, so this one breakpoint covers CHAT_TOOLS plus the frozen
    // SYSTEM_PROMPT — about 7,000 tokens that never change. Everything that
    // moves stays after it: the context block carries today's date and the
    // attached files' reports, and the producer's question is a message.
    // Nothing above this line may be interpolated into SYSTEM_PROMPT or
    // CHAT_TOOLS without giving up the cache for every request.
    const system: Anthropic.TextBlockParam[] = [
      { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      { type: "text", text: contextBlock },
    ];
    const client = getAnthropic();
    const model: ChatModel = { stream: (params) => client.messages.stream(params) };

    // ---- stream --------------------------------------------------------------
    const encoder = new TextEncoder();
    const convId = conversationId;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: ChatEvent) => controller.enqueue(encoder.encode(encodeEvent(event)));
        let result: ToolLoopResult | null = null;
        let failure: string | null = null;
        try {
          result = await runToolLoop({
            model,
            modelId: CHAT_MODEL,
            maxTokens: CHAT_MAX_TOKENS,
            system,
            tools: CHAT_TOOLS,
            messages,
            execute: (call) => runTool(call.name, call.input, ctx),
            emit,
          });
        } catch (err) {
          failure = describeAnthropicError(err);
          console.error("[chat]", err);
        }

        let messageId = "";
        try {
          if (result && (result.text.length > 0 || result.toolCalls.length > 0)) {
            const saved = await supabase
              .from("messages")
              .insert({
                user_id: user.id,
                conversation_id: convId,
                role: "assistant",
                content: [{ type: "text", text: result.text }] as Json,
                tool_calls: result.toolCalls.length > 0 ? (result.toolCalls as unknown as Json) : null,
                citations: result.citations.length > 0 ? (result.citations as unknown as Json) : null,
              })
              .select("id")
              .single();
            if (saved.error) throw new Error(saved.error.message);
            messageId = saved.data.id;
          }
          await supabase.from("conversations").update({ updated_at: new Date().toISOString() }).eq("id", convId);
        } catch (err) {
          failure = failure ?? `The reply could not be saved: ${err instanceof Error ? err.message : String(err)}`;
        }

        // The searches this turn actually ran, metered once. Reading them back
        // off the recorded tool calls catches the ones identify_context fans
        // out internally, which the per-call budget only approximates.
        if (result) await meterWebSearches(user.id, webSearchesIn(result.toolCalls as unknown as Json));

        if (result && result.citations.length > 0) emit({ type: "citations", items: result.citations });
        if (failure) emit({ type: "error", message: failure });
        emit({ type: "done", message_id: messageId, conversation_id: convId });
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": CHAT_CONTENT_TYPE,
        "cache-control": "no-store",
        "x-conversation-id": conversationId,
        "x-user-message-id": userMessage.data.id,
      },
    });
  });
}
