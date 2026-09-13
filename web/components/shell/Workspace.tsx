"use client";

// The adaptive layout (direction document, Surface 3).
//
// The page is a chat. When an object appears — a file's working surface, a
// rack of candidates, the session's lanes — a panel slides in from the side
// and the chat narrows to make room, the way an artifact does. The rules that
// keep it from becoming a mess are all here and all visible:
//
//   One surface at a time, with history. The panel shows the object under
//   discussion; going back to the last one is a click and re-runs nothing
//   (components/shell/surfaceStack.ts, tested).
//
//   The chat is the command line. A sentence goes through the same controls
//   the mouse does, and says so (sessionCommands.ts, and the parser in
//   lib/session/commands.ts, tested).
//
//   Resizable and dismissible. The divider drags, the panel collapses to a
//   full-width chat, and where the producer left it is remembered.
//
//   Nothing modal. The transport strip is below everything and always live:
//   auditioning does not block the chat, and a render in flight does not stop
//   what is already playing.

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChatPane } from "@/components/chat/ChatPane";
import { LibraryPane } from "@/components/library/LibraryPane";
import { RackPanel } from "@/components/rack/RackPanel";
import { openRack, rackKey } from "@/components/rack/rackEvents";
import { useRack } from "@/components/rack/useRack";
import { btnQuiet, cx } from "@/components/ui";
import { handleKeydown, onCommand, onPad } from "@/lib/keys/commands";
import { ALL_TRACKS, describeCommand, resolveTarget, type SessionCommand } from "@/lib/session/commands";
import { candidateAt, stepCandidate } from "@/lib/session/rack";
import { loopForBars } from "@/lib/session/time";
import { useLibrary } from "@/lib/state/LibraryProvider";
import { KeymapSheet } from "./KeymapSheet";
import { SearchProvider } from "./searchState";
import { SessionPanel } from "./SessionPanel";
import { SessionProvider, useSession } from "./SessionProvider";
import { emitCommandResult, onSessionCommand } from "./sessionCommands";
import {
  canGoBack,
  canGoForward,
  clampSplit,
  closePanel,
  currentSurface,
  DEFAULT_SPLIT,
  EMPTY_STACK,
  goBack,
  goForward,
  goTo,
  isRoute,
  openPanel,
  pushSurface,
  splitFromPointer,
  type StackState,
} from "./surfaceStack";
import { TopBar } from "./TopBar";
import { TransportBar } from "./TransportBar";

const SPLIT_KEY = "crateai:panel-split";

