"use client";

// Sixteen pads, four by four, keys 1–8 on the top two rows and Q–I on the
// bottom two (lib/pads/keymap.ts). A pad lights amber while it sounds.

import { cx } from "@/components/ui";
import type { PadBindings } from "@/lib/pads/bindings";
import type { BufferStatus } from "@/lib/pads/engine";
import { keyForPad } from "@/lib/pads/keymap";

export function PadGrid({
  bindings,
  lit,
  statuses,
  onTrigger,
}: {
  bindings: PadBindings;
  lit: ReadonlySet<number>;
  statuses: Readonly<Record<string, BufferStatus | null>>;
  onTrigger: (pad: number) => void;
}) {
  return (
    <div role="group" aria-label="Pads" className="grid grid-cols-4 gap-1.5">
      {bindings.map((binding, i) => {
        const pad = i + 1;
        const status = binding ? (statuses[binding.file_id] ?? null) : null;
        const isLit = lit.has(pad);
        const ready = binding !== null && status === "ready";
        return (
          <button
            key={pad}
            type="button"
            disabled={binding === null}
            data-pad={pad}
            data-lit={isLit || undefined}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              onTrigger(pad);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.repeat) onTrigger(pad);
            }}
            className={cx(
              "h-[60px] rounded-sm border px-1.5 py-1 flex flex-col justify-between text-left select-none touch-none transition-colors",
              isLit ? "border-pad bg-pad/15 text-pad" : binding ? "border-rule hover:border-rule-strong" : "border-rule text-chalk-faint",
              binding && !ready && !isLit && "text-chalk-dim",
            )}
            aria-label={binding ? `Pad ${pad}, ${binding.label}` : `Pad ${pad}, empty`}
            title={binding ? `${binding.label} (${binding.source === "chop" ? `chop ${binding.detail}` : binding.detail}) — key ${keyForPad(pad)}` : `Empty — key ${keyForPad(pad)}`}
          >
            <span className="flex items-baseline justify-between gap-1">
              <span className="font-mono text-xs">{keyForPad(pad)}</span>
              <span className="font-mono text-2xs text-chalk-dim">{binding?.source === "chop" ? binding.detail.padStart(2, "0") : ""}</span>
            </span>
            <span className="text-xs truncate">
              {binding ? (status === "loading" ? "decoding" : status === "error" ? "not loaded" : binding.label) : ""}
            </span>
          </button>
        );
      })}
    </div>
  );
}
