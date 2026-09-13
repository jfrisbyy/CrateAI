"use client";

// The song (direction document, Surface 2).
//
// Lanes stacked, regions on a timeline against a bar ruler, the playhead
// moving through it, and direct manipulation: drag a region to move it, drag
// its edges to trim, mute, solo, set gain, split, copy, delete. The transport
// this draws is the one the rack already auditions on — one clock in the
// product, not one per panel.
//
// The line the direction document draws, and this file keeps to: arrangement
// and audition are in, production processing is out. Every control here
// answers "what is this song"; none of them is an EQ.
//
// Four things this file is careful about, all of them decided in lib/session
// and only *applied* here:
//
//   Musical time. A pointer becomes a session second (`xToTime`) and then a
//   grid position (`snapTime`), and the same edit function runs whether the
//   drag, the arrow key, the number box or the sentence started it.
//
//   Not stuttering. An edit goes through `session.edit`, which diffs against
//   what is playing and hands the engine only the lanes that changed.
//
//   Not re-rendering. The grid is two CSS gradients rather than a line per
//   division; regions off screen are not drawn at all (`regionsInView`); a
//   drag re-renders only the block being dragged; and the playhead is written
//   straight to a transform on an animation frame, never through React state.
//
//   Undo. Every edit is one call with a label, and the stack is in the
//   provider (lib/session/history.ts).

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useSession } from "@/components/shell/SessionProvider";
import { btnQuiet, cx, mono, segment, segmentItem } from "@/components/ui";
import { fmtClock } from "@/lib/format";
import {
  applyDrag,
  deleteRegion,
  duplicateRegion,
  moveTrack,
  nudgeRegion,
  previewDrag,
  regionById,
  setRegionGain,
  splitRegion,
  trimTail,
  type Arrangement,
  type DragIntent,
  type DragKind,
} from "@/lib/session/arrangement";
import { anySoloed } from "@/lib/session/mix";
import { positionLabel, snapLabel, SNAP_UNITS, type SnapUnit } from "@/lib/session/snap";
import { barToSeconds, secondsPerBar } from "@/lib/session/time";
import type { SessionRegion } from "@/lib/session/types";
import {
  DEFAULT_PX_PER_S,
  minTickSpacingS,
  regionsInView,
  scrollableSeconds,
  timeToX,
  xToTime,
  zoomBy,
  ZOOM_STEP,
  zoomToFit,
  type Viewport,
} from "@/lib/session/viewport";
import { useLibrary } from "@/lib/state/LibraryProvider";
import { LaneHeader, LANE_HEADER_WIDTH } from "./LaneHeader";
import { LANE_HEIGHT, RegionBlock } from "./RegionBlock";
import { RegionInspector } from "./RegionInspector";
import { onTimelineView } from "./timelineEvents";
import { laneGridStyle, LOCATOR_BAND, RULER_HEIGHT, TimelineRuler } from "./TimelineRuler";

interface Drag {
  intent: DragIntent;
  pointerS: number;
  trackId: string;
}

