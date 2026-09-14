"use client";

// The chat pane: conversations, the files in context, messages with tool
// cards, the composer. A send streams POST /api/chat's events into the turn in
// flight, then reloads the stored rows so ids, tool calls and citations are
// final. The open file (/f/[fileId]) is attached by default.
//
// It is also the command line, in both directions. Before a message is sent to
// the model it is parsed for a transport, song, chain or rack command — "solo
// the drums", "loop bars 9 to 16", "next", "keep it". A sentence that is
// unmistakably one of those moves the control the mouse would have moved and
// never reaches the model; anything else, including every question, goes to the
// model exactly as before.
//
// The other direction is new: a turn carries a compact snapshot of the open
// session, and the model answers with `session_control` directives — the same
// commands, parsed by the same parser on the server (lib/chat/surfaces.ts) —
// which are put on the same bus here, exactly once, while the turn streams
// (directive.ts). So a sentence typed by the producer and a step chosen by the
// model take an identical path to the control, and both are echoed under the
// composer in the words the control uses.

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { btnQuiet, cx } from "@/components/ui";
import { streamChat } from "@/lib/api/chat";
import { api, errorMessage } from "@/lib/api/client";
import type { DirectiveCardStep, LoopSummary } from "@/lib/chat/cards";
import type { SessionSnapshot } from "@/lib/chat/surfaces";
import type { ChatEvent } from "@/lib/chat/protocol";
import { emitSessionCommand, onCommandResult } from "@/components/shell/sessionCommands";
import { useProcessing } from "@/components/processing/ProcessingProvider";
import { useSession } from "@/components/shell/SessionProvider";
import { onKeyboardResult } from "@/lib/pads/commands";
import { parseSessionCommand } from "@/lib/session/commands";
import { runDirective } from "./directive";
import { buildSessionSnapshot } from "./sessionSnapshot";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { ConversationRow, MessageRow } from "@/lib/types/db";
import { AttachmentChips } from "./AttachmentChips";
import { Composer } from "./Composer";
import { MessageList, type LiveTurn } from "./MessageList";
import type { CardActions, ConfirmCard } from "./ToolCard";

/** Selecting a loop from the chat: the surface listens for this with the loop id as `detail`. */
export const SELECT_LOOP_EVENT = "crateai:select-loop";
const TAB_EVENT = "crateai:tab";

function openFileIdFrom(pathname: string): string | null {
  return pathname.startsWith("/f/") ? (pathname.slice(3).split("/")[0] ?? null) : null;
}

