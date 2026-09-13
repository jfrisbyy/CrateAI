"use client";

// One lane: the file and its vitals, the draggable block, and the per-lane
// state the packet names (offset, gain, stretch mode, pitch, mute, high/low
// pass). A lane at its defaults is "auto": the compute's plan (tempo match,
// key match, downbeat align) is applied at render time and written back to
// the row. The first hand edit to offset or pitch copies the predicted plan
// into the row first, so nudging a lane never loses its tempo match.

import { ConfidenceDot } from "@/components/surface/ConfidenceDot";
import { btn, btnQuiet, cx, label, segment, segmentItem } from "@/components/ui";
import { itemAtDefaults, type LaneFileVitals, type LayerItemPatchRequest, type PlanItem } from "@/lib/api/layers";
import { fmtBpm, fmtDuration } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { formatBarsBeats, formatSignedSeconds, type GridSnap } from "@/lib/pianoroll/time";
import type { LayerItemRow, Peaks } from "@/lib/types/db";
import { NumberField } from "./fields";
import { LaneTimeline, type TimelineScale } from "./LaneTimeline";

export interface LaneEffective {
  stretch: number;
  pitch: number;
  offset: number;
  /** still at the defaults: the plan applies at render time */
  auto: boolean;
}

export function laneEffective(item: LayerItemRow, plan: PlanItem | null): LaneEffective {
  const auto = itemAtDefaults(item);
  if (auto) return { stretch: plan?.stretch_ratio ?? 1, pitch: plan?.pitch_semitones ?? 0, offset: plan?.offset_s ?? 0, auto };
  return { stretch: item.stretch_ratio, pitch: item.pitch_semitones, offset: item.offset_s, auto };
}

