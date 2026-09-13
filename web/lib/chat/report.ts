// The report as the model reads it. Two shapes: `compactReport` for
// get_report (structured, every value with confidence and hedge word, null
// sections named) and `explainReport` for narration (one line per fact, hedge
// attached, producer vocabulary from analysis/lockedgroove/breakdown/words.py).
// Both take the EFFECTIVE report; nothing here invents a value.

import { displayKey } from "@/lib/music/keys";
import { hedged, hedgeWord } from "@/lib/report/hedge";
import type { FileRow } from "@/lib/types/db";
import type { AnalysisReport, DrumHit, DrumPattern, ReportSection } from "@/lib/types/report";
import { REPORT_SECTIONS } from "@/lib/types/report";
import type { Vitals } from "./cards";

export const NOT_ANALYZED = "not analyzed yet";

const BEAT_WORD = ["one", "two", "three", "four"];
const STEP_SUB = ["", "e", "and", "a"];

/** words.py step_name: 0 -> "the one", 10 -> "the and of three". */
export function stepName(step: number, beatsPerBar = 4): string {
  const beat = Math.floor(step / 4) % beatsPerBar;
  const sub = step % 4;
  const beatWord = beat < 4 ? BEAT_WORD[beat] : String(beat + 1);
  return sub === 0 ? `the ${beatWord}` : `the ${STEP_SUB[sub]} of ${beatWord}`;
}

