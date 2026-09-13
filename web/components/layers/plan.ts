// The alignment plan the compute applies to lanes still at their defaults
// (analysis/lockedgroove/combine/align.py plan_alignment), ported so the tab
// can show what a render will do before it runs: stretch = target / item BPM,
// pitch = nearest key match (none for non-tonal material), offset so the first
// downbeat lands on the layer's zero. The applied plan in the render job's
// result is the truth; this is the preview.

import type { AlignPlan, LaneFileVitals, PlanItem } from "@/lib/api/layers";
import type { LayerItemRow, LayerRow } from "@/lib/types/db";

const PITCH = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Smallest shift in [-6, 6] taking `from` to `to`; 0 when either is not a pitch class. */
export function semitoneShift(from: string, to: string): number {
  const a = PITCH.indexOf(from);
  const b = PITCH.indexOf(to);
  if (a < 0 || b < 0) return 0;
  const d = (((b - a) % 12) + 12) % 12;
  return d > 6 ? d - 12 : d;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
}

export function predictPlan(layer: Pick<LayerRow, "tempo_bpm" | "key">, items: LayerItemRow[], vitals: Map<string, LaneFileVitals>): AlignPlan {
  const v = items.map((it) => vitals.get(it.file_id) ?? null);
  const first = v[0] ?? null;
  const bpm = layer.tempo_bpm || first?.bpm || v.find((x) => x?.bpm)?.bpm || 120;
  let tonic: string | null = null;
  let mode: "major" | "minor" | null = null;
  if (layer.key) {
    tonic = layer.key.tonic;
    mode = layer.key.mode;
  } else {
    const tonalFirst = v.find((x) => x && x.tonal && x.key);
    if (tonalFirst?.key) {
      tonic = tonalFirst.key.tonic;
      mode = tonalFirst.key.mode;
    }
  }
  const plans: PlanItem[] = items.map((it, i) => {
    const x = v[i];
    const ratio = x?.bpm ? bpm / x.bpm : 1;
    const reasons: string[] = [];
    if (Math.abs(ratio - 1) > 1e-6 && x?.bpm) reasons.push(`stretch ×${ratio.toFixed(4)} from ${fmt(x.bpm)} to ${fmt(bpm)} BPM`);
    let shift = 0;
    if (tonic && x?.tonal && x.key) {
      shift = semitoneShift(x.key.tonic, tonic);
      if (shift) reasons.push(`pitch ${shift > 0 ? "+" : ""}${shift} st from ${x.key.tonic} to ${tonic}`);
    } else if (x && !x.tonal) {
      reasons.push("no pitch shift: non-tonal");
    }
    const firstDownbeat = x?.first_downbeat_s ?? 0;
    const offset = ratio ? -(firstDownbeat / ratio) : -firstDownbeat;
    return { file_id: it.file_id, stretch_ratio: ratio, pitch_semitones: shift, offset_s: offset, reason: reasons.join("; ") || "as is" };
  });
  return { target_bpm: bpm, target_key: tonic ? { tonic, mode: mode ?? "minor" } : null, items: plans };
}
