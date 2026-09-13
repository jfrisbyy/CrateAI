"use client";

// Right pane: conversations, messages, composer. Sends go through the
// streaming /api/chat route; the client reads the text stream and then
// reloads the stored messages so ids, tool calls and citations are final.

import { useCallback, useEffect, useRef, useState } from "react";
import { btnQuiet, cx } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import type { ConversationRow, MessageRow } from "@/lib/types/db";
import { Composer } from "./Composer";
import { MessageList } from "./MessageList";

export function ChatPane() {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [streaming, setStreaming] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listOpen, setListOpen] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const loadConversations = useCallback(async () => {
    try {
      const res = await api.conversations.list();
      setConversations(res.conversations);
      return res.conversations;
    } catch (err) {
      setError(errorMessage(err));
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    try {
      const res = await api.conversations.get(id);
      setMessages(res.messages);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (activeId) void loadMessages(activeId);
    else setMessages([]);
  }, [activeId, loadMessages]);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, pending]);

  const send = async (text: string) => {
    setError(null);
    setPending(text);
    setStreaming("");
    try {
      const res = await api.chat({ conversation_id: activeId, content: text });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `Chat failed (${res.status}).`);
      }
      const convId = res.headers.get("x-conversation-id");
      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      let acc = "";
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          acc += decoder.decode(value, { stream: true });
          setStreaming(acc);
        }
      }
      if (convId) {
        if (convId !== activeId) setActiveId(convId);
        else await loadMessages(convId);
        void loadConversations();
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
      setStreaming(null);
    }
  };

  const active = conversations.find((c) => c.id === activeId) ?? null;

  return (
    <div className="flex flex-col min-h-0 h-full">
      <div className="shrink-0 border-b border-rule">
        <div className="h-9 px-4 flex items-center justify-between gap-2">
          <button
            type="button"
            className="text-sm truncate text-left hover:text-pad flex items-center gap-2 min-w-0"
            onClick={() => setListOpen((v) => !v)}
            aria-expanded={listOpen}
            aria-controls="conversation-list"
          >
            <span className="truncate">{active?.title?.trim() || (activeId ? "Untitled" : "New conversation")}</span>
            <span className="font-mono text-xs text-chalk-dim shrink-0">{conversations.length}</span>
          </button>
          <button type="button" className={btnQuiet} onClick={() => (setActiveId(null), setListOpen(false))}>
            New
          </button>
        </div>
        {listOpen && (
          <ul id="conversation-list" className="max-h-[40vh] overflow-y-auto border-t border-rule">
            {loading && <li className="px-4 py-2 text-xs text-chalk-dim">Loading.</li>}
            {!loading && conversations.length === 0 && <li className="px-4 py-2 text-xs text-chalk-dim">No conversations yet.</li>}
            {conversations.map((c) => (
              <li key={c.id} className="border-b border-rule last:border-b-0">
                <button
                  type="button"
                  className={cx("w-full text-left px-4 py-1.5 text-sm truncate hover:bg-slate", c.id === activeId && "bg-slate")}
                  onClick={() => {
                    setActiveId(c.id);
                    setListOpen(false);
                  }}
                >
                  {c.title?.trim() || "Untitled"}
                  <span className="ml-2 font-mono text-xs text-chalk-dim">{c.updated_at.slice(5, 16).replace("T", " ")}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto">
        {messages.length === 0 && pending === null && (
          <p className="px-4 py-3 text-sm text-chalk-dim">
            Ask about the open file, or tell the library what to do. The tools that act on audio arrive in Phase 8; until then
            replies say so and your messages are kept.
          </p>
        )}
        <MessageList messages={messages} pendingUser={pending} streamingAssistant={streaming} />
        {error && (
          <p role="alert" className="mx-4 my-2 text-xs border-l-2 border-pad pl-2">
            {error}
          </p>
        )}
      </div>

      <Composer disabled={pending !== null} onSend={send} />
    </div>
  );
}
