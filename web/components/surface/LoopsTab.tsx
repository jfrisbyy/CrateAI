"use client";

// The Loops tab: the file's loops as rows (and as regions on the waveform),
// with snap modes, raw and rendered preview, edits, export and the finder.

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { btn, btnPrimary, btnQuiet, cx, input, label, segment, segmentItem, select } from "@/components/ui";
import { api, errorMessage } from "@/lib/api/client";
import { fmtClock, fmtNumber } from "@/lib/format";
import { barsToSeconds, SNAP_MODES } from "@/lib/report/grid";
import { sampleReadyChips, sampleReadyOf } from "@/lib/report/sampleReady";
import { useLibrary } from "@/lib/state/LibraryProvider";
import type { JobRow, LoopRow } from "@/lib/types/db";
import { jobPersonalization, PersonalizationChip, PersonalizationNote, rowPersonalization } from "./LoopPersonalization";
import { useSurface } from "./surfaceState";

/** The lengths the bar control offers, and the ones the finder searches by default. */
const BAR_CHOICES = [1, 2, 4, 8] as const;

function jobText(job: JobRow | undefined): string | null {
  if (!job) return null;
  if (job.status === "queued") {
    const note = job.error?.startsWith("dispatch:") ? job.error.slice("dispatch:".length).trim() : null;
    return note ? `queued (${note})` : "queued";
  }
  if (job.status === "running") return job.progress !== null ? `running ${Math.round(job.progress * 100)}%` : "running";
  if (job.status === "failed") return `failed: ${job.error ?? "unknown error"}`;
  return "done";
}

