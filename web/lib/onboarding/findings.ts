// What the first record comes back knowing about itself.
//
// The payoff of the first upload is not a congratulation, it is a short table
// of measurements a producer would otherwise get by ear, by tapping, or not at
// all. Every row carries its confidence, hedges when the band says to, and
// names the correction where there is one to make (principles 2, 4 and 7).
//
// Nothing here computes anything: it reads the effective report and renders
// it. If a section was not measured, its row is absent rather than guessed.

import { fmtBpm, fmtClock, fmtNumber } from "@/lib/format";
import { displayKey } from "@/lib/music/keys";
import { hedged } from "@/lib/report/hedge";
import type { AnalysisReport } from "@/lib/types/report";

export interface Finding {
  id: string;
  /** what it is, plain */
  label: string;
  /** the measurement, for the mono column */
  value: string;
  /** drives the dot; null when the value carries no confidence of its own */
  confidence: number | null;
  /** one honest clause: the alternate it nearly chose, the limit of the method, or the correction */
  note: string | null;
}

function bandwidthNote(hz: number): string {
  if (hz >= 19000) return "full band, so nothing was thrown away before you got here";
  if (hz >= 16500) return "close to full band";
  return "there is nothing above that in the file — a limit of the source, not of the processing";
}

/**
 * The vitals in the order a producer asks for them. Only measured sections
 * appear; an unmeasured one is left out, never shown as a blank or a zero.
 */
export function firstFindings(report: AnalysisReport | null | undefined): Finding[] {
  if (!report) return [];
  const out: Finding[] = [];

  const tempo = report.tempo;
  if (tempo) {
    const [half, double] = tempo.alternates_bpm;
    const alts: string[] = [];
    if (typeof half === "number") alts.push(`${fmtBpm(half)} half-time`);
    if (typeof double === "number") alts.push(`${fmtBpm(double)} double-time`);
    out.push({
      id: "tempo",
      label: "Tempo",
      value: `${fmtBpm(tempo.bpm)} BPM`,
      confidence: tempo.confidence,
      note: alts.length > 0 ? `${alts.join(", ")}; halve, double or tap it if the grid is on the wrong one` : null,
    });
  }

  const key = report.key;
  if (key) {
    const alt = key.alternate;
    out.push({
      id: "key",
      label: "Key",
      value: displayKey(key.tonic, key.mode),
      confidence: key.confidence,
      note: alt ? `or ${displayKey(alt.tonic, alt.mode)}, which correlated ${fmtNumber(alt.correlation, 2)}` : null,
    });
  }

  const beats = report.beats;
  if (beats && beats.downbeats_s.length > 0) {
    const first = beats.downbeats_s[0] as number;
    out.push({
      id: "downbeats",
      label: "Bar 1",
      value: fmtClock(first),
      confidence: beats.downbeat_confidence,
      note: `${beats.meter}, ${beats.downbeats_s.length} bars; put the cursor on the real one and press D if this is off`,
    });
  }

  const structure = report.structure;
  if (structure && structure.sections.length > 0) {
    const period = structure.loop_period_bars;
    out.push({
      id: "structure",
      label: "Sections",
      value: `${structure.sections.length}`,
      confidence: null,
      note: period ? hedged(`it repeats on ${period} bars`, structure.loop_period_confidence) : null,
    });
  }

  const groove = report.groove;
  if (groove) {
    const swing = Math.round(groove.swing_pct);
    out.push({
      id: "groove",
      label: "Feel",
      value: groove.feel === "swung" ? `swung ${swing}%` : groove.feel,
      confidence: groove.confidence,
      note: `hits sit ${fmtNumber(groove.timing_deviation_ms.mean, 1)} ms off the grid on average`,
    });
  }

  const bandwidth = report.spectral?.bandwidth ?? null;
  if (bandwidth && typeof bandwidth.value === "number") {
    out.push({
      id: "bandwidth",
      label: "Bandwidth",
      value: `${fmtNumber(bandwidth.value / 1000, 1)} kHz`,
      confidence: bandwidth.confidence,
      note: bandwidthNote(bandwidth.value),
    });
  }

  const loudness = report.loudness;
  if (loudness) {
    out.push({
      id: "loudness",
      label: "Level",
      value: `${fmtNumber(loudness.integrated_lufs, 1)} LUFS`,
      confidence: null,
      note: `true peak ${fmtNumber(loudness.true_peak_dbtp, 1)} dBTP`,
    });
  }

  return out;
}

/**
 * One sentence over the table, in the voice the chat uses: the two values a
 * producer checks first, hedged by their own confidence. Null when neither
 * was measured, because there is then nothing to say.
 */
export function findingsHeadline(report: AnalysisReport | null | undefined): string | null {
  const tempo = report?.tempo ?? null;
  const key = report?.key ?? null;
  if (!tempo && !key) return null;
  const parts: string[] = [];
  if (tempo) parts.push(hedged(`${fmtBpm(tempo.bpm)} BPM`, tempo.confidence));
  if (key) parts.push(hedged(displayKey(key.tonic, key.mode), key.confidence));
  return parts.join(", ");
}

/** The sections this report has nothing for, named the way the producer would. */
export function unmeasured(report: AnalysisReport | null | undefined): string[] {
  if (!report) return [];
  const out: string[] = [];
  if (!report.tempo) out.push("tempo");
  if (!report.key) out.push("key");
  if (!report.beats) out.push("beats");
  if (!report.structure) out.push("sections");
  if (!report.groove) out.push("groove");
  return out;
}