export function LaneRow({
  item,
  vitals,
  plan,
  applied,
  peaks,
  scale,
  snap,
  busy,
  onPatch,
  onRemove,
  onOpen,
}: {
  item: LayerItemRow;
  vitals: LaneFileVitals | null;
  plan: PlanItem | null;
  applied: PlanItem | null;
  peaks: Peaks | null;
  scale: TimelineScale;
  snap: GridSnap;
  busy: boolean;
  onPatch: (patch: LayerItemPatchRequest) => void;
  onRemove: () => void;
  onOpen: () => void;
}) {
  const eff = laneEffective(item, plan);
  const duration = (vitals?.duration_s ?? 0) / (eff.stretch || 1);
  const name = vitals?.name ?? "file";
  const hp = item.filter?.highpass_hz ?? null;
  const lp = item.filter?.lowpass_hz ?? null;

  /** a hand edit on an auto lane materializes the plan so the compute keeps stretch and pitch */
  const withPlan = (patch: LayerItemPatchRequest): LayerItemPatchRequest =>
    eff.auto ? { stretch_ratio: eff.stretch, pitch_semitones: eff.pitch, offset_s: eff.offset, ...patch } : patch;

  const setFilter = (next: { hp?: number | null; lp?: number | null }) => {
    const h = next.hp === undefined ? hp : next.hp;
    const l = next.lp === undefined ? lp : next.lp;
    onPatch({ filter: h === null && l === null ? null : { highpass_hz: h, lowpass_hz: l } });
  };

  const reason = applied?.reason ?? plan?.reason ?? null;

  return (
    <li className={cx("border-b border-rule grid grid-cols-[230px_minmax(0,1fr)]", busy && "opacity-70")}>
      <div className="px-3 py-1.5 border-r border-rule min-w-0 flex flex-col gap-0.5">
        <div className="flex items-baseline gap-2 min-w-0">
          <button type="button" className="text-sm truncate text-left hover:text-pad" onClick={onOpen} title={`Open ${name}`}>
            {name}
          </button>
          <span className="text-xs text-chalk-dim shrink-0">{vitals?.kind.replace("_", " ") ?? ""}</span>
        </div>
        <div className="flex items-baseline gap-3 font-mono text-xs">
          <span className="flex items-center gap-1">
            {vitals?.bpm ? (
              <>
                {fmtBpm(vitals.bpm)}
                <ConfidenceDot confidence={vitals.bpm_confidence} />
              </>
            ) : (
              <span className="text-chalk-faint">— BPM</span>
            )}
          </span>
          <span className="flex items-center gap-1">
            {vitals?.key ? (
              <>
                {displayKey(vitals.key.tonic, vitals.key.mode)}
                <ConfidenceDot confidence={vitals.key_confidence} />
              </>
            ) : (
              <span className="text-chalk-faint">— key</span>
            )}
          </span>
          <span className="text-chalk-dim">{fmtDuration(vitals?.duration_s)}</span>
        </div>
        {reason && (
          <div className="text-2xs text-chalk-dim truncate" title={reason}>
            {applied ? "applied" : eff.auto ? "plan" : "was"}: {reason}
          </div>
        )}
      </div>
      <div className="min-w-0">
        <LaneTimeline
          name={name}
          offsetS={eff.offset}
          durationS={duration}
          scale={scale}
          snap={snap}
          peaks={peaks}
          muted={item.muted}
          disabled={busy}
          onCommit={(offset) => onPatch(withPlan({ offset_s: offset }))}
        />
        <div className="px-2 py-1 border-t border-rule flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="font-mono" title="Offset in bars.beats.16ths at the target tempo, and in seconds">
            <span className={label}>offset </span>
            {formatBarsBeats(eff.offset, scale.bpm, scale.beatsPerBar)} <span className="text-chalk-dim">{formatSignedSeconds(eff.offset)}</span>
          </span>
          <span className="flex items-center gap-1">
            <span className={label}>gain</span>
            <button type="button" className={cx(btnQuiet, "font-mono px-1")} onClick={() => onPatch({ gain_db: Math.max(-60, item.gain_db - 1) })} aria-label="Gain down 1 dB" disabled={busy}>
              −
            </button>
            <NumberField value={item.gain_db} min={-60} max={24} step={0.5} digits={1} ariaLabel={`${name} gain in dB`} widthClass="w-[52px]" onCommit={(v) => onPatch({ gain_db: v ?? 0 })} disabled={busy} />
            <button type="button" className={cx(btnQuiet, "font-mono px-1")} onClick={() => onPatch({ gain_db: Math.min(24, item.gain_db + 1) })} aria-label="Gain up 1 dB" disabled={busy}>
              +
            </button>
            <span className={label}>dB</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className={label}>stretch</span>
            <div className={segment} role="group" aria-label={`${name} stretch mode`}>
              <button type="button" className={cx(segmentItem, "h-6")} data-active={item.stretch_mode === "transient"} onClick={() => onPatch({ stretch_mode: "transient" })} disabled={busy} title="Keeps transients sharp (drums, chops)">
                transient
              </button>
              <button type="button" className={cx(segmentItem, "h-6")} data-active={item.stretch_mode === "smooth"} onClick={() => onPatch({ stretch_mode: "smooth" })} disabled={busy} title="Smoother for pads and sustained material">
                smooth
              </button>
            </div>
            <span className="font-mono" title="Time-stretch ratio: target tempo / this file's tempo">
              ×{eff.stretch.toFixed(4)}
            </span>
            {eff.auto && (
              <span className="text-chalk-dim" title="At the defaults: the compute's plan applies at render time">
                auto
              </span>
            )}
          </span>
          <span className="flex items-center gap-1">
            <span className={label}>pitch</span>
            <NumberField value={eff.pitch} min={-24} max={24} step={1} digits={2} ariaLabel={`${name} pitch in semitones`} widthClass="w-[48px]" onCommit={(v) => onPatch(withPlan({ pitch_semitones: v ?? 0 }))} disabled={busy} />
            <span className={label}>st</span>
          </span>
          <span className="flex items-center gap-1">
            <span className={label} title="High-pass, Hz; blank for none">
              HP
            </span>
            <NumberField value={hp} min={10} max={20000} step={10} digits={0} placeholder="—" allowEmpty ariaLabel={`${name} high-pass in Hz`} widthClass="w-[58px]" onCommit={(v) => setFilter({ hp: v })} disabled={busy} />
            <span className={label} title="Low-pass, Hz; blank for none">
              LP
            </span>
            <NumberField value={lp} min={10} max={20000} step={10} digits={0} placeholder="—" allowEmpty ariaLabel={`${name} low-pass in Hz`} widthClass="w-[58px]" onCommit={(v) => setFilter({ lp: v })} disabled={busy} />
          </span>
          <button type="button" className={cx(btn, "h-6", item.muted && "border-pad text-pad")} aria-pressed={item.muted} onClick={() => onPatch({ muted: !item.muted })} disabled={busy}>
            {item.muted ? "Muted" : "Mute"}
          </button>
          {!eff.auto && (
            <button type="button" className={btnQuiet} onClick={() => onPatch({ stretch_ratio: 1, pitch_semitones: 0, offset_s: 0 })} disabled={busy} title="Back to the defaults: the compute plans this lane again on the next render">
              Reset to auto
            </button>
          )}
          <button type="button" className={cx(btnQuiet, "ml-auto")} onClick={onRemove} aria-label={`Remove ${name} lane`} title="Remove lane" disabled={busy}>
            ×
          </button>
        </div>
      </div>
    </li>
  );
}
