"use client";

// One screen, three panes. Left: library. Center: the working surface for
// the open file (route children). Right: chat. Rules separate the panes;
// nothing is boxed. The chat folds away under 1180px and on demand.

import { useEffect, useState, type ReactNode } from "react";
import { ChatPane } from "@/components/chat/ChatPane";
import { LibraryPane } from "@/components/library/LibraryPane";
import { KeymapSheet } from "./KeymapSheet";
import { SearchProvider } from "./searchState";
import { TopBar } from "./TopBar";
import { handleKeydown, onCommand, onPad } from "@/lib/keys/commands";

function useMediaQuery(query: string, initial = true): boolean {
  const [matches, setMatches] = useState(initial);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener("change", update);
    return () => mql.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export function Workspace({ children }: { children: ReactNode }) {
  const wide = useMediaQuery("(min-width: 1180px)");
  const [chatOpen, setChatOpen] = useState<boolean | null>(null);
  const [keymapOpen, setKeymapOpen] = useState(false);
  const [padNote, setPadNote] = useState<string | null>(null);
  const showChat = chatOpen ?? wide;

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

  return (
    <SearchProvider>
      <div className="h-full flex flex-col overflow-hidden">
        <TopBar chatOpen={showChat} onToggleChat={() => setChatOpen(!showChat)} onKeymap={() => setKeymapOpen(true)} padNote={padNote} />
        <div
          className="flex-1 min-h-0 grid"
          style={{ gridTemplateColumns: showChat ? "288px minmax(0, 1fr) 336px" : "288px minmax(0, 1fr)" }}
        >
          <aside className="min-h-0 border-r border-rule flex flex-col" aria-label="Library">
            <LibraryPane />
          </aside>
          <main className="min-h-0 min-w-0 flex flex-col overflow-hidden">{children}</main>
          {showChat && (
            <aside className="min-h-0 border-l border-rule flex flex-col" aria-label="Chat">
              <ChatPane />
            </aside>
          )}
        </div>
      </div>
      <KeymapSheet open={keymapOpen} onClose={() => setKeymapOpen(false)} />
    </SearchProvider>
  );
}