export function Workspace({ children }: { children: ReactNode }) {
  return (
    <SearchProvider>
      <SessionProvider>
        <Shell>{children}</Shell>
      </SessionProvider>
    </SearchProvider>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const lib = useLibrary();
  const session = useSession();
  const [stack, setStack] = useState<StackState>(EMPTY_STACK);
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const [libraryOpen, setLibraryOpen] = useState(true);
  const [keymapOpen, setKeymapOpen] = useState(false);
  const [padNote, setPadNote] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const areaRef = useRef<HTMLDivElement>(null);

  const openFileId = pathname.startsWith("/f/") ? (pathname.slice(3).split("/")[0] ?? null) : null;
  const rackState = useRack(openFileId);
  const current = currentSurface(stack);

  // ---- the panel follows the route -----------------------------------------
  // The chat is the page; everything the router renders is an object on the
  // panel. "/" renders nothing, which is what makes the first screen a chat.
  const openFile = openFileId ? lib.fileById(openFileId) : undefined;
  const routeKind: "file" | "page" | null = pathname === "/" ? null : openFileId ? "file" : "page";
  const routeId = openFileId ?? pathname;
  const routeTitle = openFileId ? openFile?.title?.trim() || openFile?.original_filename || "Loading" : titleForPath(pathname);
  useEffect(() => {
    if (!routeKind) return;
    setStack((prev) => pushSurface(prev, { kind: routeKind, id: routeId, title: routeTitle }));
  }, [routeKind, routeId, routeTitle]);

  // a rack arriving is an object appearing: the panel slides in with it
  const rack = rackState.rack;
  const rackRequest = rackState.request;
  const rackTitle = rack?.title ?? null;
  const rackNote = rack?.note ?? null;
  useEffect(() => {
    if (!rackRequest) return;
    setStack((prev) => pushSurface(prev, { kind: "rack", id: rackKey(rackRequest), title: rackTitle ?? "Rack", note: rackNote }));
  }, [rackRequest, rackTitle, rackNote]);

  // the rack's source tempo becomes the session's grid, once, if it has none
  const adoptTempo = session.adoptTempo;
  const sourceBpm = rack?.source?.bpm ?? null;
  useEffect(() => {
    if (sourceBpm) adoptTempo(sourceBpm);
  }, [sourceBpm, adoptTempo]);

  const showSession = useCallback(() => setStack((prev) => pushSurface(prev, { kind: "session", id: "session", title: "The session" })), []);

  // ---- the divider ---------------------------------------------------------
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SPLIT_KEY);
      if (stored !== null) setSplit(clampSplit(Number(stored)));
    } catch {
      // private mode, or storage turned off: the default is fine
    }
  }, []);
  const remember = useCallback((value: number) => {
    try {
      window.localStorage.setItem(SPLIT_KEY, String(value));
    } catch {
      // nothing to do; the layout still works for this session
    }
  }, []);
  const dragTo = useCallback((clientX: number) => {
    const area = areaRef.current?.getBoundingClientRect();
    if (!area) return;
    setSplit(splitFromPointer(clientX, area.left, area.width));
  }, []);

  // ---- the chat's command line ---------------------------------------------
  const apply = useCallback(
    (command: SessionCommand) => {
      const say = (text: string, ok = true) => emitCommandResult({ text, ok });
      switch (command.kind) {
        case "play":
          session.play();
          return say(describeCommand(command));
        case "pause":
          session.pause();
          return say(describeCommand(command));
        case "stop":
          session.stop();
          return say(describeCommand(command));
        case "loop-off":
          session.setLoop(null);
          return say(describeCommand(command));
        case "loop-seconds":
          session.setLoop({ startS: command.fromS, endS: command.toS });
          return say(describeCommand(command));
        case "loop-bars": {
          const loop = loopForBars(command.fromBar, command.toBar, session.tempo);
          if (!loop) return say("the session has no measured tempo yet, so it has no bars. Say it in seconds, or commit something with a tempo.", false);
          session.setLoop(loop);
          return say(describeCommand(command));
        }
        case "mute":
        case "solo": {
          const ids = resolveTarget(command.target, session.tracks);
          if (!ids || ids.length === 0) return say(`nothing in the session is called ${command.target === ALL_TRACKS ? "that" : command.target}.`, false);
          for (const id of ids) {
            if (command.kind === "mute") session.setMute(id, command.on);
            else session.setSolo(id, command.on);
          }
          return say(describeCommand(command));
        }
        case "gain": {
          const ids = resolveTarget(command.target, session.tracks);
          if (!ids || ids.length === 0) return say(`nothing in the session is called ${command.target}.`, false);
          for (const id of ids) session.nudgeGain(id, command.db);
          return say(describeCommand(command));
        }
        case "audition": {
          const candidate = candidateAt(rack, command.index);
          if (!candidate) return say(`there is no candidate ${command.index} in the rack.`, false);
          void session.audition(candidate);
          return say(`auditioning ${candidate.title}`);
        }
        case "audition-next":
        case "audition-previous": {
          const next = stepCandidate(rack, session.auditioning, command.kind === "audition-next" ? 1 : -1);
          if (!next) return say("that is the end of the rack.", false);
          void session.audition(next);
          return say(`auditioning ${next.title}`);
        }
        case "audition-off":
          void session.audition(null);
          return say(describeCommand(command));
        case "commit": {
          const candidate = session.auditioning;
          if (!candidate) return say("nothing is auditioning, so there is nothing to keep.", false);
          void session.commit(candidate);
          return say(`kept ${candidate.title}`);
        }
        case "rack":
          openRack({ source: "search", query: command.query });
          return say(describeCommand(command));
        case "rack-fits":
        case "rack-loops":
          if (!openFileId) return say("no file is open, so there is nothing to rack against.", false);
          openRack(command.kind === "rack-fits" ? { source: "compat", fileId: openFileId } : { source: "loops", fileId: openFileId });
          return say(describeCommand(command));
        case "panel":
          setStack((prev) => (command.action === "close" ? closePanel(prev) : goBack(prev)));
          return say(describeCommand(command));
      }
    },
    [session, rack, openFileId],
  );
  useEffect(() => onSessionCommand(apply), [apply]);

  // ---- keyboard ------------------------------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (handleKeydown(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    const offCommand = onCommand((c) => {
      if (c === "keymap") setKeymapOpen((v) => !v);
    });
    let timer = 0;
    const offPad = onPad(({ pad, key }) => {
      setPadNote(`Pad ${pad} (${key}) — pads fill with chops in Phase 3`);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPadNote(null), 1400);
    });
    return () => {
      window.removeEventListener("keydown", onKey);
      offCommand();
      offPad();
      window.clearTimeout(timer);
    };
  }, []);

  const panelOpen = stack.open && current !== null;
  const columns = useMemo(() => (libraryOpen ? "288px minmax(0, 1fr)" : "minmax(0, 1fr)"), [libraryOpen]);

  return (
    <>
      <div className="h-full flex flex-col overflow-hidden">
        <TopBar
          panelOpen={panelOpen}
          canOpenPanel={current !== null}
          onTogglePanel={() => setStack((prev) => (prev.open ? closePanel(prev) : openPanel(prev)))}
          libraryOpen={libraryOpen}
          onToggleLibrary={() => setLibraryOpen((v) => !v)}
          onKeymap={() => setKeymapOpen(true)}
          padNote={padNote}
        />

        <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: columns }}>
          {libraryOpen && (
            <aside className="min-h-0 border-r border-rule flex flex-col" aria-label="Library">
              <LibraryPane />
            </aside>
          )}

          <div ref={areaRef} className="min-h-0 min-w-0 flex">
            <section className="min-h-0 min-w-0 flex flex-col" style={{ flex: panelOpen ? `0 0 ${((1 - split) * 100).toFixed(3)}%` : "1 1 100%" }} aria-label="Chat">
              <div className={cx("flex-1 min-h-0 flex flex-col w-full", !panelOpen && "max-w-[820px] mx-auto")}>
                <ChatPane />
              </div>
            </section>

            {panelOpen && (
              <Divider
                split={split}
                onDrag={dragTo}
                onCommit={remember}
                onSet={(v) => {
                  setSplit(v);
                  remember(v);
                }}
              />
            )}

            {panelOpen && current && (
              <section className="min-h-0 min-w-0 flex flex-col border-l border-rule" style={{ flex: `1 1 ${(split * 100).toFixed(3)}%` }} aria-label="Surface">
                <div className="shrink-0 h-9 border-b border-rule px-3 flex items-center gap-2 min-w-0">
                  <button type="button" className={btnQuiet} onClick={() => setStack(goBack)} disabled={!canGoBack(stack)} title="Back to the last object; nothing is re-run" aria-label="Back">
                    ←
                  </button>
                  <button type="button" className={btnQuiet} onClick={() => setStack(goForward)} disabled={!canGoForward(stack)} aria-label="Forward">
                    →
                  </button>
                  <button
                    type="button"
                    className="text-sm truncate text-left hover:text-pad min-w-0 flex items-baseline gap-2"
                    onClick={() => setHistoryOpen((v) => !v)}
                    aria-expanded={historyOpen}
                    title="Everything this conversation has put on the panel"
                  >
                    <span className="truncate">{current.title}</span>
                    <span className="font-mono text-xs text-chalk-dim shrink-0">
                      {stack.index + 1}/{stack.entries.length}
                    </span>
                  </button>
                  {current.kind === "file" && (
                    <span className="ml-auto flex items-center gap-1">
                      <button
                        type="button"
                        className={btnQuiet}
                        onClick={() => openRack({ source: "compat", fileId: current.id })}
                        title="Everything in the crate that fits this, as a rack you can play"
                      >
                        What fits this
                      </button>
                      <button type="button" className={btnQuiet} onClick={() => openRack({ source: "loops", fileId: current.id })} title="The loops found in this file, as a rack you can play">
                        Loops here
                      </button>
                    </span>
                  )}
                  <button type="button" className={cx(btnQuiet, current.kind !== "file" && "ml-auto")} onClick={() => setStack(closePanel)} title="Dismiss the panel and get the full-width chat back">
                    Close
                  </button>
                </div>

                {historyOpen && (
                  <ul className="shrink-0 border-b border-rule max-h-[30vh] overflow-y-auto">
                    {stack.entries.map((entry, i) => (
                      <li key={`${entry.kind}:${entry.id}`}>
                        <button
                          type="button"
                          className={cx("w-full text-left px-3 py-1.5 text-sm truncate hover:bg-slate flex items-baseline gap-2", i === stack.index && "bg-slate")}
                          onClick={() => {
                            setStack((prev) => goTo(prev, i));
                            setHistoryOpen(false);
                          }}
                        >
                          <span className="text-xs text-chalk-dim w-[52px] shrink-0">{entry.kind}</span>
                          <span className="truncate">{entry.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}

                <div className="flex-1 min-h-0 relative">
                  {/* The file surface stays mounted and keeps its size, so coming
                      back to it is a click rather than a reload. */}
                  <div className="absolute inset-0 flex flex-col overflow-y-auto" style={isRoute(current) ? undefined : { visibility: "hidden", pointerEvents: "none" }} aria-hidden={!isRoute(current)}>
                    {children}
                  </div>
                  {current.kind === "rack" && (
                    <div className="absolute inset-0 flex flex-col">
                      <RackPanel state={rackState} />
                    </div>
                  )}
                  {current.kind === "session" && (
                    <div className="absolute inset-0 flex flex-col overflow-y-auto">
                      <SessionPanel />
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>
        </div>

        <TransportBar onOpenSession={showSession} />
      </div>
      <KeymapSheet open={keymapOpen} onClose={() => setKeymapOpen(false)} />
    </>
  );
}

/** "/account" -> "Account". The panel needs a name for a route that is not a file. */
function titleForPath(pathname: string): string {
  const segment = pathname.split("/").filter(Boolean)[0] ?? "";
  if (segment === "") return "Workspace";
  return segment.charAt(0).toUpperCase() + segment.slice(1);
}

/** The draggable divider. Keyboard-reachable, because the mouse is not the only way in. */
function Divider({ split, onDrag, onCommit, onSet }: { split: number; onDrag: (clientX: number) => void; onCommit: (value: number) => void; onSet: (value: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuenow={Math.round(split * 100)}
      aria-valuemin={28}
      aria-valuemax={74}
      tabIndex={0}
      className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-rule focus-visible:bg-pad"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        onDrag(e.clientX);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) onDrag(e.clientX);
      }}
      onPointerUp={(e) => {
        e.currentTarget.releasePointerCapture(e.pointerId);
        onCommit(split);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") onSet(clampSplit(split + 0.04));
        else if (e.key === "ArrowRight") onSet(clampSplit(split - 0.04));
        else return;
        e.preventDefault();
      }}
    />
  );
}
