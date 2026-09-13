"use client";

// The pads, drawn the way the keys sit under the hands: the layout's own rows
// (lib/pads/layouts.ts), so a 4x4 of 1–8 and Q–I, or three rows of eight, or
// the whole keyboard, all read the same. A pad lights amber while it sounds
// and shows a rule while its key is held.
//
// The grid never decides anything. What a key means, what a pad plays and how
// long it sounds are all the pure mapping and the engine; this draws them.

import { cx } from "@/components/ui";
import type { PadBindings } from "@/lib/pads/bindings";
import type { BufferStatus } from "@/lib/pads/engine";
import { padCountOfKit, type PadKit } from "@/lib/pads/kit";
import { keyLabel, layoutOr, rowsOf } from "@/lib/pads/layouts";
import { intervalLabel, noteNameFor, semitonesForPad } from "@/lib/pads/note";

export function PadGrid({
  bindings,
  kit,
  lit,
  held,
  statuses,
  rootNote,
  onPress,
  onRelease,
  onPickRoot,
}: {
  bindings: PadBindings;
  kit: PadKit;
  lit: ReadonlySet<number>;
  held?: ReadonlySet<number>;
  statuses: Readonly<Record<string, BufferStatus | null>>;
  /** the file's measured key, when it has one, so note mode can name the notes */
  rootNote?: string | null;
  onPress: (pad: number) => void;
  onRelease: (pad: number) => void;
  /** shift-click a pad in note mode to make it the root */
  onPickRoot?: (pad: number) => void;
}) {
  const layout = layoutOr(kit.layoutId);
  const rows = rowsOf(layout);
  const count = padCountOfKit(kit);
  const note = kit.play === "note";
  // Ten keys to a row have to fit the same column a 4x4 sits in, so the caps
  // get narrower rather than the panel getting a sideways scrollbar.
  const minWidth = layout.columns >= 10 ? 28 : layout.columns >= 8 ? 36 : 46;
  let pad = 0;
  return (
    <div role="group" aria-label={`Pads, ${layout.label} keys`} className="flex flex-col gap-1.5">
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="flex gap-1.5">
          {row.map((key) => {
            pad += 1;
            return (
              <PadButton
                key={key}
                pad={pad}
                total={count}
                minWidth={minWidth}
                keyCap={keyLabel(key)}
                binding={bindings[pad - 1] ?? null}
                status={statusOf(bindings, statuses, pad)}
                isLit={lit.has(pad)}
                isHeld={held?.has(pad) ?? false}
                note={note}
                isRoot={note && pad === kit.rootPad}
                semitones={note ? semitonesForPad(pad, kit.rootPad) : 0}
                rootNote={rootNote ?? null}
                gate={kit.trigger === "gate"}
                onPress={onPress}
                onRelease={onRelease}
                onPickRoot={onPickRoot}
              />
            );
          })}
        </div>
      ))}
    </div>
  );
}

function statusOf(bindings: PadBindings, statuses: Readonly<Record<string, BufferStatus | null>>, pad: number): BufferStatus | null {
  const binding = bindings[pad - 1];
  return binding ? (statuses[binding.file_id] ?? null) : null;
}

function PadButton({
  pad,
  total,
  minWidth,
  keyCap,
  binding,
  status,
  isLit,
  isHeld,
  note,
  isRoot,
  semitones,
  rootNote,
  gate,
  onPress,
  onRelease,
  onPickRoot,
}: {
  pad: number;
  total: number;
  minWidth: number;
  keyCap: string;
  binding: PadBindings[number];
  status: BufferStatus | null;
  isLit: boolean;
  isHeld: boolean;
  note: boolean;
  isRoot: boolean;
  semitones: number;
  rootNote: string | null;
  gate: boolean;
  onPress: (pad: number) => void;
  onRelease: (pad: number) => void;
  onPickRoot?: (pad: number) => void;
}) {
  const ready = binding !== null && status === "ready";
  const playable = note ? true : binding !== null;
  const name = note ? (noteNameFor(rootNote, semitones) ?? intervalLabel(semitones)) : (binding?.label ?? "");
  const title = note
    ? `${isRoot ? "Root" : intervalLabel(semitones)}${rootNote ? `, ${noteNameFor(rootNote, semitones)}` : ""} — key ${keyCap}${onPickRoot ? ". Shift-click to make this the root." : ""}`
    : binding
      ? `${binding.label} (${binding.source === "chop" ? `chop ${binding.detail}` : binding.detail}) — key ${keyCap}`
      : `Empty — key ${keyCap}`;
  return (
    <button
      type="button"
      disabled={!playable}
      data-pad={pad}
      data-lit={isLit || undefined}
      data-held={isHeld || undefined}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        if (e.shiftKey && onPickRoot) {
          onPickRoot(pad);
          return;
        }
        e.currentTarget.setPointerCapture?.(e.pointerId);
        onPress(pad);
      }}
      onPointerUp={() => onRelease(pad)}
      onPointerCancel={() => onRelease(pad)}
      onLostPointerCapture={() => onRelease(pad)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.repeat) onPress(pad);
      }}
      onKeyUp={(e) => {
        if (e.key === "Enter") onRelease(pad);
      }}
      onBlur={() => onRelease(pad)}
      style={{ minWidth }}
      className={cx(
        "flex-1 h-[52px] rounded-sm border px-1 py-1 flex flex-col justify-between text-left select-none touch-none transition-colors overflow-hidden",
        isLit ? "border-pad bg-pad/15 text-pad" : playable ? "border-rule hover:border-rule-strong" : "border-rule text-chalk-faint",
        isHeld && !isLit && "border-rule-strong",
        isRoot && !isLit && "border-pad/60",
        binding && !ready && !isLit && "text-chalk-dim",
      )}
      aria-label={note ? `Pad ${pad} of ${total}, ${isRoot ? "root" : intervalLabel(semitones)}` : binding ? `Pad ${pad}, ${binding.label}` : `Pad ${pad}, empty`}
      aria-pressed={gate ? isHeld : undefined}
      title={title}
    >
      <span className="flex items-baseline justify-between gap-1">
        <span className="font-mono text-xs">{keyCap}</span>
        <span className="font-mono text-2xs text-chalk-dim">{note ? (isRoot ? "root" : intervalLabel(semitones)) : binding?.source === "chop" ? binding.detail.padStart(2, "0") : ""}</span>
      </span>
      <span className="text-xs truncate">{binding ? (status === "loading" ? "decoding" : status === "error" ? "not loaded" : name) : note ? name : ""}</span>
    </button>
  );
}
