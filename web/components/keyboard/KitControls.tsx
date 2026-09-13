"use client";

// Every choice the producer makes about how the keyboard plays, on one row:
// the layout, one-shot or gate, chop or note, where the root sits. Plus the
// two numbers that are measured rather than claimed — how long a key takes to
// make a sound, and how many keys the hardware will actually report.

import { btnQuiet, cx, label, segment, segmentItem } from "@/components/ui";
import { MAX_SIMULTANEOUS_KEYS, PLAY_MODES, POLYPHONY_NOTE, TRIGGER_MODES, type PadKit } from "@/lib/pads/kit";
import { LAYOUTS, keyLabel, layoutOr, shortcutsTakenBy } from "@/lib/pads/layouts";
import { describeLatency, type LatencySummary } from "@/lib/pads/latency";
import type { KitState } from "./useKit";

export function KitControls({
  kit,
  kitState,
  latency,
  held,
  hitCeiling,
  onAllOff,
}: {
  kit: PadKit;
  kitState: KitState;
  latency: LatencySummary;
  held: ReadonlySet<number>;
  hitCeiling: boolean;
  onAllOff: () => void;
}) {
  const layout = layoutOr(kit.layoutId);
  const taken = shortcutsTakenBy(layout);
  const trigger = TRIGGER_MODES.find((m) => m.id === kit.trigger);
  const play = PLAY_MODES.find((m) => m.id === kit.play);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className={label}>Keys</span>
          <div className={segment} role="group" aria-label="Layout">
            {LAYOUTS.map((l) => (
              <button key={l.id} type="button" data-active={kit.layoutId === l.id} onClick={() => kitState.setLayout(l.id)} className={cx(segmentItem, "font-mono")} title={l.describe}>
                {l.label}
              </button>
            ))}
          </div>
        </div>

        <div className={segment} role="group" aria-label="Trigger">
          {TRIGGER_MODES.map((m) => (
            <button key={m.id} type="button" data-active={kit.trigger === m.id} onClick={() => kitState.setTrigger(m.id)} className={segmentItem} title={m.describe}>
              {m.label}
            </button>
          ))}
        </div>

        <div className={segment} role="group" aria-label="Play mode">
          {PLAY_MODES.map((m) => (
            <button key={m.id} type="button" data-active={kit.play === m.id} onClick={() => kitState.setPlay(m.id)} className={segmentItem} title={m.describe}>
              {m.label}
            </button>
          ))}
        </div>

        {kit.play === "note" && (
          <label className="flex items-center gap-1.5 text-xs text-chalk-dim">
            root
            <select
              className="h-6 px-1 rounded-sm bg-slate border border-rule text-xs text-chalk font-mono"
              value={kit.rootPad}
              onChange={(e) => kitState.setRootPad(Number(e.target.value))}
              aria-label="Root key"
            >
              {layout.keys.map((key, i) => (
                <option key={key} value={i + 1}>
                  {keyLabel(key)}
                </option>
              ))}
            </select>
          </label>
        )}

        <button type="button" className={btnQuiet} onClick={onAllOff} title="Release every sounding pad">
          All off
        </button>
      </div>

      <p className="text-xs text-chalk-dim max-w-[560px]">
        {trigger?.describe} {play?.describe}
        {kit.play === "note" && " Pitch and length move together, the way a sampler does it."}
      </p>

      <p className={cx("text-xs max-w-[560px]", hitCeiling ? "text-chalk border-l-2 border-pad pl-2" : "text-chalk-dim")}>
        {POLYPHONY_NOTE}
        {held.size >= MAX_SIMULTANEOUS_KEYS && ` ${held.size} keys are down right now, which is as many as it will take.`}
      </p>

      {taken.length > 0 && (
        <p className="text-xs text-chalk-dim max-w-[560px]">
          This layout plays {taken.map((t) => keyLabel(t.key)).join(", ")}, so while it is on screen those keys are pads rather than {taken.map((t) => t.does).join(", ")}. Ctrl and Cmd shortcuts are never touched.
        </p>
      )}

      <p className="text-xs text-chalk-dim font-mono" aria-live="polite">
        {describeLatency(latency)}
      </p>
    </div>
  );
}
