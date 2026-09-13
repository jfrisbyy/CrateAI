// Faithful port of `effective()` from analysis/lockedgroove/report.py.
//
// Resolves `user_edits` over analyzed values (principle 7). Every consumer
// reads the effective report, never the raw one. The returned object is a
// deep copy; the stored report keeps the prediction so the correction can be
// logged against it.
//
// Keep this in step with report.py: the Python file is the source of truth
// and analysis/tests/test_report_schema.py holds the cases mirrored in
// effective.test.ts.

import type { AnalysisReport, Beats } from "@/lib/types/report";

const EPS = 1e-6;

/** Python `round()` on the values that matter here (ties never occur for 2/4). */
function nearInteger(x: number): number | null {
  const r = Math.round(x);
  return Math.abs(x - r) < EPS ? r : null;
}

/** `_beats_per_bar` from report.py: "6/8" -> 2 dotted-quarter beats per bar. */
export function beatsPerBar(meter: string | null | undefined): number {
  if (typeof meter !== "string") return 4;
  const parts = meter.split("/");
  if (parts.length !== 2) return 4;
  const num = parseIntStrict(parts[0] ?? "");
  const den = parseIntStrict(parts[1] ?? "");
  if (num === null || den === null) return 4;
  if (den === 8 && num % 3 === 0) return Math.max(1, Math.floor(num / 3));
  return Math.max(1, num);
}

/** Python `int(str)` for the strings we see: optional sign, digits, surrounding whitespace. */
function parseIntStrict(s: string): number | null {
  if (!/^\s*[+-]?\d+\s*$/.test(s)) return null;
  const n = Number.parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** `_shift_downbeats`: the nearest beat to the user's click becomes the anchor. */
function shiftDownbeats(beats: Beats, phase: number, firstDownbeatS: number | null): number[] {
  const times = beats.times_s;
  if (times.length === 0) return [];
  const bpb = beatsPerBar(beats.meter);
  let usePhase = phase;
  if (firstDownbeatS !== null) {
    // Python's min(range(n), key=...) keeps the first index on ties.
    let best = 0;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let i = 0; i < times.length; i++) {
      const d = Math.abs((times[i] as number) - firstDownbeatS);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    usePhase = best % bpb;
  }
  const out: number[] = [];
  for (let i = 0; i < times.length; i++) {
    if (i % bpb === usePhase) out.push(times[i] as number);
  }
  return out;
}

/** `_subdivide`: insert `factor - 1` evenly spaced beats between each pair. */
export function subdivide(times: number[], factor: number): number[] {
  if (times.length < 2) return [...times];
  const out: number[] = [];
  for (let i = 0; i < times.length - 1; i++) {
    const a = times[i] as number;
    const b = times[i + 1] as number;
    const step = (b - a) / factor;
    for (let k = 0; k < factor; k++) out.push(a + k * step);
  }
  out.push(times[times.length - 1] as number);
  return out;
}

export function effective(report: AnalysisReport): AnalysisReport {
  const out: AnalysisReport = structuredClone(report);
  const edits = report.user_edits;

  if (edits.tempo_bpm !== null && edits.tempo_bpm !== undefined && out.tempo !== null) {
    const ratio = out.tempo.bpm ? edits.tempo_bpm / out.tempo.bpm : 1.0;
    out.tempo.bpm = edits.tempo_bpm;
    out.tempo.confidence = 1.0;
    out.tempo.method = "user";
    out.tempo.alternates_bpm = [edits.tempo_bpm / 2, edits.tempo_bpm * 2];
    // A halve/double edit keeps the beat grid consistent with the new tempo.
    if (out.beats !== null && ratio) {
      const up = nearInteger(ratio);
      const down = nearInteger(1 / ratio);
      if (up !== null && (up === 2 || up === 4)) {
        out.beats.times_s = subdivide(out.beats.times_s, up);
      } else if (down !== null && (down === 2 || down === 4)) {
        out.beats.times_s = out.beats.times_s.filter((_, i) => i % down === 0);
      }
    }
  } else if (edits.tempo_bpm !== null && edits.tempo_bpm !== undefined && out.tempo === null) {
    out.tempo = {
      bpm: edits.tempo_bpm,
      confidence: 1.0,
      method: "user",
      alternates_bpm: [edits.tempo_bpm / 2, edits.tempo_bpm * 2],
      notes: null,
    };
  }

  if (out.beats !== null) {
    if (edits.meter !== null && edits.meter !== undefined) {
      out.beats.meter = edits.meter;
    }
    const phaseEdited = edits.downbeat_phase !== null && edits.downbeat_phase !== undefined;
    const firstEdited = edits.first_downbeat_s !== null && edits.first_downbeat_s !== undefined;
    const meterEdited = edits.meter !== null && edits.meter !== undefined;
    if (phaseEdited || firstEdited || meterEdited) {
      const phase = phaseEdited ? (edits.downbeat_phase as number) : out.beats.downbeat_phase;
      out.beats.downbeats_s = shiftDownbeats(out.beats, phase, firstEdited ? (edits.first_downbeat_s as number) : null);
      if (out.beats.downbeats_s.length > 0) {
        // recover the phase actually used (first_downbeat_s may override)
        const first = out.beats.downbeats_s[0] as number;
        const idx = out.beats.times_s.indexOf(first);
        out.beats.downbeat_phase = idx % beatsPerBar(out.beats.meter);
      }
      out.beats.downbeat_confidence = 1.0;
      out.beats.downbeat_method = "user";
    }
  }

  if (edits.key !== null && edits.key !== undefined) {
    if (out.key === null) {
      out.key = {
        tonic: edits.key.tonic,
        mode: edits.key.mode,
        confidence: 1.0,
        method: "user",
        alternate: null,
        notes: null,
      };
    } else {
      out.key.tonic = edits.key.tonic;
      out.key.mode = edits.key.mode;
      out.key.confidence = 1.0;
      out.key.method = "user";
      out.key.alternate = null;
    }
  }

  if (edits.section_labels && Object.keys(edits.section_labels).length > 0 && out.structure !== null) {
    for (const [idxStr, label] of Object.entries(edits.section_labels)) {
      const idx = parseIntStrict(idxStr);
      if (idx === null) continue;
      const section = out.structure.sections[idx];
      if (idx >= 0 && section !== undefined) {
        section.label = label;
        section.confidence = 1.0;
      }
    }
  }

  return out;
}

/** A report with nothing measured; handy for files that have not been analyzed. */
export function emptyReport(partial?: Partial<AnalysisReport>): AnalysisReport {
  return {
    schema_version: "3.0",
    analysis_version: 0,
    file: {
      id: null,
      sha256: null,
      original_filename: null,
      duration_s: 0,
      sample_rate: 0,
      channels: 0,
      format: null,
      kind: "original",
      parent_file_id: null,
    },
    tempo: null,
    beats: null,
    key: null,
    chords: null,
    onsets: null,
    groove: null,
    structure: null,
    drums: null,
    sample_use: null,
    instrumentation: null,
    loudness: null,
    spectral: null,
    effects_estimates: null,
    tags: [],
    user_edits: {
      tempo_bpm: null,
      downbeat_phase: null,
      first_downbeat_s: null,
      key: null,
      meter: null,
      section_labels: null,
      edited_at: null,
    },
    ...partial,
  };
}
