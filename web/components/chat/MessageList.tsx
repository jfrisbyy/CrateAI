"use client";

// Messages, with tool-call cards and citations rendered from the stored
// columns when present (Phase 8 fills them; the renderers are final).

import { cx } from "@/components/ui";
import type { Json, MessageRow } from "@/lib/types/db";

export function textOf(content: Json): string {
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

interface ToolCall {
  name: string;
  input?: Json;
  output?: Json;
  status?: string;
}

function toolCallsOf(value: Json | null): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) =>
    v && typeof v === "object" && !Array.isArray(v) && typeof v.name === "string"
      ? [{ name: v.name, input: v.input, output: v.output ?? v.result, status: typeof v.status === "string" ? v.status : undefined }]
      : [],
  );
}

interface Citation {
  title: string;
  url: string;
}

function citationsOf(value: Json | null): Citation[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) =>
    v && typeof v === "object" && !Array.isArray(v) && typeof v.url === "string"
      ? [{ url: v.url, title: typeof v.title === "string" && v.title ? v.title : v.url }]
      : [],
  );
}

function short(value: Json | undefined): string {
  if (value === undefined) return "";
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > 240 ? `${s.slice(0, 237)}...` : s;
}

export function MessageList({
  messages,
  pendingUser,
  streamingAssistant,
}: {
  messages: MessageRow[];
  pendingUser: string | null;
  streamingAssistant: string | null;
}) {
  return (
    <ol className="flex flex-col">
      {messages.map((m) => (
        <Message key={m.id} role={m.role} text={textOf(m.content)} toolCalls={toolCallsOf(m.tool_calls)} citations={citationsOf(m.citations)} />
      ))}
      {pendingUser !== null && <Message role="user" text={pendingUser} toolCalls={[]} citations={[]} />}
      {streamingAssistant !== null && <Message role="assistant" text={streamingAssistant || "…"} toolCalls={[]} citations={[]} streaming />}
    </ol>
  );
}

function Message({
  role,
  text,
  toolCalls,
  citations,
  streaming,
}: {
  role: MessageRow["role"];
  text: string;
  toolCalls: ToolCall[];
  citations: Citation[];
  streaming?: boolean;
}) {
  return (
    <li className={cx("px-4 py-2 border-b border-rule", role === "user" && "bg-slate")}>
      <div className="text-xs text-chalk-dim mb-0.5">{role === "user" ? "You" : role === "assistant" ? "CrateAI" : "Tool"}</div>
      {text && <p className={cx("text-sm whitespace-pre-wrap break-words", streaming && "text-chalk-dim")}>{text}</p>}
      {toolCalls.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-1">
          {toolCalls.map((call, i) => (
            <li key={i} className="border-l-2 border-rule pl-2 text-xs">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-chalk">{call.name}</span>
                {call.status && <span className="text-chalk-dim">{call.status}</span>}
              </div>
              {call.input !== undefined && <div className="font-mono text-chalk-dim break-all">{short(call.input)}</div>}
              {call.output !== undefined && <div className="font-mono text-chalk break-all">{short(call.output)}</div>}
            </li>
          ))}
        </ul>
      )}
      {citations.length > 0 && (
        <ol className="mt-1.5 flex flex-col gap-0.5 text-xs">
          {citations.map((c, i) => (
            <li key={i} className="flex gap-2 min-w-0">
              <span className="font-mono text-chalk-dim shrink-0">[{i + 1}]</span>
              <a href={c.url} target="_blank" rel="noreferrer noopener" className="truncate underline underline-offset-2 hover:text-pad">
                {c.title}
              </a>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