export function LoopsTab() {
  const s = useSurface();
  const { file, loops, loopsLoading, loopsError, selectedLoopId, selectLoop, liveEdges } = s;
  const ready = file.status === "ready" && s.report !== null;

  // What this account's corrections did to this rack. The search itself reports
  // it (`jobs.result.personalization`, which also says "off"); a rack ranked in
  // an earlier session still carries it on its rows.
  const personal = useMemo(
    () => jobPersonalization(s.findJob?.result) ?? loops.map((l) => rowPersonalization(l.components)).find(Boolean) ?? null,
    [s.findJob, loops],
  );
  const [switchState, setSwitchState] = useState<boolean | null>(null);
  const [switchBusy, setSwitchBusy] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
  // Only once a search has reported: an account that has never ranked a loop has
  // nothing to read and nothing to refuse, and should not pay a query to hear it.
  const ranked = personal !== null;
  useEffect(() => {
    if (!ranked) return;
    let cancelled = false;
    void api.loops.personalization
      .get()
      .then((res) => {
        if (!cancelled) setSwitchState(res.enabled);
      })
      .catch(() => undefined); // the rack still ranks; only the switch's own state is unknown
    return () => {
      cancelled = true;
    };
  }, [ranked]);
  const setPersonalization = async (next: boolean) => {
    setSwitchBusy(true);
    setSwitchError(null);
    const before = switchState;
    setSwitchState(next);
    try {
      const res = await api.loops.personalization.set(next);
      setSwitchState(res.enabled);
    } catch (err) {
      setSwitchState(before);
      setSwitchError(errorMessage(err));
    } finally {
      setSwitchBusy(false);
    }
  };

  return (
    <div className="flex flex-col">
      <div className="px-4 py-2 border-b border-rule flex flex-wrap items-center gap-x-4 gap-y-2">
        <button type="button" className={btnPrimary} disabled={!ready || s.findJob?.status === "queued" || s.findJob?.status === "running"} onClick={() => void s.findLoops()} title={ready ? "Rank loop candidates on the beat grid" : "Available once the file is analyzed"}>
          Find loops
        </button>
        {s.findJob && s.findJob.status !== "done" && <span className="text-xs text-chalk-dim">finder {jobText(s.findJob)}</span>}
        <button type="button" className={btn} disabled={!s.url} onClick={() => void s.createLoopAtCursor()} title="L">
          New loop at cursor
        </button>

        <div className="flex items-center gap-2">
          <span className={label}>Snap</span>
          <div className={segment} role="group" aria-label="Snap mode">
            {SNAP_MODES.map((m) => (
              <button key={m.id} type="button" data-active={s.snapMode === m.id} onClick={() => s.setSnapMode(m.id)} className={segmentItem}>
                {m.label}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-chalk-dim">
            <input type="checkbox" checked={s.zeroCrossing} onChange={(e) => s.setZeroCrossing(e.target.checked)} className="accent-[#f0a63a]" />
            prefer zero crossings
          </label>
        </div>

        <div className="flex items-center gap-2">
          <span className={label}>Preview</span>
          <div className={segment} role="group" aria-label="Preview mode">
            <button type="button" data-active={s.previewMode === "raw"} onClick={() => s.setPreviewMode("raw")} className={segmentItem}>
              Raw
            </button>
            <button type="button" data-active={s.previewMode === "rendered"} onClick={() => s.setPreviewMode("rendered")} className={segmentItem} title="The export algorithm: zero-crossing snap and a tail crossfade">
              Rendered
            </button>
          </div>
          {s.previewMode === "rendered" && (
            <label className="flex items-center gap-1.5 text-xs text-chalk-dim">
              crossfade
              <input
                type="number"
                min={0}
                max={200}
                step={1}
                value={s.crossfadeMs}
                onChange={(e) => s.setCrossfadeMs(Math.max(0, Math.min(200, Number(e.target.value) || 0)))}
                className={cx(input, "font-mono w-[56px] h-6")}
                aria-label="Crossfade in milliseconds"
              />
              ms
            </label>
          )}
        </div>
        {s.previewMode === "rendered" && s.renderMeta && (
          <span className="text-xs text-chalk-dim font-mono" title="What the render did to the edges: zero-crossing snap in ms, effective crossfade, tail or self mode">
            snapped {fmtSigned(s.renderMeta.snappedStartMs)} / {fmtSigned(s.renderMeta.snappedEndMs)} ms, crossfade {s.renderMeta.crossfadeSamples} samples, {s.renderMeta.mode}
          </span>
        )}
        {s.decodeState === "decoding" && <span className="text-xs text-chalk-dim">decoding audio for preview</span>}
        {s.decodeState === "error" && <span className="text-xs">could not decode: {s.decodeError}</span>}
      </div>

      {personal && (
        <PersonalizationNote
          personal={personal}
          enabled={switchState ?? personal.enabled}
          busy={switchBusy}
          error={switchError}
          onToggle={(next) => void setPersonalization(next)}
        />
      )}

      {s.actionError && (
        <p role="alert" className="mx-4 mt-2 text-xs border-l-2 border-pad pl-2 flex items-center gap-2">
          {s.actionError}
          <button type="button" className={btnQuiet} onClick={s.clearActionError}>
            Dismiss
          </button>
        </p>
      )}

      {loopsLoading ? (
        <p className="px-4 py-3 text-sm text-chalk-dim">Loading loops.</p>
      ) : loopsError ? (
        <p className="px-4 py-3 text-sm">
          Could not load loops: {loopsError}{" "}
          <button type="button" className={btnQuiet} onClick={() => void s.refetchLoops()}>
            Retry
          </button>
        </p>
      ) : loops.length === 0 ? (
        <p className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">
          No loops yet. {ready ? "Press Find loops for ranked candidates, or place the cursor and press L for a loop of your own." : "Loops need the beat grid; they become available when analysis finishes."}
        </p>
      ) : (
        <ul>
          {loops.map((loop) => (
            <LoopRowView
              key={loop.id}
              loop={loop}
              live={liveEdges[loop.id]}
              selected={loop.id === selectedLoopId}
              onSelect={() => selectLoop(loop.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function LoopRowView({
  loop,
  live,
  selected,
  onSelect,
}: {
  loop: LoopRow;
  live: { start: number; end: number } | undefined;
  selected: boolean;
  onSelect: () => void;
}) {
  const s = useSurface();
  const lib = useLibrary();
  const router = useRouter();
  const playing = s.playingLoopId === loop.id;
  const start = live?.start ?? loop.start_s;
  const end = live?.end ?? loop.end_s;
  const renderJob = s.renderJobFor(loop.id);
  const renderFile = loop.render_file_id ? lib.fileById(loop.render_file_id) : undefined;
  const components = componentsOf(loop.components);
  const personal = rowPersonalization(loop.components);
  const ready = sampleReadyOf(loop.components);
  const chips = sampleReadyChips(ready);

  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(loop.name ?? "");
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (renaming) nameInput.current?.select();
  }, [renaming]);
  const commitName = () => {
    setRenaming(false);
    const trimmed = name.trim();
    if (trimmed === (loop.name ?? "")) return;
    void s.updateLoop(loop.id, { name: trimmed || null });
  };

  const [downloading, setDownloading] = useState(false);
  const download = async () => {
    if (!loop.render_file_id) return;
    setDownloading(true);
    try {
      const res = await api.files.url(loop.render_file_id);
      window.open(res.url, "_blank", "noopener");
    } catch (err) {
      alert(errorMessage(err));
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li
      className={cx("relative border-b border-rule px-4 py-2 grid grid-cols-[28px_minmax(0,1fr)_auto] gap-x-3 items-start", selected && "bg-slate")}
      onClick={onSelect}
      data-selected={selected}
    >
      {selected && <span className="absolute left-0 top-0 bottom-0 w-0.5 bg-pad" aria-hidden />}
      <button
        type="button"
        className={cx("h-7 w-7 rounded-sm border flex items-center justify-center", playing ? "border-pad text-pad" : "border-rule text-chalk hover:border-rule-strong")}
        onClick={(e) => {
          e.stopPropagation();
          if (playing) s.stopLoop();
          else void s.playLoop(loop.id);
        }}
        aria-label={playing ? "Stop" : `Play ${s.previewMode} loop`}
        title={playing ? "Stop" : `Play (${s.previewMode})`}
        disabled={!s.url}
      >
        <span aria-hidden className="font-mono text-xs">
          {playing ? "■" : "▶"}
        </span>
      </button>

      <div className="min-w-0">
        <div className="flex items-baseline gap-3 min-w-0">
          {renaming ? (
            <input
              ref={nameInput}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitName();
                if (e.key === "Escape") {
                  setName(loop.name ?? "");
                  setRenaming(false);
                }
              }}
              className={cx(input, "h-6 w-[200px]")}
              aria-label="Loop name"
            />
          ) : (
            <button
              type="button"
              className="text-sm truncate text-left hover:text-pad"
              onClick={(e) => {
                e.stopPropagation();
                setName(loop.name ?? "");
                setRenaming(true);
              }}
              title="Rename"
            >
              {loop.name?.trim() || (loop.origin === "finder" ? "Found loop" : loop.origin === "chat" ? "Loop from chat" : "Loop")}
            </button>
          )}
          <span className="text-xs text-chalk-dim">{loop.origin}</span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 font-mono text-xs text-chalk-dim">
          <span>
            <span className="text-chalk">{fmtClock(start)}</span> – <span className="text-chalk">{fmtClock(end)}</span>
          </span>
          <BarsControl loop={loop} start={start} />
          <span>
            score <span className="text-chalk">{loop.score !== null ? fmtNumber(loop.score, 2) : "—"}</span>
          </span>
          {personal && <PersonalizationChip personal={personal} />}
          {components.map(([k, v]) => (
            <span key={k}>
              {k} <span className="text-chalk">{fmtNumber(v, 2)}</span>
            </span>
          ))}
        </div>
        {chips.length > 0 && (
          // What is playing in this span, measured per stem by the finder. The
          // chips are worded in Python beside the claims they come from; an
          // untrusted separation says so here rather than showing nothing,
          // which would read as "we looked and there is nothing".
          <div
            className={cx("mt-1 text-xs flex flex-wrap items-center gap-x-3 gap-y-1", ready?.source.trusted ? "text-chalk-dim" : "text-pad")}
            title={ready?.caveats.join(" · ")}
          >
            {chips.map((chip) => (
              <span key={chip}>{chip}</span>
            ))}
          </div>
        )}
        {(renderJob || renderFile) && (
          <div className="mt-1 text-xs text-chalk-dim flex items-center gap-2">
            {renderFile ? (
              <>
                <span>
                  rendered <span className="text-chalk">{renderFile.original_filename}</span>
                </span>
                <button type="button" className={btnQuiet} onClick={(e) => (e.stopPropagation(), router.push(`/f/${renderFile.id}`))}>
                  Open
                </button>
                <button type="button" className={btnQuiet} disabled={downloading} onClick={(e) => (e.stopPropagation(), void download())}>
                  Download
                </button>
              </>
            ) : (
              <span>export {jobText(renderJob)}</span>
            )}
            {renderJob?.status === "failed" && (
              <button type="button" className={btnQuiet} onClick={(e) => (e.stopPropagation(), void api.jobs.retry(renderJob.id))}>
                Retry
              </button>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className={btn}
          disabled={renderJob?.status === "queued" || renderJob?.status === "running"}
          onClick={() => void s.renderLoop(loop.id)}
          title="Render a 24-bit WAV with the tail crossfade and put it in the library"
        >
          Export WAV
        </button>
        <button type="button" className={btnQuiet} onClick={() => void s.deleteLoop(loop.id)} aria-label="Delete loop" title="Delete">
          ×
        </button>
      </div>
    </li>
  );
}

/**
 * Setting a loop's bar count outright: the length is the statement and the end
 * moves to fit it, on this file's own bar grid.
 *
 * This is the one of the three signals a producer had no control for. It writes
 * `loop_bars` rather than `loop_edges` (`via: "bars"`) because "make it four
 * bars" and "drag this edge until it looks like four bars" are the same row
 * otherwise, and only the control that was used can tell them apart.
 */
function BarsControl({ loop, start }: { loop: LoopRow; start: number }) {
  const s = useSurface();
  const choices = useMemo(() => {
    const fits = (n: number) => {
      const len = barsToSeconds(start, n, s.grid);
      return len !== null && len > 0 && (!s.duration || start + len <= s.duration + 1e-6);
    };
    const out = BAR_CHOICES.filter(fits) as number[];
    if (loop.bars !== null && !out.includes(loop.bars)) out.push(loop.bars);
    return out.sort((a, b) => a - b);
  }, [start, s.grid, s.duration, loop.bars]);

  if (choices.length < 2) {
    return (
      <span title={s.grid.beatInterval ? "The file ends too soon for another length" : "Bar lengths need the beat grid"}>
        <span className="text-chalk">{loop.bars ?? "—"}</span> {loop.bars === 1 ? "bar" : "bars"}
      </span>
    );
  }
  return (
    <span className="flex items-baseline gap-1">
      <select
        className={cx(select, "h-6 py-0 font-mono text-xs")}
        value={loop.bars ?? ""}
        aria-label="Loop length in bars"
        title="Set the length in bars; the end moves to the bar line"
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const bars = Number(e.target.value);
          const len = barsToSeconds(start, bars, s.grid);
          if (!len || bars === loop.bars) return;
          void s.updateLoop(loop.id, { end_s: start + len, bars, via: "bars" });
        }}
      >
        {loop.bars === null && <option value="">—</option>}
        {choices.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      {loop.bars === 1 ? "bar" : "bars"}
    </span>
  );
}

function fmtSigned(ms: number): string {
  return `${ms >= 0 ? "+" : ""}${ms.toFixed(2)}`;
}

function componentsOf(components: LoopRow["components"]): Array<[string, number]> {
  if (!components || typeof components !== "object" || Array.isArray(components)) return [];
  const out: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(components)) if (typeof v === "number") out.push([k, v]);
  return out;
}
