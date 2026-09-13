"use client";

// Drop files or folders; or pick either. Folders are walked with the entry
// API on drop and with webkitdirectory in the picker. Only audio passes.
//
// Two sizes, one code path. `rail` is the compact box at the top of the
// library. `hero` is the same target on the first screen, where dropping one
// record is the only thing worth doing and the box should say so — a producer
// should not have to find a 288 px box in a side rail to start.

import { useEffect, useRef, useState, type DragEvent } from "react";
import { btn, cx } from "@/components/ui";
import { useLibrary } from "@/lib/state/LibraryProvider";
import { ACCEPT_ATTR, filesFromDrop, filesFromInput } from "@/lib/upload/fs";

export function UploadZone({ variant = "rail" }: { variant?: "rail" | "hero" }) {
  const { uploader } = useLibrary();
  const hero = variant === "hero";
  const [over, setOver] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // React's typings don't carry webkitdirectory; set it on the element.
    folderInput.current?.setAttribute("webkitdirectory", "");
    folderInput.current?.setAttribute("directory", "");
  }, []);

  const accept = (picked: ReturnType<typeof filesFromInput>, total: number) => {
    if (picked.length === 0) {
      setNote(total === 0 ? "Nothing dropped." : "No audio files in that drop (wav, aif, aiff, flac, mp3, m4a, aac, ogg, oga, opus).");
      return;
    }
    const skipped = total - picked.length;
    setNote(skipped > 0 ? `${picked.length} added, ${skipped} skipped (not audio).` : null);
    uploader.add(picked);
  };

  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const total = e.dataTransfer.items?.length ?? e.dataTransfer.files.length;
    const picked = await filesFromDrop(e.dataTransfer);
    accept(picked, Math.max(total, picked.length));
  };

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!over) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cx(
        "rounded-sm border border-dashed flex flex-col gap-2 bg-slate",
        hero ? "px-4 py-5" : "mx-3 mt-3 px-3 py-3",
        over ? "border-pad" : "border-rule",
      )}
    >
      {hero ? (
        <div>
          <p className="text-md">{over ? "Drop it." : "Drop a record here."}</p>
          <p className="mt-1 text-xs text-chalk-dim">
            wav, aif, aiff, flac, mp3, m4a, aac, ogg, opus. One is enough to start; a folder works too.
          </p>
        </div>
      ) : (
        <p className="text-sm text-chalk-dim">{over ? "Drop to add to the library." : "Drop audio files or folders here."}</p>
      )}
      <div className="flex gap-2">
        <button type="button" className={btn} onClick={() => fileInput.current?.click()}>
          Add files
        </button>
        <button type="button" className={btn} onClick={() => folderInput.current?.click()}>
          Add a folder
        </button>
      </div>
      {note && (
        <p role="status" className="text-xs text-chalk-dim">
          {note}
        </p>
      )}
      <input
        ref={fileInput}
        type="file"
        multiple
        accept={ACCEPT_ATTR}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const total = e.target.files?.length ?? 0;
          accept(filesFromInput(e.target.files), total);
          e.target.value = "";
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const total = e.target.files?.length ?? 0;
          accept(filesFromInput(e.target.files), total);
          e.target.value = "";
        }}
      />
    </div>
  );
}
