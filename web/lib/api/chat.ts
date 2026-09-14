// Browser client for POST /api/chat: sends the turn and decodes the NDJSON
// event stream (lib/chat/protocol.ts) as it arrives.

import { ApiError } from "@/lib/api/client";
import type { BatchOperation } from "@/lib/chat/cards";
import { EventDecoder, type ChatEvent } from "@/lib/chat/protocol";
import type { SessionSnapshot } from "@/lib/chat/surfaces";

export interface ChatSendBody {
  conversation_id: string | null;
  message: string;
  file_ids: string[];
  open_file_id: string | null;
  /** the confirm card's Run: the same operations, confirmed */
  batch?: { operations: BatchOperation[]; confirmed: true };
  /**
   * The surfaces that live in the browser: the open song, the transport, the
   * rack, the chains. The chat runs on the server and cannot see any of it, so
   * a turn carries it. Only the compact block in lib/chat/surfaces.ts reaches
   * the model; the whole arrangement reaches the tools, which is what lets the
   * export render the song the producer is looking at.
   */
  session?: SessionSnapshot | null;
}

export interface ChatStreamResult {
  conversationId: string | null;
  done: Extract<ChatEvent, { type: "done" }> | null;
}

export async function streamChat(body: ChatSendBody, onEvent: (event: ChatEvent) => void, signal?: AbortSignal): Promise<ChatStreamResult> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/x-ndjson" },
    body: JSON.stringify(body),
    credentials: "same-origin",
    signal,
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed: { error?: string; details?: unknown } | null = null;
    try {
      parsed = JSON.parse(text) as { error?: string; details?: unknown };
    } catch {
      parsed = null;
    }
    throw new ApiError(res.status, parsed?.error ?? `Chat failed (${res.status}).`, parsed?.details);
  }
  const conversationId = res.headers.get("x-conversation-id");
  const decoder = new EventDecoder();
  const textDecoder = new TextDecoder();
  let done: ChatStreamResult["done"] = null;
  const handle = (events: ChatEvent[]) => {
    for (const e of events) {
      if (e.type === "done") done = e;
      onEvent(e);
    }
  };
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done: finished, value } = await reader.read();
      if (finished) break;
      handle(decoder.push(textDecoder.decode(value, { stream: true })));
    }
    handle(decoder.push(textDecoder.decode()));
  }
  handle(decoder.flush());
  return { conversationId, done };
}
