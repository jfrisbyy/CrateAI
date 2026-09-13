"use client";

// One band's numbers, editable.
//
// Principle 4: an output you cannot correct is not done. The curve is the fast
// way to move a band and this is the exact one — and it is also the keyboard
// way, so every processor is reachable without a pointer. A band the AI moved
// says so and carries the reason it gave, in its own words, where the producer
// can read it before deciding whether to keep it.

import { btnQuiet, cx, mono } from "@/components/ui";
import { formatHz } from "@/lib/processing/eq";
import { BAND_NAMES, HIGHPASS_CEILING_HZ, LOWPASS_FLOOR_HZ, MAX_BOOST_DB, MAX_CUT_DB, MAX_FREQ_HZ, MAX_Q, MIN_FREQ_HZ, MIN_Q, type EqBand } from "@/lib/processing/types";

export function BandRow({
  band,
  selected,
  why,
  onSelect,
  onChange,
  onToggle,
}: {
  band: EqBand;
  selected: boolean;
  /** what a proposal said this move was for, kept verbatim; null when a hand moved it */
  why: string | null;
  onSelect: () => void;
  onChange: (patch: Partial<Pick<EqBand, "frequency" | "gainDb" | "q">>) => void;
  onToggle: () => void;
}) {
  const isPass = band.kind === "highpass" || band.kind === "lowpass";
  const maxFrequency = band.id === "hp" ? HIGHPASS_CEILING_HZ : MAX_FREQ_HZ;
  const minFrequency = band.id === "lp" ? LOWPASS_FLOOR_HZ : MIN_FREQ_HZ;

  return (
    <li className={cx("px-3 py-1 border-b border-rule flex flex-wrap items-center gap-x-2 gap-y-1", selected && "bg-slate")} onFocus={onSelect}>
      <button
        type="button"
        className={cx("h-5 w-5 shrink-0 rounded-sm border text-2xs", band.enabled ? "border-pad text-pad" : "border-rule text-chalk-faint hover:text-chalk")}
        aria-pressed={band.enabled}
        aria-label={`${BAND_NAMES[band.id]} on`}
        title={band.enabled ? "Switched on. Off is exactly unity — the band costs the signal nothing." : "Switch this band on"}
        onClick={onToggle}
      >
        {band.enabled ? "●" : "○"}
      </button>
      <button type="button" className={cx(btnQuiet, "w-[76px] justify-start shrink-0", selected && "text-chalk")} onClick={onSelect} title={`${BAND_NAMES[band.id]} (${band.kind})`}>
        {BAND_NAMES[band.id]}
      </button>

      <label className="flex items-center gap-1 text-2xs text-chalk-dim" title={`Where the band sits. ${band.id === "hp" ? `A high-pass stops at ${formatHz(HIGHPASS_CEILING_HZ)}: past there it is an effect, not a correction.` : band.id === "lp" ? `A low-pass stops at ${formatHz(LOWPASS_FLOOR_HZ)}.` : "The same control the handle on the curve drags."}`}>
        <input
          type="number"
          min={minFrequency}
          max={maxFrequency}
          step={1}
          value={Math.round(band.frequency)}
          onChange={(e) => onChange({ frequency: Number(e.target.value) })}
          className={cx(mono, "w-[64px] h-6 px-1 rounded-sm bg-slate border border-rule text-xs text-chalk")}
          aria-label={`${BAND_NAMES[band.id]} frequency in hertz`}
        />
        Hz
      </label>

      {!isPass && (
        <label className="flex items-center gap-1 text-2xs text-chalk-dim" title={`How much, in decibels. Boosts stop at +${MAX_BOOST_DB} dB; a cut may go to -${MAX_CUT_DB} dB, because taking something out is always corrective.`}>
          <input
            type="number"
            min={-MAX_CUT_DB}
            max={MAX_BOOST_DB}
            step={0.5}
            value={Math.round(band.gainDb * 10) / 10}
            onChange={(e) => onChange({ gainDb: Number(e.target.value) })}
            className={cx(mono, "w-[58px] h-6 px-1 rounded-sm bg-slate border border-rule text-xs text-chalk")}
            aria-label={`${BAND_NAMES[band.id]} gain in decibels`}
          />
          dB
        </label>
      )}

      {band.kind === "peaking" && (
        <label className="flex items-center gap-1 text-2xs text-chalk-dim" title="How narrow. About 1 is a musical dip; 3 or more is a spike, for something like sibilance.">
          Q
          <input
            type="number"
            min={MIN_Q}
            max={MAX_Q}
            step={0.1}
            value={Math.round(band.q * 100) / 100}
            onChange={(e) => onChange({ q: Number(e.target.value) })}
            className={cx(mono, "w-[54px] h-6 px-1 rounded-sm bg-slate border border-rule text-xs text-chalk")}
            aria-label={`${BAND_NAMES[band.id]} Q`}
          />
        </label>
      )}
      {band.kind === "lowshelf" || band.kind === "highshelf" ? (
        <span className="text-2xs text-chalk-faint" title="Shelving filters are computed with a fixed slope in the Web Audio specification, so a Q here would move the drawing and not the sound.">
          shelf
        </span>
      ) : null}

      {why && (
        <span className="basis-full text-2xs text-chalk-faint pl-7" title="What the proposal said this move was for, kept in its own words">
          {why}
        </span>
      )}
    </li>
  );
}
