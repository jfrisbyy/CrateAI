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
import { ProcessingDock } from "@/components/processing/ProcessingDock";
import { ProcessingProvider } from "@/components/processing/ProcessingProvider";
import { LibraryPane } from "@/components/library/LibraryPane";
import { FirstRun } from "@/components/onboarding/FirstRun";
import { RackPanel } from "@/components/rack/RackPanel";
import { openRack, rackKey } from "@/components/rack/rackEvents";
import { useRack } from "@/components/rack/useRack";
import { SongSurface } from "@/components/timeline/SongSurface";
import { emitTimelineView } from "@/components/timeline/timelineEvents";
import { btnQuiet, cx } from "@/components/ui";
import { handleKeydown, onCommand, onPad } from "@/lib/keys/commands";
import type { SessionCommand } from "@/lib/session/commands";
import { useLibrary } from "@/lib/state/LibraryProvider";
import { applySessionCommand } from "./applyCommand";
import { Divider } from "./Divider";
import { KeymapSheet } from "./KeymapSheet";
import { SearchProvider } from "./searchState";
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
        {/* The chain lives beside the transport, not on the panel: an EQ is a
            control you use while listening to an object, not an object. */}
        <ProcessingProvider>
          <Shell>{children}</Shell>
        </ProcessingProvider>
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

  const showSession = useCallback(() => setStack((prev) => pushSurface(prev, { kind: "session", id: "session", title: "The song" })), []);

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
  // The parser is lib/session/commands.ts and the half that moves the controls
  // is applyCommand.ts. Both are shared with the prototype at /demo, so a
  // sentence goes through exactly one implementation.
  const apply = useCallback(
    (command: SessionCommand) => {
      emitCommandResult(
        applySessionCommand(command, {
          session,
          rack,
          openFileId,
          showSong: showSession,
          panel: (action) => setStack((prev) => (action === "close" ? closePanel(prev) : goBack(prev))),
          openRack,
          zoom: (direction) => emitTimelineView({ kind: "zoom", direction }),
        }),
      );
    },
    [session, rack, openFileId, showSession],
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
                {/* The first run lives above the chat in the same column: an
                    empty crate, the first analysis as it happens, what it
                    measured, or what landed since the last session. It renders
                    nothing once there is nothing true left to say
                    (components/onboarding/FirstRun.tsx). */}
                <FirstRun />
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
                    <div className="absolute inset-0 flex flex-col">
                      <SongSurface />
                    </div>
                  )}
                </div>
              </section>
            )}
          </div>
        </div>

        <ProcessingDock />
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
