"use client";

import { useRouter } from "next/navigation";
import { btnQuiet, cx } from "@/components/ui";
import { fmtBytes, fmtPercent } from "@/lib/format";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { UploadItem } from "@/lib/upload/uploader";

function stateText(item: UploadItem): string {
  switch (item.state) {
    case "waiting":
      return "waiting";
    case "hashing":
      return `hashing ${fmtPercent(item.progress)}`;
    case "checking":
      return "checking the library";
    case "uploading":
      return `uploading ${fmtPercent(item.progress)}`;
    case "completing":
      return "queueing analysis";
    case "exists":
      return "already in your library";
    case "done":
      return item.dispatchNote ? `added; ${item.dispatchNote}` : "added, queued for analysis";
    case "failed":
      return item.error ?? "failed";
  }
}

export function UploadQueue() {
  const { uploads, uploader } = useLibrary();
  const router = useRouter();
  if (uploads.length === 0) return null;

  const finished = uploads.filter((u) => u.state === "done" || u.state === "exists").length;
  const inFlight = uploads.length - finished - uploads.filter((u) => u.state === "failed").length;

  return (
    <section className="border-b border-rule" aria-label="Uploads">
      <div className="px-4 h-8 flex items-center justify-between text-xs text-chalk-dim">
        <span>
          Uploads
          <span className="font-mono ml-2">
            {inFlight > 0 ? `${inFlight} in progress` : `${finished} of ${uploads.length} done`}
          </span>
        </span>
        {finished > 0 && (
          <button type="button" className={btnQuiet} onClick={() => uploader.clearFinished()}>
            Clear done
          </button>
        )}
      </div>
      <ul>
        {uploads.map((u) => {
          const active = u.state === "hashing" || u.state === "uploading";
          return (
            <li key={u.id} className="px-4 py-1.5 border-t border-rule text-sm relative">
              <div className="flex items-baseline justify-between gap-2">
                <button
                  type="button"
                  className={cx("truncate text-left", u.fileRow ? "hover:text-pad" : "cursor-default")}
                  title={u.relativePath ? `${u.relativePath}/${u.name}` : u.name}
                  onClick={() => u.fileRow && router.push(`/f/${u.fileRow.id}`)}
                >
                  {u.name}
                </button>
                <span className="font-mono text-xs text-chalk-dim whitespace-nowrap">{fmtBytes(u.size)}</span>
              </div>
              <div className="flex items-center justify-between gap-2 text-xs text-chalk-dim">
                <span className={cx("truncate", u.state === "failed" && "text-chalk")}>{stateText(u)}</span>
                {u.state === "failed" && (
                  <span className="flex gap-1">
                    <button type="button" className={btnQuiet} onClick={() => uploader.retry(u.id)}>
                      Retry
                    </button>
                    <button type="button" className={btnQuiet} onClick={() => uploader.remove(u.id)}>
                      Remove
                    </button>
                  </span>
                )}
              </div>
              {active && (
                <div className="absolute left-0 right-0 bottom-0 h-px bg-rule" aria-hidden>
                  <div className="h-px bg-pad transition-[width] duration-200" style={{ width: `${Math.round(u.progress * 100)}%` }} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