export function stepsPhrase(steps: number[]): string {
  const names = [...steps].sort((a, b) => a - b).map((s) => stepName(s));
  if (names.length === 0) return "nowhere";
  if (names.length === 1) return names[0] as string;
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function bpmText(bpm: number | null | undefined): string {
  if (bpm === null || bpm === undefined || !Number.isFinite(bpm)) return "unknown";
  const r = Math.round(bpm);
  return Math.abs(bpm - r) < 0.05 ? `${r}` : bpm.toFixed(1);
}

function num(n: number | null | undefined, digits = 2): number | null {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

export function fileName(file: Pick<FileRow, "title" | "original_filename">): string {
  return file.title?.trim() || file.original_filename;
}

/** The hits that define a pattern: on at least half the bars. */
function regularSteps(hits: DrumHit[]): number[] {
  return hits.filter((h) => h.frequency >= 0.5).map((h) => h.step);
}

function patternSummary(p: DrumPattern) {
  return {
    section_index: p.section_index,
    kick: stepsPhrase(regularSteps(p.kick)),
    snare: stepsPhrase(regularSteps(p.snare)),
    hat: regularSteps(p.hat).length >= 8 ? `${regularSteps(p.hat).length} of 16 steps` : stepsPhrase(regularSteps(p.hat)),
    hat_open_ratio: num(p.hat_open_ratio),
    ghost_notes: p.ghost_notes.map((s) => stepName(s)),
    accents: p.accents.map((s) => stepName(s)),
    density_per_bar: num(p.density_per_bar, 1),
    hits: {
      kick: p.kick.map((h) => ({ step: h.step, at: stepName(h.step), velocity: num(h.velocity), frequency: num(h.frequency), offset_ms: num(h.offset_ms, 1) })),
      snare: p.snare.map((h) => ({ step: h.step, at: stepName(h.step), velocity: num(h.velocity), frequency: num(h.frequency), offset_ms: num(h.offset_ms, 1) })),
      hat: p.hat.map((h) => ({ step: h.step, velocity: num(h.velocity), frequency: num(h.frequency), offset_ms: num(h.offset_ms, 1) })),
    },
  };
}

export function vitalsOf(file: Pick<FileRow, "status" | "duration_s">, report: AnalysisReport | null): Vitals {
  const tempo = report?.tempo ?? null;
  const key = report?.key ?? null;
  const groove = report?.groove ?? null;
  return {
    bpm: tempo ? num(tempo.bpm, 1) : null,
    bpm_confidence: tempo ? num(tempo.confidence) : null,
    bpm_hedge: hedgeWord(tempo?.confidence ?? null),
    key: key ? displayKey(key.tonic, key.mode) : null,
    key_confidence: key ? num(key.confidence) : null,
    key_hedge: hedgeWord(key?.confidence ?? null),
    meter: report?.beats?.meter ?? null,
    feel: groove ? (groove.feel === "swung" ? `swung ${Math.round(groove.swing_pct)}%` : groove.feel) : null,
    swing_pct: groove ? num(groove.swing_pct, 0) : null,
    duration_s: file.duration_s ?? report?.file.duration_s ?? null,
    status: file.status,
  };
}

export type CompactSection = ReportSection | "tags" | "user_edits";

/** Which sections are null in this report. */
export function notAnalyzed(report: AnalysisReport): ReportSection[] {
  return REPORT_SECTIONS.filter((s) => report[s] === null);
}

export function compactReport(file: FileRow, report: AnalysisReport, sections?: CompactSection[]): Record<string, unknown> {
  const want = (s: CompactSection) => !sections || sections.length === 0 || sections.includes(s);
  const out: Record<string, unknown> = {
    file: { id: file.id, name: fileName(file), kind: file.kind, status: file.status, duration_s: num(file.duration_s ?? report.file.duration_s, 2) },
    vitals: {
      tempo: report.tempo
        ? {
            bpm: num(report.tempo.bpm, 1),
            confidence: num(report.tempo.confidence),
            hedge: hedgeWord(report.tempo.confidence),
            method: report.tempo.method,
            alternates_bpm: report.tempo.alternates_bpm.map((b) => num(b, 1)),
            notes: report.tempo.notes,
          }
        : NOT_ANALYZED,
      key: report.key
        ? {
            key: displayKey(report.key.tonic, report.key.mode),
            tonic: report.key.tonic,
            mode: report.key.mode,
            confidence: num(report.key.confidence),
            hedge: hedgeWord(report.key.confidence),
            method: report.key.method,
            alternate: report.key.alternate ? { key: displayKey(report.key.alternate.tonic, report.key.alternate.mode), correlation: num(report.key.alternate.correlation) } : null,
          }
        : NOT_ANALYZED,
      beats: report.beats
        ? {
            meter: report.beats.meter,
            beat_count: report.beats.times_s.length,
            confidence: num(report.beats.confidence),
            hedge: hedgeWord(report.beats.confidence),
            first_downbeat_s: num(report.beats.downbeats_s[0] ?? null, 3),
            downbeat_count: report.beats.downbeats_s.length,
            downbeat_confidence: num(report.beats.downbeat_confidence),
            downbeat_hedge: hedgeWord(report.beats.downbeat_confidence),
            downbeat_method: report.beats.downbeat_method,
          }
        : NOT_ANALYZED,
      groove: report.groove
        ? {
            feel: report.groove.feel,
            swing_pct: num(report.groove.swing_pct, 0),
            timing_deviation_ms: { mean: num(report.groove.timing_deviation_ms.mean, 1), std: num(report.groove.timing_deviation_ms.std, 1) },
            confidence: num(report.groove.confidence),
            hedge: hedgeWord(report.groove.confidence),
          }
        : NOT_ANALYZED,
    },
    not_analyzed: notAnalyzed(report),
  };

  if (want("structure")) {
    out.structure = report.structure
      ? {
          sections: report.structure.sections.map((s, i) => ({
            index: i,
            label: s.label,
            start_bar: s.start_bar,
            bars: s.bars,
            start_s: num(s.start_s, 2),
            end_s: num(s.end_s, 2),
            energy: num(s.energy),
            confidence: num(s.confidence),
            hedge: hedgeWord(s.confidence),
          })),
          loop_period_bars: report.structure.loop_period_bars,
          loop_period_confidence: num(report.structure.loop_period_confidence),
          loop_period_hedge: hedgeWord(report.structure.loop_period_confidence),
          notes: report.structure.notes,
        }
      : NOT_ANALYZED;
  }
  if (want("drums")) {
    out.drums = report.drums
      ? {
          source_estimate: report.drums.source_estimate,
          source_confidence: num(report.drums.source_confidence),
          hedge: hedgeWord(report.drums.source_confidence),
          layered_kick: report.drums.layered_kick,
          patterns: report.drums.patterns.map(patternSummary),
          method: report.drums.method,
          notes: report.drums.notes,
        }
      : NOT_ANALYZED;
  }
  if (want("sample_use")) {
    const s = report.sample_use;
    out.sample_use = s
      ? {
          is_loop_based: s.is_loop_based,
          chop_count_estimate: s.chop_count_estimate,
          chop_reordering_detected: s.chop_reordering_detected,
          chop_order: s.chop_order,
          pitch_shift_semitones_estimate: s.pitch_shift_semitones_estimate,
          pitch_shift_source_file_id: s.pitch_shift_source_file_id,
          sample_bars: s.sample_bars.slice(0, 64),
          confidence: num(s.confidence),
          hedge: hedgeWord(s.confidence),
          notes: s.notes,
        }
      : NOT_ANALYZED;
  }
  if (want("chords")) {
    out.chords = report.chords
      ? {
          segments: report.chords.segments.slice(0, 96).map((c) => ({ start_s: num(c.start_s, 2), end_s: num(c.end_s, 2), label: c.label, confidence: num(c.confidence), hedge: hedgeWord(c.confidence) })),
          segment_count: report.chords.segments.length,
          method: report.chords.method,
        }
      : NOT_ANALYZED;
  }
  if (want("instrumentation")) {
    out.instrumentation = report.instrumentation
      ? {
          per_section: report.instrumentation.per_section.map((s) => ({
            section_index: s.section_index,
            present: s.present,
            entries: s.entries.map((e) => `${e.instrument} enters at bar ${e.bar + 1}`),
            exits: s.exits.map((e) => `${e.instrument} leaves at bar ${e.bar + 1}`),
          })),
          confidence: num(report.instrumentation.confidence),
          hedge: hedgeWord(report.instrumentation.confidence),
        }
      : NOT_ANALYZED;
  }
  if (want("loudness")) {
    out.loudness = report.loudness
      ? { integrated_lufs: num(report.loudness.integrated_lufs, 1), true_peak_dbtp: num(report.loudness.true_peak_dbtp, 1), loudness_range_lu: num(report.loudness.loudness_range_lu, 1), method: report.loudness.method }
      : NOT_ANALYZED;
  }
  if (want("spectral")) {
    out.spectral = report.spectral
      ? { centroid_hz_mean: num(report.spectral.centroid_hz_mean, 0), stereo_width: num(report.spectral.stereo_width), low_high_ratio_db: num(report.spectral.low_high_ratio_db, 1) }
      : NOT_ANALYZED;
  }
  if (want("effects_estimates")) {
    const e = report.effects_estimates;
    out.effects_estimates = e
      ? {
          reverb_tail_s: { value: num(e.reverb_tail_s.value, 2), confidence: num(e.reverb_tail_s.confidence), hedge: hedgeWord(e.reverb_tail_s.confidence), notes: e.reverb_tail_s.notes },
          sidechain_ducking: { detected: e.sidechain_ducking.detected, depth_db: num(e.sidechain_ducking.depth_db, 1), confidence: num(e.sidechain_ducking.confidence), hedge: hedgeWord(e.sidechain_ducking.confidence) },
          saturation_above_hz: { value: num(e.saturation_above_hz.value, 0), confidence: num(e.saturation_above_hz.confidence), hedge: hedgeWord(e.saturation_above_hz.confidence) },
        }
      : NOT_ANALYZED;
  }
  if (want("onsets")) out.onsets = report.onsets ? { count: report.onsets.count, method: report.onsets.method } : NOT_ANALYZED;
  if (want("tags")) out.tags = report.tags.map((t) => ({ tag: t.tag, confidence: num(t.confidence), source: t.source }));
  if (want("user_edits")) out.user_edits = report.user_edits;
  return out;
}

function line(label: string, value: string): string {
  return `${label}: ${value}`;
}

/** One line per fact, hedge word attached, for narration. */
export function explainReport(file: FileRow, report: AnalysisReport): string {
  const lines: string[] = [];
  lines.push(line("File", `${fileName(file)} (${file.kind}${file.duration_s ? `, ${file.duration_s.toFixed(1)} s` : ""})`));

  if (report.tempo) {
    const t = report.tempo;
    lines.push(line("Tempo", `${hedged(`${bpmText(t.bpm)} BPM`, t.confidence)} (confidence ${t.confidence.toFixed(2)}; alternates ${t.alternates_bpm.map(bpmText).join(" / ")}${t.method === "user" ? "; set by you" : ""})`));
  } else lines.push(line("Tempo", NOT_ANALYZED));

  if (report.key) {
    const k = report.key;
    const alt = k.alternate ? `; alternate ${displayKey(k.alternate.tonic, k.alternate.mode)}` : "";
    lines.push(line("Key", `${hedged(displayKey(k.tonic, k.mode), k.confidence)} (confidence ${k.confidence.toFixed(2)}${alt}${k.method === "user" ? "; set by you" : ""})`));
  } else lines.push(line("Key", NOT_ANALYZED));

  if (report.beats) {
    const b = report.beats;
    const first = b.downbeats_s[0];
    lines.push(
      line(
        "Grid",
        `${b.meter}, ${b.times_s.length} beats (confidence ${b.confidence.toFixed(2)}); first downbeat ${first !== undefined ? hedged(`at ${first.toFixed(3)} s`, b.downbeat_confidence) : "not found"} (downbeat confidence ${b.downbeat_confidence.toFixed(2)})`,
      ),
    );
  } else lines.push(line("Grid", NOT_ANALYZED));

  if (report.groove) {
    const g = report.groove;
    const feel = g.feel === "swung" ? `swung ${Math.round(g.swing_pct)} percent` : g.feel === "loose" ? `loose, ${g.timing_deviation_ms.std.toFixed(0)} ms of timing deviation` : "straight";
    lines.push(line("Feel", `${hedged(feel, g.confidence)} (confidence ${g.confidence.toFixed(2)})`));
  } else lines.push(line("Feel", NOT_ANALYZED));

  if (report.structure) {
    const s = report.structure;
    const parts = s.sections.map((sec) => `${hedged(sec.label, sec.confidence)} ${sec.bars} bars from bar ${sec.start_bar + 1}`);
    const period = s.loop_period_bars !== null ? hedged(`a ${s.loop_period_bars}-bar loop`, s.loop_period_confidence) : "no loop period found";
    lines.push(line("Structure", `${s.sections.length} sections: ${parts.join("; ")}. Sits on ${period} (confidence ${s.loop_period_confidence.toFixed(2)})`));
  } else lines.push(line("Structure", NOT_ANALYZED));

  if (report.drums) {
    const d = report.drums;
    const source = d.source_estimate === "sampled_break" ? "a sampled break" : d.source_estimate === "programmed" ? "programmed" : d.source_estimate === "mixed" ? "mixed, sampled and programmed" : "of unknown source";
    const patterns = d.patterns.slice(0, 4).map((p) => {
      const kick = regularSteps(p.kick);
      const snare = regularSteps(p.snare);
      const hats = regularSteps(p.hat);
      const ghosts = p.ghost_notes.length > 0 ? `, ghost notes on ${stepsPhrase(p.ghost_notes)}` : "";
      return `section ${p.section_index + 1}: kick on ${stepsPhrase(kick)}, snare on ${stepsPhrase(snare)}, hats on ${hats.length >= 16 ? "16ths" : hats.length >= 8 ? "8ths" : stepsPhrase(hats)}${ghosts}`;
    });
    lines.push(line("Drums", `${hedged(source, d.source_confidence)} (confidence ${d.source_confidence.toFixed(2)})${d.layered_kick ? "; two kick spectra, so the kick is layered" : ""}. ${patterns.join(". ")}`));
  } else lines.push(line("Drums", NOT_ANALYZED));

  if (report.sample_use) {
    const s = report.sample_use;
    const bits: string[] = [];
    bits.push(s.is_loop_based === null ? "loop use unknown" : s.is_loop_based ? "loop-based" : "not loop-based");
    if (s.chop_count_estimate !== null) bits.push(`${s.chop_count_estimate} chops${s.chop_reordering_detected ? ", reordered" : ""}`);
    if (s.pitch_shift_semitones_estimate !== null) bits.push(`pitched ${s.pitch_shift_semitones_estimate > 0 ? "up" : "down"} ${Math.abs(s.pitch_shift_semitones_estimate)} semitones`);
    lines.push(line("Sample", `${hedged(bits.join(", "), s.confidence)} (confidence ${s.confidence.toFixed(2)})`));
  } else lines.push(line("Sample", NOT_ANALYZED));

  if (report.chords) {
    const c = report.chords;
    const labels = c.segments.slice(0, 16).map((seg) => hedged(seg.label, seg.confidence));
    lines.push(line("Chords", labels.length > 0 ? `${labels.join(" | ")}${c.segments.length > 16 ? ` (and ${c.segments.length - 16} more)` : ""}` : "no chord segments found"));
  } else lines.push(line("Chords", NOT_ANALYZED));

  if (report.instrumentation) {
    const i = report.instrumentation;
    const events = i.per_section.flatMap((s) => [...s.entries.map((e) => `${e.instrument} enters at bar ${e.bar + 1}`), ...s.exits.map((e) => `${e.instrument} leaves at bar ${e.bar + 1}`)]);
    lines.push(line("Arrangement", `${hedged(events.length > 0 ? events.join("; ") : "no entries or exits detected", i.confidence)} (confidence ${i.confidence.toFixed(2)})`));
  } else lines.push(line("Arrangement", NOT_ANALYZED));

  if (report.loudness) {
    const l = report.loudness;
    lines.push(line("Loudness", `${l.integrated_lufs.toFixed(1)} LUFS integrated, true peak ${l.true_peak_dbtp.toFixed(1)} dBTP, range ${l.loudness_range_lu.toFixed(1)} LU`));
  } else lines.push(line("Loudness", NOT_ANALYZED));

  if (report.spectral) {
    const s = report.spectral;
    lines.push(line("Spectrum", `centroid ${s.centroid_hz_mean.toFixed(0)} Hz, stereo width ${s.stereo_width.toFixed(2)}, low/high ${s.low_high_ratio_db >= 0 ? "+" : ""}${s.low_high_ratio_db.toFixed(1)} dB`));
  } else lines.push(line("Spectrum", NOT_ANALYZED));

  if (report.effects_estimates) {
    const e = report.effects_estimates;
    const reverb = e.reverb_tail_s.value !== null ? hedged(`reverb tail ${e.reverb_tail_s.value.toFixed(1)} s`, e.reverb_tail_s.confidence) : "reverb tail not measured";
    const side = e.sidechain_ducking.detected
      ? hedged(`sidechain ducking${e.sidechain_ducking.depth_db !== null ? ` ${Math.abs(e.sidechain_ducking.depth_db).toFixed(1)} dB deep` : ""}`, e.sidechain_ducking.confidence)
      : hedged("no sidechain ducking", e.sidechain_ducking.confidence);
    const sat = e.saturation_above_hz.value !== null ? hedged(`saturation above ${e.saturation_above_hz.value.toFixed(0)} Hz`, e.saturation_above_hz.confidence) : "saturation not measured";
    lines.push(line("Effects", `${reverb} (confidence ${e.reverb_tail_s.confidence.toFixed(2)}); ${side} (confidence ${e.sidechain_ducking.confidence.toFixed(2)}); ${sat} (confidence ${e.saturation_above_hz.confidence.toFixed(2)})`));
  } else lines.push(line("Effects", NOT_ANALYZED));

  if (report.tags.length > 0) lines.push(line("Tags", report.tags.map((t) => `${t.tag} (${t.confidence.toFixed(2)})`).join(", ")));
  const edits = report.user_edits;
  const edited = [
    edits.tempo_bpm !== null ? `tempo ${bpmText(edits.tempo_bpm)}` : null,
    edits.key ? `key ${displayKey(edits.key.tonic, edits.key.mode)}` : null,
    edits.meter ? `meter ${edits.meter}` : null,
    edits.first_downbeat_s !== null ? `first downbeat ${edits.first_downbeat_s.toFixed(3)} s` : null,
    edits.downbeat_phase !== null ? `downbeat phase ${edits.downbeat_phase}` : null,
  ].filter((x): x is string => x !== null);
  if (edited.length > 0) lines.push(line("Set by you", edited.join(", ")));
  const missing = notAnalyzed(report);
  if (missing.length > 0) lines.push(line("Not analyzed yet", `${missing.join(", ")} (say the word and I'll queue them)`));
  return lines.join("\n");
}

/** One line per attached file for the system context. */
export function fileContextLine(file: FileRow, report: AnalysisReport | null, isOpen: boolean): string {
  const v = vitalsOf(file, report);
  const bpm = v.bpm !== null ? `${hedged(`${bpmText(v.bpm)} BPM`, v.bpm_confidence)} (${v.bpm_confidence?.toFixed(2)})` : "tempo not analyzed";
  const key = v.key !== null ? `${hedged(v.key, v.key_confidence)} (${v.key_confidence?.toFixed(2)})` : "key not analyzed";
  return `- ${isOpen ? "[open] " : ""}${fileName(file)} | id ${file.id} | ${file.kind} | ${file.status}${v.duration_s ? ` | ${v.duration_s.toFixed(1)} s` : ""} | ${bpm} | ${key}${v.feel ? ` | ${v.feel}` : ""}`;
}
