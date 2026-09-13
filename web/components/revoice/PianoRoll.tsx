"use client";

// The piano roll: pitch rows, time columns in beats at the file's tempo,
// notes as blocks. Drag a block to move it in time (snapped to 16ths unless
// free) and vertically to change pitch; drag its right edge for length; click
// empty space to add; Delete removes the selected note; arrows nudge. SVG,
// no library. The editing itself lives in lib/pianoroll/model.ts.

import { useMemo, useRef, useState } from "react";
import { addNote, isBlackKey, moveNote, noteName, pitchBounds, resizeNote, totalBeats, type EditOptions, type RollNote } from "@/lib/pianoroll/model";
import { formatRulerBeat } from "@/lib/pianoroll/time";

const ROW_H = 10;
const PX_PER_BEAT = 44;
const GUTTER = 40;
const RULER_H = 16;
const HANDLE_PX = 6;
const CLICK_PX = 4;

type Drag =
  | { kind: "move" | "resize"; id: string; startX: number; startY: number; orig: RollNote[]; moved: boolean }
  | { kind: "blank"; startX: number; startY: number; moved: boolean };

export function PianoRoll({
  notes,
  onChange,
  selectedId,
  onSelect,
  opts,
  onDeleteSelected,
}: {
  notes: RollNote[];
  onChange: (notes: RollNote[]) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  opts: EditOptions;
  onDeleteSelected: () => void;
}) {
  // The drawn range only ever widens while editing, so the roll does not jump under a drag.
  const boundsRef = useRef(pitchBounds(notes));
  const beatsRef = useRef(totalBeats(notes, opts.bpm));
  const bounds = useMemo(() => {
    const b = pitchBounds(notes);
    boundsRef.current = { low: Math.min(boundsRef.current.low, b.low), high: Math.max(boundsRef.current.high, b.high) };
    return boundsRef.current;
  }, [notes]);
  const beats = useMemo(() => {
    beatsRef.current = Math.max(beatsRef.current, totalBeats(notes, opts.bpm));
    return beatsRef.current;
  }, [notes, opts.bpm]);

  const rows = bounds.high - bounds.low + 1;
  const height = RULER_H + rows * ROW_H;
  const width = GUTTER + beats * PX_PER_BEAT;
  const pxPerSec = PX_PER_BEAT / (60 / opts.bpm);
  const xOf = (t: number) => GUTTER + t * pxPerSec;
  const yOf = (pitch: number) => RULER_H + (bounds.high - pitch) * ROW_H;
  const timeAt = (x: number) => Math.max(0, (x - GUTTER) / pxPerSec);
  const pitchAt = (y: number) => bounds.high - Math.floor((y - RULER_H) / ROW_H);

  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const [cursor, setCursor] = useState<string>("crosshair");

  const local = (e: React.PointerEvent) => {
    const rect = svgRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  };

  const hitTest = (x: number, y: number): { note: RollNote; edge: boolean } | null => {
    for (let i = notes.length - 1; i >= 0; i--) {
      const n = notes[i]!;
      const x0 = xOf(n.start_s);
      const x1 = Math.max(x0 + 3, xOf(n.end_s));
      const y0 = yOf(n.pitch);
      if (x >= x0 && x <= x1 && y >= y0 && y < y0 + ROW_H) return { note: n, edge: x >= x1 - HANDLE_PX };
    }
    return null;
  };

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const { x, y } = local(e);
    if (x < GUTTER || y < RULER_H) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
    const hit = hitTest(x, y);
    if (hit) {
      onSelect(hit.note.id);
      drag.current = { kind: hit.edge ? "resize" : "move", id: hit.note.id, startX: x, startY: y, orig: notes, moved: false };
    } else {
      drag.current = { kind: "blank", startX: x, startY: y, moved: false };
    }
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const { x, y } = local(e);
    const d = drag.current;
    if (!d) {
      const hit = x >= GUTTER && y >= RULER_H ? hitTest(x, y) : null;
      setCursor(hit ? (hit.edge ? "ew-resize" : "grab") : "crosshair");
      return;
    }
    if (Math.abs(x - d.startX) > CLICK_PX || Math.abs(y - d.startY) > CLICK_PX) d.moved = true;
    if (d.kind === "move") {
      const deltaS = (x - d.startX) / pxPerSec;
      const deltaPitch = -Math.round((y - d.startY) / ROW_H);
      onChange(moveNote(d.orig, d.id, deltaS, deltaPitch, opts));
    } else if (d.kind === "resize") {
      onChange(resizeNote(d.orig, d.id, timeAt(x), opts));
    }
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "blank" && !d.moved) {
      const { x, y } = local(e);
      const pitch = pitchAt(y);
      if (pitch < bounds.low || pitch > bounds.high) return;
      const res = addNote(notes, { pitch, start_s: timeAt(x) }, opts);
      onChange(res.notes);
      onSelect(res.id);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      onDeleteSelected();
      return;
    }
    if (e.key === "Escape") {
      onSelect(null);
      return;
    }
    if (!selectedId) return;
    const step = 60 / opts.bpm / 4;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const dir = e.key === "ArrowLeft" ? -1 : 1;
      onChange(moveNote(notes, selectedId, dir * (e.shiftKey ? step * 4 * 4 : opts.snap ? step : 0.01), 0, opts));
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      const dir = e.key === "ArrowUp" ? 1 : -1;
      onChange(moveNote(notes, selectedId, 0, dir * (e.shiftKey ? 12 : 1), { ...opts, snap: false }));
    }
  };

  const bars = Math.ceil(beats / 4);
  const gridLines: React.ReactNode[] = [];
  for (let b = 0; b <= beats; b++) {
    const x = GUTTER + b * PX_PER_BEAT + 0.5;
    const bar = b % 4 === 0;
    gridLines.push(<line key={`b${b}`} x1={x} x2={x} y1={RULER_H} y2={height} stroke={bar ? "var(--color-rule-strong)" : "var(--color-rule)"} strokeWidth={1} />);
    if (b < beats) {
      for (let k = 1; k < 4; k++) {
        const xs = x + (k * PX_PER_BEAT) / 4;
        gridLines.push(<line key={`s${b}-${k}`} x1={xs} x2={xs} y1={RULER_H} y2={height} stroke="var(--color-rule)" strokeOpacity={0.45} strokeWidth={1} />);
      }
    }
  }

  return (
    <div className="overflow-auto max-h-[360px] bg-slate border-t border-b border-rule" style={{ scrollbarGutter: "stable" }}>
      <svg
        ref={svgRef}
        width={width}
        height={height}
        role="application"
        aria-label="Piano roll: drag to move notes, drag the right edge for length, click empty space to add, Delete removes"
        tabIndex={0}
        className="block outline-none focus-visible:[outline:2px_solid_var(--color-pad)] focus-visible:-outline-offset-2 select-none touch-none"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
        }}
        onKeyDown={onKeyDown}
      >
        {/* pitch rows */}
        {Array.from({ length: rows }, (_, i) => {
          const pitch = bounds.high - i;
          const black = isBlackKey(pitch);
          return <rect key={pitch} x={GUTTER} y={RULER_H + i * ROW_H} width={width - GUTTER} height={ROW_H} fill={black ? "var(--color-graphite)" : "var(--color-slate)"} />;
        })}
        {gridLines}
        {/* ruler */}
        <rect x={0} y={0} width={width} height={RULER_H} fill="var(--color-graphite)" />
        <line x1={0} x2={width} y1={RULER_H - 0.5} y2={RULER_H - 0.5} stroke="var(--color-rule)" />
        {Array.from({ length: bars + 1 }, (_, b) => (
          <text key={`bar${b}`} x={GUTTER + b * 4 * PX_PER_BEAT + 3} y={11} fontSize={10} fill="var(--color-chalk-dim)" fontFamily="var(--font-jetbrains-mono), monospace">
            {formatRulerBeat(b * 4)}
          </text>
        ))}
        {/* gutter */}
        <rect x={0} y={RULER_H} width={GUTTER} height={height - RULER_H} fill="var(--color-graphite)" />
        <line x1={GUTTER - 0.5} x2={GUTTER - 0.5} y1={0} y2={height} stroke="var(--color-rule)" />
        {Array.from({ length: rows }, (_, i) => {
          const pitch = bounds.high - i;
          if (pitch % 12 !== 0) return null;
          return (
            <text key={`n${pitch}`} x={4} y={RULER_H + i * ROW_H + 8} fontSize={9} fill="var(--color-chalk-dim)" fontFamily="var(--font-jetbrains-mono), monospace">
              {noteName(pitch)}
            </text>
          );
        })}
        {/* notes */}
        {notes.map((n) => {
          const x = xOf(n.start_s);
          const w = Math.max(3, xOf(n.end_s) - x);
          const y = yOf(n.pitch);
          const selected = n.id === selectedId;
          return (
            <g key={n.id}>
              <rect
                x={x}
                y={y + 1}
                width={w}
                height={ROW_H - 2}
                rx={1}
                fill={selected ? "var(--color-pad)" : "var(--color-chalk-dim)"}
                fillOpacity={selected ? 1 : 0.35 + 0.65 * (n.velocity / 127)}
                stroke={selected ? "var(--color-pad)" : "var(--color-chalk-faint)"}
                strokeWidth={1}
              >
                <title>{`${noteName(n.pitch)} at ${n.start_s.toFixed(3)} s for ${(n.end_s - n.start_s).toFixed(3)} s, velocity ${n.velocity}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
