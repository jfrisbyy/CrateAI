"use client";

// Messages: text, tool rows (name, summary, card) and citations as a
// footnote list, from the stored rows; and the turn in flight, rendered from
// the stream events as they arrive.

import { cx } from "@/components/ui";
import type { Card, Citation } from "@/lib/chat/cards";
import { citationsOf, textOfContent, toolCallsOf } from "@/lib/chat/history";
import type { Json, MessageRow } from "@/lib/types/db";
import { ToolCardView, type CardActions } from "./ToolCard";

export interface LiveTool {
  id: string;
  name: string;
  input: Json;
  summary: string | null;
  card: Card | null;
  is_error: boolean;
  done: boolean;
}

export interface LiveTurn {
  userText: string;
  text: string;
  tools: LiveTool[];
  citations: Citation[];
  error: string | null;
  streaming: boolean;
}

export function MessageList({ messages, live, actions }: { messages: MessageRow[]; live: LiveTurn | null; actions: CardActions }) {
  return (
    <ol className="flex flex-col">
      {messages.map((m) => (
        <Message
          key={m.id}
          role={m.role}
          text={textOfContent(m.content)}
          tools={toolCallsOf(m.tool_calls).map((t) => ({ id: t.id, name: t.name, input: t.input, summary: t.summary, card: t.card, is_error: t.is_error, done: true }))}
          citations={citationsOf(m.citations)}
          actions={actions}
        />
      ))}
      {live && (
        <>
          <Message role="user" text={live.userText} tools={[]} citations={[]} actions={actions} />
          <Message role="assistant" text={live.text} tools={live.tools} citations={live.citations} actions={actions} streaming={live.streaming} />
          {live.error && (
            <li role="alert" className="mx-4 my-2 text-xs border-l-2 border-pad pl-2">
              {live.error}
            </li>
          )}
        </>
      )}
    </ol>
  );
}

function Message({
  role,
  text,
  tools,
  citations,
  actions,
  streaming,
}: {
  role: MessageRow["role"];
  text: string;
  tools: LiveTool[];
  citations: Citation[];
  actions: CardActions;
  streaming?: boolean;
}) {
  const empty = !text && tools.length === 0;
  return (
    <li className={cx("px-4 py-2 border-b border-rule", role === "user" && "bg-slate")}>
      <div className="text-xs text-chalk-dim mb-0.5">{role === "user" ? "You" : role === "assistant" ? "CrateAI" : "Tool"}</div>
      {tools.length > 0 && (
        <ul className="mb-1.5 flex flex-col gap-1">
          {tools.map((t) => (
            <li key={t.id} className="border-l-2 border-rule pl-2 text-xs">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="font-mono text-chalk shrink-0">{t.name}</span>
                <span className={cx("truncate", t.is_error ? "text-chalk" : "text-chalk-dim")}>{t.done ? (t.summary ?? "") : "running"}</span>
                {!t.done && <span className="ml-auto inline-block w-1.5 h-1.5 rounded-full bg-pad shrink-0" aria-label="running" />}
              </div>
              {t.card && (
                <div className="mt-0.5">
                  <ToolCardView card={t.card} actions={actions} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {(text || streaming) && (
        <p className="text-sm whitespace-pre-wrap break-words">
          {text}
          {streaming && <span className="inline-block w-1.5 h-3 ml-0.5 align-middle bg-pad" aria-hidden />}
        </p>
      )}
      {empty && !streaming && <p className="text-sm text-chalk-dim">(no text)</p>}
      {citations.length > 0 && (
        <ol className="mt-1.5 flex flex-col gap-0.5 text-xs">
          {citations.map((c, i) => (
            <li key={`${c.url}-${i}`} className="flex gap-2 min-w-0">
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
