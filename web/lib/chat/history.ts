// Reading stored messages back: the text of a content column, the tool-call
// records and citations, and the Anthropic message history the route sends
// on the next turn. Pure, shared by the route and the pane.

import type Anthropic from "@anthropic-ai/sdk";
import type { Json, MessageRow } from "@/lib/types/db";
import type { Card, Citation, ToolCallRecord } from "./cards";

/** messages.content is Anthropic-style blocks: [{ type: "text", text }]. */
export function textOfContent(content: Json): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block && typeof block === "object" && !Array.isArray(block) && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
    return (content as { text: string }).text;
  }
  return "";
}

function isRecord(v: unknown): v is Record<string, Json | undefined> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function toolCallsOf(value: Json | null | undefined): ToolCallRecord[] {
  if (!Array.isArray(value)) return [];
  const out: ToolCallRecord[] = [];
  for (const v of value) {
    if (!isRecord(v) || typeof v.name !== "string") continue;
    out.push({
      id: typeof v.id === "string" ? v.id : `${v.name}-${out.length}`,
      name: v.name,
      input: v.input ?? null,
      summary: typeof v.summary === "string" ? v.summary : "",
      card: isRecord(v.card) && typeof v.card.type === "string" ? (v.card as unknown as Card) : null,
      is_error: v.is_error === true,
      ...(typeof v.searches === "number" ? { searches: v.searches } : {}),
      ...(Array.isArray(v.nested) ? { nested: toolCallsOf(v.nested) } : {}),
    });
  }
  return out;
}

export function citationsOf(value: Json | null | undefined): Citation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => (isRecord(v) && typeof v.url === "string" ? [{ url: v.url, title: typeof v.title === "string" && v.title ? v.title : v.url }] : []));
}

export const HISTORY_LIMIT = 40;

/**
 * The transcript as the model sees it: user text, and assistant text with a
 * note of the tools it used (their summaries), so it remembers what it did
 * without replaying tool_use blocks. Starts with a user message.
 */
export function historyFromRows(rows: MessageRow[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const row of rows) {
    if (row.role === "user") {
      const text = textOfContent(row.content).trim();
      out.push({ role: "user", content: text || "(empty message)" });
    } else if (row.role === "assistant") {
      if (out.length === 0) continue; // the history must start with the user
      let text = textOfContent(row.content).trim();
      const tools = toolCallsOf(row.tool_calls);
      if (tools.length > 0) {
        const note = `[Tools used: ${tools.map((t) => `${t.name}${t.is_error ? " (failed)" : ""}: ${t.summary}`).join("; ")}]`;
        text = text ? `${text}\n\n${note}` : note;
      }
      if (text) out.push({ role: "assistant", content: text });
    }
  }
  return out;
}
