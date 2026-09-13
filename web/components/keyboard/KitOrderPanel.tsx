"use client";

// Which key gets what. A pile of slices in file order is not a kit, so this
// offers the orders the measurements can actually support — hit class from the
// drum pattern, pitch from the chords under each slice, position, length — and
// says, pad by pad, why a slice is under that key. Dragging one pad onto
// another swaps them and is logged as a correction against what was proposed.

import { useState } from "react";
import { btn, btnQuiet, cx, label, segment, segmentItem } from "@/components/ui";
import type { PadBindings } from "@/lib/pads/bindings";
import { ORDER_STRATEGIES, describeOrdering, type KitOrdering, type OrderStrategy } from "@/lib/pads/kitOrder";
import { keyLabel, layoutOr } from "@/lib/pads/layouts";
import type { PadKit } from "@/lib/pads/kit";

export function KitOrderPanel({
  kit,
  bindings,
  ordering,
  corrections,
  onOrder,
  onSwap,
}: {
  kit: PadKit;
  bindings: PadBindings;
  ordering: KitOrdering | null;
  corrections: number;
  onOrder: (strategy: OrderStrategy) => void;
  onSwap: (a: number, b: number) => void;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const layout = layoutOr(kit.layoutId);

  return (
    <section aria-label="Which key gets what" className="mt-3 border-t border-rule pt-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={label}>Kit</span>
        <div className={segment} role="group" aria-label="Order">
          {ORDER_STRATEGIES.map((s) => (
            <button key={s.id} type="button" data-active={ordering?.strategy === s.id} onClick={() => onOrder(s.id)} className={segmentItem} title={s.describe}>
              {s.label}
            </button>
          ))}
        </div>
        <button type="button" className={btnQuiet} onClick={() => setOpen((v) => !v)}>
          {open ? "Hide the reasons" : "Why this order"}
        </button>
      </div>

      <p className="mt-1.5 text-xs text-chalk-dim max-w-[640px]">
        {ordering ? describeOrdering(ordering) : "Slices sit in the order the chopper made them. Pick an order, or drag one pad onto another."}
        {corrections > 0 && ` ${corrections} ${corrections === 1 ? "pad" : "pads"} moved by hand; the moves are kept as corrections.`}
      </p>

      {ordering?.notes.map((note) => (
        <p key={note} className="mt-1 text-xs text-chalk-dim max-w-[640px]">
          {note}
        </p>
      ))}

      <div className="mt-2 flex flex-wrap gap-1" aria-label="Pads in kit order">
        {bindings.map((binding, i) => {
          const pad = i + 1;
          const key = layout.keys[i];
          return (
            <button
              key={pad}
              type="button"
              draggable={binding !== null}
              onDragStart={() => setPicked(pad)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (picked !== null && picked !== pad) onSwap(picked, pad);
                setPicked(null);
              }}
              onClick={() => {
                if (picked === null) {
                  setPicked(pad);
                  return;
                }
                if (picked !== pad) onSwap(picked, pad);
                setPicked(null);
              }}
              className={cx(
                "h-6 px-1.5 rounded-sm border text-2xs font-mono truncate max-w-[120px]",
                picked === pad ? "border-pad text-pad" : binding ? "border-rule text-chalk hover:border-rule-strong" : "border-rule text-chalk-faint",
              )}
              title={ordering?.reasons[i] ?? (binding ? binding.label : "empty")}
              aria-label={`Pad ${pad}, key ${key ? keyLabel(key) : pad}, ${binding?.label ?? "empty"}${picked === pad ? ", picked up" : ""}`}
            >
              {key ? keyLabel(key) : pad} {binding?.label ?? "—"}
            </button>
          );
        })}
      </div>

      {picked !== null && (
        <p className="mt-1 text-xs text-chalk">
          Pad {picked} picked up. Click another pad to swap them.{" "}
          <button type="button" className={btnQuiet} onClick={() => setPicked(null)}>
            Cancel
          </button>
        </p>
      )}

      {open && ordering && (
        <ul className="mt-2 flex flex-col gap-0.5 max-h-[200px] overflow-y-auto text-xs text-chalk-dim" aria-label="Why each pad got its slice">
          {ordering.reasons.map((reason, i) => (
            <li key={i} className="truncate" title={reason}>
              {reason}
            </li>
          ))}
        </ul>
      )}

      {ordering && ordering.method !== "none" && (
        <p className="mt-1 text-xs text-chalk-faint">
          Measured by <span className="font-mono">{ordering.method}</span>. <button type="button" className={btn} onClick={() => onOrder("file")}>Back to file order</button>
        </p>
      )}
    </section>
  );
}