export function ChatPane() {
  const lib = useLibrary();
  const router = useRouter();
  const pathname = usePathname();
  const openFileId = openFileIdFrom(pathname);
  const session = useSession();
  const processing = useProcessing();

  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [live, setLive] = useState<LiveTurn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [listOpen, setListOpen] = useState(false);
  const [attached, setAttached] = useState<string[]>([]);
  const [commandLog, setCommandLog] = useState<Array<{ id: number; said: string; text: string; ok: boolean }>>([]);
  const pendingCommand = useRef<string | null>(null);
  /** while a directive runs, its own runner logs each line with the step that caused it */
  const inDirective = useRef(false);
  /** directives run one after another, never at the same time */
  const directives = useRef<Promise<void>>(Promise.resolve());
  const logId = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);

  const logLine = useCallback((said: string, text: string, ok: boolean) => {
    setCommandLog((prev) => [...prev.slice(-3), { id: ++logId.current, said, text, ok }]);
  }, []);

  // The shell (or the processing dock, or the instrument) applies the command
  // and says what it did; that line is the echo, whether the sentence was typed
  // here or chosen by the model.
  useEffect(() => {
    const echo = (result: { text: string; ok: boolean }) => {
      if (inDirective.current) return;
      const said = pendingCommand.current ?? "";
      pendingCommand.current = null;
      logLine(said, result.text, result.ok);
    };
    const offSession = onCommandResult(echo);
    const offKeyboard = onKeyboardResult(echo);
    return () => {
      offSession();
      offKeyboard();
    };
  }, [logLine]);

  // the open file joins the conversation when it changes; detaching it is remembered until the next file opens
  const lastOpen = useRef<string | null>(null);
  useEffect(() => {
    if (openFileId && openFileId !== lastOpen.current) {
      lastOpen.current = openFileId;
      setAttached((prev) => (prev.includes(openFileId) ? prev : [openFileId, ...prev]));
    }
  }, [openFileId]);

  // ---- the session travels with the turn -----------------------------------
  // Only the controls; every measured value is read on the server from the
  // report row instead (components/chat/sessionSnapshot.ts).
  const songName = openFileId ? (lib.fileById(openFileId)?.title?.trim() || lib.fileById(openFileId)?.original_filename || null) : null;
  const snapshot = useCallback(
    (): SessionSnapshot =>
      buildSessionSnapshot({
        tracks: session.arrangement.tracks,
        regions: session.arrangement.regions,
        tempo: session.tempo,
        playing: session.playing,
        positionS: session.position(),
        loop: session.loop,
        masterGain: session.masterGain,
        snap: session.snap,
        selectedRegionId: session.selectedRegionId,
        undoLabel: session.undoLabel,
        redoLabel: session.redoLabel,
        processing: processing.state,
        focusTrackId: processing.focusTrackId,
        auditioning: session.auditioning,
        openFileId,
        songName,
      }),
    [session, processing, openFileId, songName],
  );

  // ---- and the model's steps come back the same way -------------------------
  // A turn may return more than one directive, and the buses are one-way, so
  // they are queued rather than raced: two runs listening at once would each
  // take the other's result line.
  const applyDirective = useCallback(
    (card: { steps: DirectiveCardStep[]; refused: Array<{ said: string; note: string }> }) => {
      directives.current = directives.current.then(async () => {
        for (const refusal of card.refused) logLine(refusal.said, refusal.note, false);
        if (card.steps.length === 0) return;
        inDirective.current = true;
        try {
          for (const result of await runDirective(card.steps)) logLine(result.said, result.text, result.ok);
        } finally {
          inDirective.current = false;
        }
      });
      return directives.current;
    },
    [logLine],
  );

  const loadConversations = useCallback(async () => {
    try {
      const res = await api.conversations.list();
      setConversations(res.conversations);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadMessages = useCallback(async (id: string) => {
    try {
      const res = await api.conversations.get(id);
      setMessages(res.messages);
      setAttached((prev) => {
        const fromRow = res.conversation.file_ids.filter((fid) => !prev.includes(fid));
        return fromRow.length > 0 ? [...prev, ...fromRow] : prev;
      });
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
  }, [messages, live]);

  // ---- surface actions: navigate to the file, then tell the surface ----------
  const pending = useRef<{ fileId: string; run: () => void } | null>(null);
  useEffect(() => {
    const p = pending.current;
    if (p && openFileId === p.fileId) {
      pending.current = null;
      window.setTimeout(p.run, 60);
    }
  }, [openFileId]);
  const goThen = useCallback(
    (fileId: string, run: () => void) => {
      if (openFileId === fileId) run();
      else {
        pending.current = { fileId, run };
        router.push(`/f/${fileId}`);
      }
    },
    [openFileId, router],
  );

  const send = useCallback(
    async (text: string, batch?: ConfirmCard) => {
      setError(null);
      // The command line. Only sentences that are unmistakably a transport or
      // rack command are taken; everything else is a conversation.
      if (!batch) {
        const command = parseSessionCommand(text);
        if (command) {
          pendingCommand.current = text.trim();
          emitSessionCommand(command);
          return;
        }
      }
      setLive({ userText: text, text: "", tools: [], citations: [], error: null, streaming: true });
      const onEvent = (e: ChatEvent) => {
        // Outside the state updater on purpose: React may call an updater more
        // than once, and a directive applied twice would move the control
        // twice. Every event arrives here exactly once.
        if (e.type === "tool_result" && e.card?.type === "directive") void applyDirective(e.card);
        setLive((prev) => {
          if (!prev) return prev;
          switch (e.type) {
            case "text":
              return { ...prev, text: prev.text + e.delta };
            case "tool_call":
              return { ...prev, tools: [...prev.tools, { id: e.id, name: e.name, input: e.input, summary: null, card: null, is_error: false, done: false }] };
            case "tool_result":
              // The card is only stored here; it was carried out above. A
              // stored card renders as a receipt and is never re-applied, or
              // reopening a conversation would replay every edit in it.
              return { ...prev, tools: prev.tools.map((t) => (t.id === e.id ? { ...t, summary: e.summary, card: e.card, is_error: e.is_error === true, done: true } : t)) };
            case "citations":
              return { ...prev, citations: e.items };
            case "error":
              return { ...prev, error: e.message };
            case "done":
              return { ...prev, streaming: false };
          }
        });
      };
      try {
        const res = await streamChat(
          {
            conversation_id: activeId,
            message: text,
            file_ids: attached,
            open_file_id: openFileId && attached.includes(openFileId) ? openFileId : null,
            session: snapshot(),
            ...(batch ? { batch: { operations: batch.operations, confirmed: true as const } } : {}),
          },
          onEvent,
        );
        const convId = res.done?.conversation_id ?? res.conversationId;
        if (convId) {
          if (convId !== activeId) setActiveId(convId);
          else await loadMessages(convId);
          void loadConversations();
        }
        setLive(null);
      } catch (err) {
        const message = errorMessage(err);
        setLive((prev) => (prev && (prev.text || prev.tools.length > 0) ? { ...prev, streaming: false, error: message } : null));
        setError(message);
      }
    },
    [activeId, attached, openFileId, loadMessages, loadConversations, snapshot, applyDirective],
  );

  const actions = useMemo<CardActions>(
    () => ({
      jobs: lib.jobs,
      openFile: (fileId) => router.push(`/f/${fileId}`),
      showLoop: (loop: LoopSummary) => goThen(loop.file_id, () => window.dispatchEvent(new CustomEvent(SELECT_LOOP_EVENT, { detail: loop.id }))),
      openTab: (fileId, tab) => goThen(fileId, () => window.dispatchEvent(new CustomEvent(TAB_EVENT, { detail: tab }))),
      confirmBatch: live ? null : (card) => void send(`Run the batch of ${card.operations.length} operations.`, card),
    }),
    [lib.jobs, router, goThen, live, send],
  );

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const busy = live !== null && live.streaming;

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
          <button
            type="button"
            className={btnQuiet}
            onClick={() => {
              setActiveId(null);
              setListOpen(false);
              setAttached(openFileId ? [openFileId] : []);
            }}
          >
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

      <AttachmentChips files={lib.files} attached={attached} openFileId={openFileId} onToggle={(id, on) => setAttached((prev) => (on ? [...prev.filter((x) => x !== id), id] : prev.filter((x) => x !== id)))} />

      <div ref={scroller} className="flex-1 min-h-0 overflow-y-auto">
        {messages.length === 0 && live === null && (
          <p className="px-4 py-3 text-sm text-chalk-dim">
            Ask about the open file or tell the library what to do: find the loop under the hook, separate the stems, put these drums under that
            sample, who produced this. Musical facts come from the analysis, world facts from cited pages, and everything the chat makes lands on the
            panel where you can hear it and change it. The transport answers here too: <span className="text-chalk">play</span>,{" "}
            <span className="text-chalk">loop bars 9 to 16</span>, <span className="text-chalk">solo the drums</span>,{" "}
            <span className="text-chalk">next</span>, <span className="text-chalk">keep it</span>.
          </p>
        )}
        <MessageList messages={messages} live={live} actions={actions} />
        {error && live === null && (
          <p role="alert" className="mx-4 my-2 text-xs border-l-2 border-pad pl-2">
            {error}
          </p>
        )}
      </div>

      {commandLog.length > 0 && (
        <ul className="shrink-0 border-t border-rule px-4 py-1" aria-live="polite">
          {commandLog.map((entry) => (
            <li key={entry.id} className="text-xs text-chalk-dim flex items-baseline gap-2">
              <span aria-hidden className={entry.ok ? "text-pad" : "text-chalk-faint"}>
                ▸
              </span>
              <span className="truncate" title={entry.said}>
                {entry.text}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Composer disabled={busy} onSend={(text) => send(text)} />
    </div>
  );
}
