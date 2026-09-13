"use client";

import Link from "next/link";
import { SearchBox } from "@/components/library/SearchBox";
import { btn, btnQuiet, cx } from "@/components/ui";
import { useLibrary } from "@/lib/state/LibraryProvider";

export function TopBar({
  chatOpen,
  onToggleChat,
  onKeymap,
  padNote,
}: {
  chatOpen: boolean;
  onToggleChat: () => void;
  onKeymap: () => void;
  padNote: string | null;
}) {
  const { userEmail, realtime } = useLibrary();
  return (
    <header className="h-11 shrink-0 border-b border-rule grid grid-cols-[288px_minmax(0,1fr)_auto] items-center">
      <div className="px-4 flex items-center gap-3">
        <span className="font-semibold tracking-tight">CrateAI</span>
        <span
          className={cx(
            "inline-block w-1.5 h-1.5 rounded-full",
            realtime === "live" ? "bg-pad" : realtime === "connecting" ? "bg-chalk-faint" : "bg-transparent border border-chalk-faint",
          )}
          title={realtime === "live" ? "Live updates connected" : realtime === "connecting" ? "Connecting live updates" : "Live updates offline; polling"}
          aria-label={`Live updates ${realtime}`}
        />
      </div>
      <div className="px-4 flex items-center gap-4 min-w-0">
        <SearchBox />
        {padNote && (
          <span role="status" className="text-xs text-chalk-dim whitespace-nowrap">
            {padNote}
          </span>
        )}
      </div>
      <div className="px-4 flex items-center gap-2">
        <Link href="/beatbox" className={btn} title="Enroll your kick, snare and hat; beatbox a pattern to MIDI">
          Beatbox
        </Link>
        <Link href="/account" className={btn} title="Plan, usage this month, billing">
          Account
        </Link>
        <button type="button" onClick={onKeymap} className={btn} title="Keyboard map (?)" aria-label="Keyboard map">
          <span className="font-mono">?</span>
        </button>
        <button type="button" onClick={onToggleChat} className={btn} aria-pressed={chatOpen}>
          {chatOpen ? "Hide chat" : "Chat"}
        </button>
        <span className="text-xs text-chalk-dim max-w-[180px] truncate" title={userEmail ?? undefined}>
          {userEmail}
        </span>
        <form action="/auth/signout" method="post">
          <button type="submit" className={btnQuiet}>
            Sign out
          </button>
        </form>
      </div>
    </header>
  );
}
