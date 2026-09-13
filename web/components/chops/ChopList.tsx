"use client";

// The chops as rows: pad number, index, name (click to rename), edges,
// length, analysis state (live from the library store), play and Open.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { statusText } from "@/components/library/FileRow";
import { openFile } from "@/components/stems/navigate";
import { btnQuiet, cx, input } from "@/components/ui";
import type { ChopWithFile } from "@/lib/api/chops";
import { fmtClock, fmtSeconds } from "@/lib/format";
import type { PadBindings } from "@/lib/pads/bindings";
import { keyForPad } from "@/lib/pads/keymap";
import { useLibrary } from "@/lib/state/LibraryProvider";

export function ChopList({
  chops,
  bindings,
  isPlaying,
  onPlay,
  onRename,
}: {
  chops: ChopWithFile[];
  bindings: PadBindings;
  isPlaying: (fileId: string) => boolean;
  onPlay: (fileId: string) => void;
  onRename: (chopId: string, name: string | null) => void;
}) {
  return (
    <ul>
      {chops.map((chop) => (
        <ChopRowView
          key={chop.id}
          chop={chop}
          pad={bindings.find((b) => b?.chop_id === chop.id)?.pad ?? null}
          playing={chop.chop_file_id !== null && isPlaying(chop.chop_file_id)}
          onPlay={onPlay}
          onRename={onRename}
        />
      ))}
    </ul>
  );
}

function ChopRowView({
  chop,
  pad,
  playing,
  onPlay,
  onRename,
}: {
  chop: ChopWithFile;
  pad: number | null;
  playing: boolean;
  onPlay: (fileId: string) => void;
  onRename: (chopId: string, name: string | null) => void;
}) {
  const lib = useLibrary();
  const router = useRouter();
  const live = chop.chop_file_id ? lib.fileById(chop.chop_file_id) : undefined;
  const status = live ? statusText(live, lib.jobsForFile(live.id)) : { text: chop.file?.status ?? "no file", failed: chop.file === null };
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(chop.name ?? "");
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) nameInput.current?.select();
  }, [renaming]);
  const commit = () => {
    setRenaming(false);
    const trimmed = name.trim();
    if (trimmed === (chop.name ?? "")) return;
    onRename(chop.id, trimmed || null);
  };

  return (
    <li className="border-b border-rule px-4 py-1.5 grid grid-cols-[28px_minmax(0,1fr)_auto] gap-x-3 items-center">
      <button
        type="button"
        className={cx("h-7 w-7 rounded-sm border flex items-center justify-center", playing ? "border-pad text-pad" : "border-rule text-chalk hover:border-rule-strong disabled:opacity-40")}
        disabled={chop.chop_file_id === null}
        onClick={() => chop.chop_file_id && onPlay(chop.chop_file_id)}
        aria-label={`Play ${chop.name ?? `chop ${chop.index + 1}`}`}
        title={pad ? `Play (key ${keyForPad(pad)})` : "Play"}
      >
        <span aria-hidden className="font-mono text-xs">
          ▶
        </span>
      </button>
      <div className="min-w-0">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="font-mono text-xs text-chalk-dim w-[22px]">{String(chop.index + 1).padStart(2, "0")}</span>
          {renaming ? (
            <input
              ref={nameInput}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => {
                if (e.key === "Enter") commit();
                if (e.key === "Escape") {
                  setName(chop.name ?? "");
                  setRenaming(false);
                }
                e.stopPropagation();
              }}
              className={cx(input, "h-6 w-[180px]")}
              aria-label="Chop name"
            />
          ) : (
            <button
              type="button"
              className="text-sm truncate text-left hover:text-pad"
              onClick={() => {
                setName(chop.name ?? "");
                setRenaming(true);
              }}
              title="Rename"
            >
              {chop.name?.trim() || `chop ${chop.index + 1}`}
            </button>
          )}
          {pad !== null && (
            <span className="font-mono text-xs text-chalk-dim" title={`Pad ${pad}`}>
              pad {pad} · {keyForPad(pad)}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 font-mono text-xs text-chalk-dim">
          <span>
            <span className="text-chalk">{fmtClock(chop.start_s)}</span> – <span className="text-chalk">{fmtClock(chop.end_s)}</span>
          </span>
          <span>{fmtSeconds(chop.end_s - chop.start_s)}</span>
          <span className={cx("font-sans", status.failed && "text-chalk")}>{status.text}</span>
        </div>
      </div>
      <button type="button" className={btnQuiet} disabled={chop.chop_file_id === null} onClick={() => chop.chop_file_id && openFile(router, chop.chop_file_id)} title="Open this chop on the surface">
        Open
      </button>
    </li>
  );
}
