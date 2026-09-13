"use client";

// The mentor's version of the document, streamed paragraph by paragraph
// (each one already validated by the route), with the notes about what was
// removed or why the measured document is standing in. Sits above the facts
// and never replaces them.

import { useEffect, useState } from "react";
import { btn, btnQuiet, cx } from "@/components/ui";
import type { NarrationSource } from "@/lib/narration/run";

export interface NarrationView {
  status: "idle" | "streaming" | "done" | "error";
  paragraphs: string[];
  notes: string[];
  /** "saved" when it came back with the breakdown row rather than from a fresh call */
  source: NarrationSource | "saved" | null;
  error: string | null;
}

export const EMPTY_NARRATION: NarrationView = { status: "idle", paragraphs: [], notes: [], source: null, error: null };

function statusText(view: NarrationView): string | null {
  if (view.status === "streaming") return view.paragraphs.length === 0 ? "listening" : "narrating";
  if (view.status === "error") return null;
  if (view.status === "done") {
    if (view.source === "saved") return "saved narration";
    if (view.source === "deterministic") return "the measured document";
    return "narrated just now";
  }
  return null;
}

export function NarrationPanel({
  view,
  canNarrate,
  onNarrate,
  onStop,
}: {
  view: NarrationView;
  canNarrate: boolean;
  onNarrate: () => void;
  onStop: () => void;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  const text = view.paragraphs.join("\n\n");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // clipboard blocked: the text is selectable on screen
    }
  };
  const streaming = view.status === "streaming";
  const hasText = view.paragraphs.length > 0;
  const status = statusText(view);

  return (
    <section className="border-t border-rule py-2.5" aria-label="Narration">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h2 className="text-sm font-medium">Narration</h2>
        {status && <span className={cx("text-xs", streaming ? "text-pad" : "text-chalk-dim")}>{status}</span>}
        <div className="ml-auto flex items-center gap-1">
          {hasText && !streaming && (
            <button type="button" className={btnQuiet} onClick={() => void copy()} title="Copy the narration as text">
              {copied ? "copied" : "Copy"}
            </button>
          )}
          {streaming ? (
            <button type="button" className={btn} onClick={onStop}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className={btn}
              disabled={!canNarrate}
              onClick={onNarrate}
              title="Have the mentor narrate this version; every line is checked against the facts before it is shown"
            >
              {hasText ? "Narrate again" : "Narrate"}
            </button>
          )}
        </div>
      </div>
      {view.error && (
        <p role="alert" className="mt-2 text-xs border-l-2 border-pad pl-2">
          {view.error}
        </p>
      )}
      {view.notes.map((note, i) => (
        <p key={i} className="mt-2 text-xs text-chalk-dim border-l-2 border-pad pl-2">
          {note}
        </p>
      ))}
      {hasText ? (
        <div className="mt-2 max-w-[68ch]">
          {view.paragraphs.map((p, i) => (
            <p key={i} className="text-sm whitespace-pre-wrap leading-relaxed mt-2 first:mt-0">
              {p}
            </p>
          ))}
        </div>
      ) : (
        !streaming &&
        !view.error && (
          <p className="mt-1 text-xs text-chalk-dim max-w-[560px]">
            Press Narrate for the mentor&apos;s telling of these facts. It can only say what was measured; every paragraph is checked
            against the facts below before it appears.
          </p>
        )
      )}
    </section>
  );
}