export function TimelinePanel() {
  const session = useSession();
  const lib = useLibrary();
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const laneTops = useRef<Array<{ trackId: string; top: number; bottom: number }>>([]);

  const [view, setView] = useState<Viewport>({ pxPerSecond: DEFAULT_PX_PER_S, scrollS: 0, widthPx: 800 });
  // The selection is the session's, not this panel's: a sentence and a pointer
  // have to be pointing at the same region.
  const selected = session.selectedRegionId;
  const setSelected = session.selectRegion;
  const [drag, setDrag] = useState<Drag | null>(null);
  const [follow, setFollow] = useState(true);

  const arrangement = session.arrangement;
  const tempo = session.tempo;
  const grid = session.grid;
  const contentEndS = Math.max(session.contentEndS, session.loop?.endS ?? 0);
  const soloMode = anySoloed(arrangement.tracks);
  const contentPx = scrollableSeconds(contentEndS, view) * view.pxPerSecond;

  // --- measuring and scrolling ---------------------------------------------
  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const measure = () => setView((v) => ({ ...v, widthPx: Math.max(0, node.clientWidth - LANE_HEADER_WIDTH) }));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // The viewport is mirrored in a ref so that zoom and scroll can read it
  // without doing anything inside a state updater; React is free to call an
  // updater twice, and a scroll set from inside one would jump.
  const viewRef = useRef(view);
  viewRef.current = view;

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const scrollS = node.scrollLeft / viewRef.current.pxPerSecond;
    if (Math.abs(scrollS - viewRef.current.scrollS) < 1e-6) return;
    setView((v) => ({ ...v, scrollS }));
  }, []);

  /** Zoom around a point, then put the scroll where the new viewport says. */
  const applyZoom = useCallback(
    (factor: number | "fit", anchorX?: number) => {
      const v = viewRef.current;
      const next = factor === "fit" ? zoomToFit(v, contentEndS) : zoomBy(v, factor, anchorX ?? v.widthPx / 2, contentEndS);
      viewRef.current = next;
      setView(next);
      const node = scrollRef.current;
      if (node) node.scrollLeft = next.scrollS * next.pxPerSecond;
    },
    [contentEndS],
  );

  // The sentence moves the same control the buttons do.
  useEffect(
    () =>
      onTimelineView((command) => {
        if (command.kind === "zoom") applyZoom(command.direction === "fit" ? "fit" : command.direction === "in" ? ZOOM_STEP : 1 / ZOOM_STEP);
        else {
          const node = scrollRef.current;
          if (node) node.scrollLeft = Math.max(0, command.sessionS * view.pxPerSecond - 80);
        }
      }),
    [applyZoom, view.pxPerSecond],
  );

  // --- the playhead, on a frame rather than in state ------------------------
  useEffect(() => {
    let frame = 0;
    const draw = () => {
      const node = playheadRef.current;
      if (node) {
        const at = session.position();
        node.style.transform = `translateX(${LANE_HEADER_WIDTH + at * view.pxPerSecond}px)`;
        if (follow && session.playing) {
          const scroller = scrollRef.current;
          if (scroller) {
            const x = at * view.pxPerSecond;
            const left = scroller.scrollLeft;
            const width = scroller.clientWidth - LANE_HEADER_WIDTH;
            if (x < left || x > left + width * 0.85) scroller.scrollLeft = Math.max(0, x - width * 0.15);
          }
        }
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [session, view.pxPerSecond, follow]);

  // --- pointers -------------------------------------------------------------
  const pointerSeconds = useCallback(
    (clientX: number): number => {
      const node = scrollRef.current;
      if (!node) return 0;
      const rect = node.getBoundingClientRect();
      return Math.max(0, xToTime(clientX - rect.left - LANE_HEADER_WIDTH + node.scrollLeft, { ...view, scrollS: 0 }));
    },
    [view],
  );

  const laneAt = useCallback((clientY: number): string | null => {
    for (const lane of laneTops.current) if (clientY >= lane.top && clientY < lane.bottom) return lane.trackId;
    return null;
  }, []);

  const onGrab = useCallback(
    (region: SessionRegion, kind: DragKind, event: ReactPointerEvent<HTMLElement>) => {
      const node = scrollRef.current;
      if (!node) return;
      event.preventDefault();
      // Lane rectangles are measured once, at the start of the drag, so a
      // pointer move costs a comparison rather than a layout.
      laneTops.current = arrangement.tracks.flatMap((track) => {
        const el = node.querySelector<HTMLElement>(`[data-lane="${cssEscape(track.id)}"]`);
        if (!el) return [];
        const rect = el.getBoundingClientRect();
        return [{ trackId: track.id, top: rect.top, bottom: rect.bottom }];
      });
      const pointerS = pointerSeconds(event.clientX);
      node.setPointerCapture(event.pointerId);
      // so the arrow keys, Delete and undo reach the timeline after a drag
      node.focus({ preventScroll: true });
      setDrag({
        intent: { kind, regionId: region.id, grabOffsetS: kind === "move" ? pointerS - region.startS : 0, ...(kind === "move" ? { toTrackId: region.trackId } : {}) },
        pointerS,
        trackId: region.trackId,
      });
    },
    [arrangement.tracks, pointerSeconds],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      const pointerS = pointerSeconds(event.clientX);
      const overLane = drag.intent.kind === "move" ? laneAt(event.clientY) : null;
      setDrag((d) => (d === null ? null : { ...d, pointerS, intent: overLane ? { ...d.intent, toTrackId: overLane } : d.intent }));
    },
    [drag, pointerSeconds, laneAt],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!drag) return;
      try {
        scrollRef.current?.releasePointerCapture(event.pointerId);
      } catch {
        // the pointer was already released (a cancel after an up); nothing to do
      }
      const next = applyDrag(arrangement, drag.intent, drag.pointerS, { grid });
      setDrag(null);
      session.edit(next, labelFor(drag.intent.kind));
    },
    [drag, arrangement, grid, session],
  );

  const previewed = useMemo(() => (drag ? previewDrag(arrangement, drag.intent, drag.pointerS, { grid }) : null), [drag, arrangement, grid]);

  // --- editing --------------------------------------------------------------
  const selectedRegion = selected ? regionById(arrangement, selected) : null;
  const selectedLane = selectedRegion ? arrangement.tracks.find((t) => t.id === selectedRegion.trackId) ?? null : null;

  const editSelected = useCallback(
    (make: (a: Arrangement, id: string) => Arrangement, label: string, coalesceKey?: string) => {
      if (!selected) return;
      session.edit(make(arrangement, selected), label, coalesceKey === undefined ? {} : { coalesceKey });
    },
    [selected, arrangement, session],
  );

  const nudge = useCallback(
    (steps: number) => {
      if (!selected) return;
      // A run of arrow presses is one undo step, not forty (history.ts).
      session.edit(nudgeRegion(arrangement, selected, steps, { grid }), "nudge", { coalesceKey: `nudge:${selected}` });
    },
    [selected, arrangement, grid, session],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.target instanceof HTMLInputElement) return;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "z") {
        if (event.shiftKey) session.redo();
        else session.undo();
      } else if (meta && event.key.toLowerCase() === "y") {
        session.redo();
      } else if (event.key === "ArrowLeft") {
        nudge(-1);
      } else if (event.key === "ArrowRight") {
        nudge(1);
      } else if (event.key === "Delete" || event.key === "Backspace") {
        editSelected(deleteRegion, "delete");
        setSelected(null);
      } else if (event.key === "Escape") {
        setSelected(null);
      } else {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    },
    [session, nudge, editSelected, setSelected],
  );

  // --- the ruler ------------------------------------------------------------
  const locatorFrom = useRef<number | null>(null);
  const lastScrub = useRef(0);
  const onRulerPointer = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const down = event.type === "pointerdown";
      if (!down && event.buttons === 0) return;
      const at = pointerSeconds(event.clientX);
      // The top band sets the locators, the rest moves the playhead. Measured
      // against the band's own box rather than `offsetY`, which is relative to
      // whichever tick the pointer happened to be over.
      const rect = event.currentTarget.getBoundingClientRect();
      const inBand = event.clientY - rect.top < LOCATOR_BAND + 2;
      if (down) {
        event.currentTarget.setPointerCapture(event.pointerId);
        locatorFrom.current = inBand || event.shiftKey ? at : null;
      }
      const from = locatorFrom.current;
      if (from === null) {
        // A seek stops every source and re-plans, so a scrub is throttled:
        // twenty times a second reads as continuous and sixty is wasted work.
        const now = typeof performance === "undefined" ? Date.now() : performance.now();
        if (!down && now - lastScrub.current < 50) return;
        lastScrub.current = now;
        session.seek(at);
        return;
      }
      const least = Math.max(0.05, tempo ? secondsPerBar(tempo) / 4 : 0.25);
      session.setLoop({ startS: Math.min(from, at), endS: Math.max(from, at) + (Math.abs(at - from) < least ? least : 0) });
    },
    [pointerSeconds, session, tempo],
  );

  const lanes = arrangement.tracks;
  const empty = lanes.length === 0;
  // Stable identities for the hot props: a memoized region must not re-render
  // because a handler or a lookup object was rebuilt.
  const onSelectRegion = useCallback((region: SessionRegion) => setSelected(region.id), [setSelected]);
  const contentView = useMemo(() => ({ ...view, scrollS: 0 }), [view]);
  const fileOf = useMemo(() => new Map(lib.files.map((f) => [f.id, f])), [lib.files]);
  const regionsByLane = useMemo(() => {
    const out = new Map<string, SessionRegion[]>();
    for (const region of arrangement.regions) {
      const list = out.get(region.trackId);
      if (list) list.push(region);
      else out.set(region.trackId, [region]);
    }
    return out;
  }, [arrangement.regions]);

  return (
    <div className="flex-1 min-h-0 flex flex-col" onKeyDown={onKeyDown}>
      <Toolbar
        snap={session.snap}
        onSnap={session.setSnap}
        onZoom={applyZoom}
        canUndo={session.canUndo}
        canRedo={session.canRedo}
        undoLabel={session.undoLabel}
        redoLabel={session.redoLabel}
        onUndo={session.undo}
        onRedo={session.redo}
        follow={follow}
        onFollow={() => setFollow((f) => !f)}
        tempo={tempo === null ? null : `${tempo.bpm.toFixed(1)} BPM`}
        lengthLabel={contentEndS > 0 ? `${fmtClock(contentEndS, 0)} long` : null}
      />

      {empty ? (
        <div className="px-4 py-3 text-sm text-chalk-dim max-w-[560px]">
          <p>Nothing in the song yet. Commit a candidate from a rack and it becomes a lane here, on the same clock as everything else.</p>
          <p className="mt-2">Then drag it to move it, drag an edge to trim it, and every region keeps its line back to the record it came from.</p>
        </div>
      ) : (
        <div
          ref={scrollRef}
          className="flex-1 min-h-0 overflow-auto relative outline-none"
          tabIndex={0}
          role="application"
          aria-label="The song: lanes and regions on a timeline"
          onScroll={onScroll}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <div className="relative" style={{ width: LANE_HEADER_WIDTH + contentPx, minWidth: "100%" }}>
            {/* the ruler, held at the top while the lanes scroll under it */}
            <div className="sticky top-0 z-20 flex bg-graphite border-b border-rule" style={{ height: RULER_HEIGHT }}>
              <div className="sticky left-0 z-30 shrink-0 bg-graphite border-r border-rule" style={{ width: LANE_HEADER_WIDTH }} />
              <div className="relative cursor-text" onPointerDown={onRulerPointer} onPointerMove={onRulerPointer} title="Click to move the playhead; drag along the top band to set the locators">
                <TimelineRuler
                  fromS={view.scrollS}
                  toS={view.scrollS + view.widthPx / view.pxPerSecond}
                  tempo={tempo}
                  minSpacingS={minTickSpacingS(view)}
                  pxPerSecond={view.pxPerSecond}
                  widthPx={contentPx}
                  loop={session.loop}
                />
              </div>
            </div>

            {lanes.map((track, index) => {
              const regions = regionsByLane.get(track.id) ?? [];
              const visible = regionsInView(regions, view, 2);
              const waiting = regions.some((r) => session.waiting.includes(r.sourceId));
              const audible = track.muted ? false : soloMode ? track.soloed : true;
              const ghostHere = previewed !== null && previewed.trackId === track.id && drag?.trackId !== track.id;
              return (
                <div key={track.id} className="flex border-b border-rule" style={{ height: LANE_HEIGHT }} data-lane={track.id}>
                  <div className={cx("sticky left-0 z-10 shrink-0 border-r border-rule", audible ? "bg-graphite" : "bg-slate")} style={{ width: LANE_HEADER_WIDTH }}>
                    <LaneHeader
                      track={track}
                      audible={audible}
                      waiting={waiting}
                      regionCount={regions.length}
                      onMute={session.setMute}
                      onSolo={session.setSolo}
                      onGain={session.setGain}
                      onRemove={session.removeTrack}
                      onMoveUp={(id) => session.edit(moveTrack(arrangement, id, index - 1), "restack")}
                      onMoveDown={(id) => session.edit(moveTrack(arrangement, id, index + 1), "restack")}
                      canMoveUp={index > 0}
                      canMoveDown={index < lanes.length - 1}
                    />
                  </div>
                  <div className="relative" style={{ width: contentPx, ...laneGridStyle(view.pxPerSecond, tempo) }}>
                    {visible.map((region) => {
                      const shown = previewed !== null && previewed.id === region.id ? previewed : region;
                      if (previewed !== null && previewed.id === region.id && previewed.trackId !== track.id) return null;
                      const file = fileOf.get(region.sourceId);
                      return (
                        <RegionBlock
                          key={region.id}
                          region={shown}
                          x={timeToX(shown.startS, contentView)}
                          widthPx={shown.durationS * view.pxPerSecond}
                          selected={selected === region.id}
                          ghosted={false}
                          waiting={session.waiting.includes(region.sourceId)}
                          peaks={file?.peaks ?? null}
                          sourceDurationS={file?.duration_s ?? region.lineage?.sourceDurationS ?? null}
                          onGrab={onGrab}
                          onSelect={onSelectRegion}
                        />
                      );
                    })}
                    {ghostHere && previewed && (
                      <RegionBlock
                        region={previewed}
                        x={timeToX(previewed.startS, contentView)}
                        widthPx={previewed.durationS * view.pxPerSecond}
                        selected
                        ghosted
                        waiting={false}
                        peaks={fileOf.get(previewed.sourceId)?.peaks ?? null}
                        sourceDurationS={fileOf.get(previewed.sourceId)?.duration_s ?? previewed.lineage?.sourceDurationS ?? null}
                        onGrab={onGrab}
                        onSelect={onSelectRegion}
                      />
                    )}
                  </div>
                </div>
              );
            })}

            {/* one playhead for the whole song, written straight to a transform */}
            <div ref={playheadRef} className="absolute top-0 bottom-0 w-px bg-pad pointer-events-none z-[5]" style={{ left: 0 }} aria-hidden />
          </div>
        </div>
      )}

      <RegionInspector
        region={selectedRegion}
        laneName={selectedLane?.name ?? null}
        tempo={tempo}
        onMoveToBar={(bar) => {
          if (!tempo || !selectedRegion || !Number.isFinite(bar)) return;
          editSelected((a, id) => movedTo(a, id, barToSeconds(bar, tempo)), "move");
        }}
        onLengthBars={(bars) => {
          if (!tempo || !selectedRegion || !Number.isFinite(bars) || bars <= 0) return;
          editSelected((a, id) => trimTail(a, id, selectedRegion.startS + bars * secondsPerBar(tempo), { grid }), "trim the end");
        }}
        onGain={(gain) => editSelected((a, id) => setRegionGain(a, id, gain), "level", `region-gain:${selected}`)}
        onDuplicate={() => editSelected((a, id) => duplicateRegion(a, id, { grid }), "duplicate")}
        onSplit={() => editSelected((a, id) => splitRegion(a, id, session.position(), { grid }), "split")}
        onDelete={() => {
          editSelected(deleteRegion, "delete");
          setSelected(null);
        }}
        onLoopRegion={() => {
          if (selectedRegion) session.setLoop({ startS: selectedRegion.startS, endS: selectedRegion.startS + selectedRegion.durationS });
        }}
      />

      <div className="shrink-0 border-t border-rule px-3 py-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-xs text-chalk-dim">Say it instead</span>
        <span className="text-xs text-chalk-faint">
          &ldquo;move the drums to bar 17&rdquo;, &ldquo;trim it to 4 bars&rdquo;, &ldquo;split it here&rdquo;, &ldquo;duplicate it&rdquo;, &ldquo;snap to 16ths&rdquo;, &ldquo;undo&rdquo;
        </span>
        <PlayheadReadout />
      </div>
    </div>
  );
}

