"use client";

// The master bus: a level, and a limiter that is allowed to be gentle.
//
// The line from PRODUCT_DIRECTION, kept visible in the interface itself: this
// can only ever make the session quieter. There is no makeup gain and no
// loudness readout, because those are what turn a safety net into a mastering
// chain, and a mastering chain does not answer "does this fit".

import { btnQuiet, cx, mono } from "@/components/ui";
import { describeLimiter } from "@/lib/processing/master";
import { MAX_CEILING_DB, MIN_CEILING_DB, type MasterProcessing } from "@/lib/processing/types";

export function MasterStrip({
  master,
  levelDb,
  reductionDb,
  onLevel,
  onLimiter,
  onBypass,
}: {
  master: MasterProcessing;
  levelDb: number;
  /** how much the limiter is holding back right now; 0 when it is not */
  reductionDb: number;
  onLevel: (db: number) => void;
  onLimiter: (patch: { enabled?: boolean; ceilingDb?: number }) => void;
  onBypass: (bypassed: boolean) => void;
}) {
  const holding = master.limiter.enabled && !master.bypassed && reductionDb < -0.1;
  return (
    <div className="px-3 py-2 border-t border-rule flex flex-wrap items-center gap-x-3 gap-y-1.5">
      <span className="text-xs text-chalk-dim w-[52px] shrink-0">Master</span>

      <label className="flex items-center gap-1.5 text-2xs text-chalk-dim" title="The whole session's level. Everything on the bus passes through this.">
        level
        <input
          type="range"
          min={-24}
          max={6}
          step={1}
          value={Math.round(levelDb)}
          onChange={(e) => onLevel(Number(e.target.value))}
          className="w-[96px] accent-[#f0a63a]"
          aria-label="Master level in decibels"
        />
        <span className={cx(mono, "text-2xs text-chalk-faint w-[40px] text-right")}>{Math.round(levelDb) > 0 ? `+${Math.round(levelDb)}` : Math.round(levelDb)} dB</span>
      </label>

      <button
        type="button"
        className={cx("h-6 px-2 rounded-sm border text-xs", master.limiter.enabled && !master.bypassed ? "border-pad text-pad" : "border-rule text-chalk-dim hover:text-chalk")}
        aria-pressed={master.limiter.enabled && !master.bypassed}
        onClick={() => onLimiter({ enabled: !master.limiter.enabled })}
        title="A gentle limiter: 8:1 with a soft knee, so four lanes stacked on each other stop clipping the output without the session starting to sound limited. No makeup gain — it can only make things quieter."
      >
        Limiter
      </button>

      <label className="flex items-center gap-1 text-2xs text-chalk-dim" title="Where it starts holding peaks back.">
        ceiling
        <input
          type="number"
          min={MIN_CEILING_DB}
          max={MAX_CEILING_DB}
          step={1}
          value={Math.round(master.limiter.ceilingDb)}
          onChange={(e) => onLimiter({ ceilingDb: Number(e.target.value) })}
          className={cx(mono, "w-[52px] h-6 px-1 rounded-sm bg-slate border border-rule text-xs text-chalk disabled:opacity-40")}
          disabled={!master.limiter.enabled}
          aria-label="Limiter ceiling in decibels"
        />
        dB
      </label>

      {master.limiter.enabled && (
        <button type="button" className={cx(btnQuiet, master.bypassed && "text-pad")} aria-pressed={master.bypassed} onClick={() => onBypass(!master.bypassed)} title="Take the bus out of circuit to hear it without the limiter">
          {master.bypassed ? "Bypassed" : "Bypass"}
        </button>
      )}

      <span className={cx(mono, "text-2xs ml-auto", holding ? "text-pad" : "text-chalk-faint")} title="What the limiter is set to, and what it is doing right now. Measured off the node, never estimated.">
        {describeLimiter(master.limiter)}
        {holding ? ` · holding ${Math.abs(Math.round(reductionDb * 10) / 10)} dB` : ""}
      </span>
    </div>
  );
}
