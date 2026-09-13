// The streaming protocol between POST /api/chat and the chat pane: one JSON
// event per line (application/x-ndjson). The encoder runs on the server, the
// decoder in the browser; both are pure and round-trip tested.
//
//   { type: "text", delta }
//   { type: "tool_call", id, name, input }
//   { type: "tool_result", id, name, card, summary, is_error? }
//   { type: "citations", items }
//   { type: "done", message_id, conversation_id }
//   { type: "error", message }

import type { Json } from "@/lib/types/db";
import type { Card, Citation } from "./cards";

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call"; id: string; name: string; input: Json }
  | { type: "tool_result"; id: string; name: string; card: Card | null; summary: string; is_error?: boolean }
  | { type: "citations"; items: Citation[] }
  | { type: "done"; message_id: string; conversation_id: string }
  | { type: "error"; message: string };

const EVENT_TYPES = new Set(["text", "tool_call", "tool_result", "citations", "done", "error"]);

export function encodeEvent(event: ChatEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export function parseEvent(line: string): ChatEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || !EVENT_TYPES.has(type)) return null;
  return value as ChatEvent;
}

/** Feeds arbitrary chunks, returns whole events; a partial trailing line waits for the next chunk. */
export class EventDecoder {
  private buffer = "";

  push(chunk: string): ChatEvent[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.map((l) => l.trim()).filter((l) => l.length > 0).map(parseEvent).filter((e): e is ChatEvent => e !== null);
  }

  flush(): ChatEvent[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (!rest) return [];
    const event = parseEvent(rest);
    return event ? [event] : [];
  }
}

export const CHAT_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";