function Toolbar({
  snap,
  onSnap,
  onZoom,
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  onUndo,
  onRedo,
  follow,
  onFollow,
  tempo,
  lengthLabel,
}: {
  snap: SnapUnit;
  onSnap: (unit: SnapUnit) => void;
  onZoom: (factor: number | "fit") => void;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  onUndo: () => void;
  onRedo: () => void;
  follow: boolean;
  onFollow: () => void;
  tempo: string | null;
  lengthLabel: string | null;
}) {
  return (
    <div className="shrink-0 px-3 py-1.5 border-b border-rule flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="flex items-center gap-1.5">
        <span className="text-xs text-chalk-dim">Snap</span>
        <span className={segment} role="group" aria-label="Snap">
          {SNAP_UNITS.map((unit) => (
            <button key={unit} type="button" className={segmentItem} data-active={snap === unit} onClick={() => onSnap(unit)} aria-pressed={snap === unit} title={`Drags land on ${snapLabel(unit)}`}>
              {snapLabel(unit)}
            </button>
          ))}
        </span>
      </span>

      <span className="flex items-center gap-0.5">
        <button type="button" className={btnQuiet} onClick={() => onZoom(1 / ZOOM_STEP)} aria-label="Zoom out" title="Zoom out">
          −
        </button>
        <button type="button" className={btnQuiet} onClick={() => onZoom(ZOOM_STEP)} aria-label="Zoom in" title="Zoom in">
          +
        </button>
        <button type="button" className={btnQuiet} onClick={() => onZoom("fit")} title="Fit the whole song on screen">
          Fit
        </button>
      </span>

      <span className="flex items-center gap-0.5">
        <button type="button" className={btnQuiet} onClick={onUndo} disabled={!canUndo} title={canUndo ? `Undo ${undoLabel}` : "Nothing to undo"}>
          Undo
        </button>
        <button type="button" className={btnQuiet} onClick={onRedo} disabled={!canRedo} title={canRedo ? `Redo ${redoLabel}` : "Nothing to redo"}>
          Redo
        </button>
      </span>

      <button type="button" className={cx(btnQuiet, follow && "text-pad")} onClick={onFollow} aria-pressed={follow} title="Scroll to keep the playhead on screen while it plays">
        Follow
      </button>

      <span className="ml-auto flex items-center gap-3 text-xs text-chalk-faint">
        {tempo && <span title="The session's grid. Bar 1 is second zero.">{tempo}</span>}
        {lengthLabel && <span>{lengthLabel}</span>}
      </span>
    </div>
  );
}

/**
 * Where the playhead is, in bars. Its own component with its own frame, so the
 * song does not re-render sixty times a second to move a line of text.
 */
function PlayheadReadout() {
  const session = useSession();
  const [at, setAt] = useState(0);
  useEffect(() => {
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      if (now - last > 100) {
        last = now;
        setAt(session.position());
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [session]);
  return (
    <span className={cx(mono, "ml-auto text-xs text-chalk-faint")} title="Where the playhead is">
      {positionLabel(at, session.tempo)}
    </span>
  );
}

/** Move a region's start without touching its audio; the grid is applied by `moveRegion`. */
function movedTo(arrangement: Arrangement, regionId: string, toStartS: number): Arrangement {
  const region = regionById(arrangement, regionId);
  if (!region) return arrangement;
  return { tracks: arrangement.tracks, regions: arrangement.regions.map((r) => (r.id === regionId ? { ...r, startS: Math.max(0, toStartS) } : r)) };
}

function labelFor(kind: DragKind): string {
  return kind === "move" ? "move" : kind === "trim-head" ? "trim the start" : "trim the end";
}

/** `CSS.escape` is not in every runtime the tests touch; the ids here are ours. */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}
