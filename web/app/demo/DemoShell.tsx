"use client";

// The prototype's workspace.
//
// It is components/shell/Workspace with three things removed — the router, the
// library's network, and the model — and nothing added. The panel history is
// the same tested reducer (surfaceStack.ts), the divider is the same component,
// the command line is the same parser and the same dispatcher
// (applyCommand.ts), and the three tenants of the panel are the product's own
// RackPanel and SongSurface on the product's own SessionProvider.
//
// The one thing this file does that Workspace does not is answer a rack
// request from memory instead of from /api/compat and /api/loops. The rows
// themselves are built by the same builders from the same measurements
// (lib/demo/material.ts).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RackPanel } from "@/components/rack/RackPanel";
import { onRackRequest, rackKey, type RackRequest } from "@/components/rack/rackEvents";
import type { RackState } from "@/components/rack/useRack";
import { applySessionCommand } from "@/components/shell/applyCommand";
import { Divider } from "@/components/shell/Divider";
import { SessionProvider, useSession } from "@/components/shell/SessionProvider";
import { emitCommandResult, onSessionCommand } from "@/components/shell/sessionCommands";
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
  openPanel,
  pushSurface,
  splitFromPointer,
  type StackState,
} from "@/components/shell/surfaceStack";
import { TransportBar } from "@/components/shell/TransportBar";
import { SongSurface } from "@/components/timeline/SongSurface";
import { emitTimelineView } from "@/components/timeline/timelineEvents";
import { btn, btnQuiet, cx } from "@/components/ui";
import { demoSourceLoader } from "@/lib/demo/audio";
import { bedCandidate, bedVitals, demoCompatRack, demoLoopsRack, DEMO_USER_ID, type DemoLibrary } from "@/lib/demo/material";
import type { SessionCommand } from "@/lib/session/commands";
import { gainFromDb } from "@/lib/session/mix";
import type { Rack } from "@/lib/session/rack";
import { LibraryProvider } from "@/lib/state/LibraryProvider";
import { DemoChat } from "./DemoChat";
import { DemoCrate } from "./DemoCrate";
import type { DemoStep } from "./script";

const SPLIT_KEY = "crateai:demo-split";
/** Under this the chat and the panel stop sharing the width and take turns. */
const NARROW_PX = 900;
/** The record the demo's second rack finds loops in. */
const LOOPS_IN = "demo-masquerade-drums";

export function DemoShell({ library }: { library: DemoLibrary }) {
  const loadSource = useMemo(() => demoSourceLoader(library.pcm), [library]);
  return (
    <LibraryProvider userId={DEMO_USER_ID} userEmail={null} initialFiles={[...library.files]} initialJobs={[]}>
      <SessionProvider loadSource={loadSource}>
        <Inside library={library} />
      </SessionProvider>
    </LibraryProvider>
  );
}

function Inside({ library }: { library: DemoLibrary }) {
  const session = useSession();
  const [stack, setStack] = useState<StackState>(EMPTY_STACK);
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const [crateOpen, setCrateOpen] = useState(true);
  const [done, setDone] = useState<ReadonlySet<string>>(new Set());
  const [rack, setRack] = useState<{ rack: Rack | null; request: RackRequest | null }>({ rack: null, request: null });
  const areaRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();

  const racks = useMemo(() => ({ fits: demoCompatRack(library), loops: demoLoopsRack(library) }), [library]);
  const current = currentSurface(stack);
  const panelOpen = stack.open && current !== null;

  // ---- the panel -----------------------------------------------------------
  const showSong = useCallback(() => setStack((prev) => pushSurface(prev, { kind: "session", id: "session", title: "The song" })), []);

  /**
   * Answer a rack request. The app fetches; this picks one of the two racks it
   * has. Everything after this point — the rows, the order, the reasons, the
   * audition — is the same code either way.
   */
  const openDemoRack = useCallback(
    (request: RackRequest) => {
      // The demo has two racks, so every ask resolves to one of them and is
      // re-keyed to the one it got: the panel's history then holds one entry
      // per object rather than one per phrasing.
      const answered: RackRequest =
        request.source === "loops" ? { source: "loops", fileId: LOOPS_IN } : { source: "compat", fileId: library.bed.id };
      const next = answered.source === "loops" ? racks.loops : racks.fits;
      setRack({ rack: next, request: answered });
      setStack((prev) => pushSurface(prev, { kind: "rack", id: rackKey(answered), title: next.title, note: next.note }));
      // The grid comes from the record the session is built on, never from a
      // candidate: a rack of loops inside an 88.5 BPM break must not re-bar a
      // 92 BPM song.
      session.adoptTempo(bedVitals(library).bpm);
    },
    [racks, session, library],
  );
  useEffect(() => onRackRequest(openDemoRack), [openDemoRack]);

  const rackState: RackState = useMemo(
    () => ({
      rack: rack.rack,
      loading: false,
      error: null,
      request: rack.request,
      open: async (request: RackRequest) => openDemoRack(request),
      reload: async () => {
        if (rack.request) openDemoRack(rack.request);
      },
      clear: () => setRack({ rack: null, request: null }),
    }),
    [rack, openDemoRack],
  );

  // ---- the script's four steps ---------------------------------------------
  const runStep = useCallback(
    (step: DemoStep) => {
      setDone((prev) => new Set([...prev, step.id]));
      switch (step.action) {
        case "commit-bed":
          // The record's own measured tempo becomes the session's grid; the
          // four bars become a lane. Both through the real path, and both on a
          // click, which is also the gesture the AudioContext needs.
          session.adoptTempo(bedVitals(library).bpm);
          // Headroom for three lanes at once (the bed, a committed break and
          // another one auditioning under it). Set once, on the empty session,
          // so pressing this twice does not undo a fader the producer moved.
          if (session.tracks.length === 0) session.setMasterGain(gainFromDb(-3));
          void session.commit(bedCandidate(library));
          showSong();
          return;
        case "rack-fits":
          return openDemoRack({ source: "compat", fileId: library.bed.id });
        case "rack-loops":
          return openDemoRack({ source: "loops", fileId: LOOPS_IN });
        case "song":
          return showSong();
      }
    },
    [library, session, showSong, openDemoRack],
  );

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

  // ---- the command line ----------------------------------------------------
  const apply = useCallback(
    (command: SessionCommand) => {
      emitCommandResult(
        applySessionCommand(command, {
          session,
          rack: rack.rack,
          openFileId: library.bed.id,
          showSong,
          panel: (action) => setStack((prev) => (action === "close" ? closePanel(prev) : goBack(prev))),
          openRack: openDemoRack,
          zoom: (direction) => emitTimelineView({ kind: "zoom", direction }),
        }),
      );
    },
    [session, rack.rack, library.bed.id, showSong, openDemoRack],
  );
  useEffect(() => onSessionCommand(apply), [apply]);

  const showCrate = crateOpen && !narrow;
  const showChat = !panelOpen || !narrow;
  const columns = showCrate ? "248px minmax(0, 1fr)" : "minmax(0, 1fr)";

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="h-11 shrink-0 border-b border-rule px-4 flex items-center gap-3 min-w-0">
        <span className="font-semibold tracking-tight">Cratebox</span>
        <span className="text-xs text-chalk-dim px-1.5 py-0.5 border border-rule rounded-sm">prototype</span>
        <span className="text-xs text-chalk-faint truncate min-w-0 hidden sm:inline">
          The real components on the real session engine. The audio is synthesised in your browser.
        </span>
        <span className="ml-auto flex items-center gap-2">
          {!narrow && (
            <button type="button" className={btn} aria-pressed={crateOpen} onClick={() => setCrateOpen((v) => !v)} title="Show or hide the crate">
              {crateOpen ? "Hide crate" : "Crate"}
            </button>
          )}
          <button
            type="button"
            className={btn}
            aria-pressed={panelOpen}
            disabled={current === null}
            onClick={() => setStack((prev) => (prev.open ? closePanel(prev) : openPanel(prev)))}
            title={current === null ? "Nothing on the panel yet" : "Show or dismiss the panel; the chat takes the full width when it is closed"}
          >
            {panelOpen ? (narrow ? "Chat" : "Hide panel") : "Panel"}
          </button>
        </span>
      </header>

      <div className="flex-1 min-h-0 grid" style={{ gridTemplateColumns: columns }}>
        {showCrate && (
          <aside className="min-h-0 border-r border-rule flex flex-col" aria-label="Crate">
            <DemoCrate files={library.files} />
          </aside>
        )}

        <div ref={areaRef} className="min-h-0 min-w-0 flex">
          {/* Kept mounted when the panel takes a narrow window over, so the
              transcript survives the toggle the way the file surface does. */}
          <section
            className="min-h-0 min-w-0 flex flex-col"
            style={{
              flex: panelOpen && !narrow ? `0 0 ${((1 - split) * 100).toFixed(3)}%` : "1 1 100%",
              ...(showChat ? {} : { display: "none" }),
            }}
            aria-label="Chat"
            aria-hidden={!showChat}
          >
            <div className={cx("flex-1 min-h-0 flex flex-col w-full", !panelOpen && "max-w-[820px] mx-auto")}>
              <DemoChat done={done} onStep={runStep} />
            </div>
          </section>

          {panelOpen && !narrow && (
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
            <section
              className={cx("min-h-0 min-w-0 flex flex-col", showChat && !narrow && "border-l border-rule")}
              style={{ flex: narrow ? "1 1 100%" : `1 1 ${(split * 100).toFixed(3)}%` }}
              aria-label="Surface"
            >
              <div className="shrink-0 h-9 border-b border-rule px-3 flex items-center gap-2 min-w-0">
                <button type="button" className={btnQuiet} onClick={() => setStack(goBack)} disabled={!canGoBack(stack)} title="Back to the last object; nothing is re-run" aria-label="Back">
                  ←
                </button>
                <button type="button" className={btnQuiet} onClick={() => setStack(goForward)} disabled={!canGoForward(stack)} aria-label="Forward">
                  →
                </button>
                <span className="text-sm truncate min-w-0 flex items-baseline gap-2">
                  <span className="truncate">{current.title}</span>
                  <span className="font-mono text-xs text-chalk-dim shrink-0">
                    {stack.index + 1}/{stack.entries.length}
                  </span>
                </span>
                <span className="ml-auto flex items-center gap-1 shrink-0">
                  {stack.entries.length > 1 && (
                    <select
                      className="h-6 px-1 rounded-sm bg-slate border border-rule text-xs text-chalk max-w-[150px]"
                      value={stack.index}
                      onChange={(e) => setStack((prev) => goTo(prev, Number(e.target.value)))}
                      aria-label="Everything this conversation has put on the panel"
                      title="Everything this conversation has put on the panel"
                    >
                      {stack.entries.map((entry, i) => (
                        <option key={`${entry.kind}:${entry.id}`} value={i}>
                          {entry.kind} · {entry.title}
                        </option>
                      ))}
                    </select>
                  )}
                  <button type="button" className={btnQuiet} onClick={() => setStack(closePanel)} title="Dismiss the panel and get the full-width chat back">
                    Close
                  </button>
                </span>
              </div>

              <div className="flex-1 min-h-0 relative">
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

      <TransportBar onOpenSession={showSong} />
    </div>
  );
}

/** Is the window too narrow for the chat and the panel to share it? */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${NARROW_PX - 1}px)`);
    const read = () => setNarrow(query.matches);
    read();
    query.addEventListener("change", read);
    return () => query.removeEventListener("change", read);
  }, []);
  return narrow;
}
