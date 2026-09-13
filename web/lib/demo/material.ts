// The prototype's crate: the records, their analysis, and the racks built from
// them.
//
// Everything here is *data*. The machinery is the product's own: the rows are
// real `FileRow`/`StemRow`/`LoopRow` shapes, the measurements are computed by
// `lib/compat` (the same code that answers /api/compat), the rack rows are
// built by `lib/session/rack`'s real builders, and the peaks drawn on a row
// are measured from the samples that actually play. Nothing below re-words a
// reason, invents a confidence or hard-codes a ranking.
//
// What is faked, and only this: the audio is synthesised (lib/demo/synth.ts),
// and the analysis values — tempo, key, confidences, tags, timbre similarity —
// are written by hand to describe that synthesised audio. They are what the
// analysis would have measured, not what it did measure, and the page says so.

import { buildMatches, type CompatMatch } from "@/lib/compat/matches";
import { METHOD, type Mode, type TrackVitals } from "@/lib/compat/theory";
import { emptyReport } from "@/lib/report/effective";
import {
  candidateFromLoop,
  rackFromCompat,
  rackFromLoops,
  vitalsOf,
  type Rack,
  type RackCandidate,
} from "@/lib/session/rack";
import type { FileRow, LoopRow, Peaks, StemRow } from "@/lib/types/db";
import type { AnalysisReport, Tag } from "@/lib/types/report";
import {
  barSeconds,
  KIT_DUSTY,
  KIT_HEAVY,
  KIT_LIVE,
  KIT_MACHINE,
  KIT_ROOM,
  peaksFrom,
  renderBed,
  renderBreak,
  type BedSpec,
  type BreakSpec,
  type Pcm,
} from "./synth";

export const DEMO_USER_ID = "00000000-0000-4000-8000-000000000001";
/** Rows have to carry a timestamp; a fixed one keeps the server and client renders identical. */
const AT = "2026-09-13T09:00:00.000Z";

/** The session's grid, and the record it comes from. Bar 1 is second zero. */
export const DEMO_BPM = 92;
export const DEMO_BARS = 4;

/** Ids are stable so a link, a lane and a region all mean the same record. */
export const BED_ID = "demo-moonlight-highlife";
export const BED_PARENT_ID = "demo-moonlight-highlife-record";

// --- the records -------------------------------------------------------------

interface Analysis {
  bpm: number | null;
  bpmConfidence: number | null;
  tonic: string | null;
  mode: Mode | null;
  keyConfidence: number | null;
  tags: Array<[string, number]>;
  /** how confident the beat tracker was; a grid can exist without a tempo */
  beatConfidence: number;
  downbeatConfidence: number;
  tempoMethod: string;
  tempoNote: string | null;
}

interface Record_ {
  id: string;
  parentId: string;
  title: string;
  artist: string;
  /** the filename a producer would recognise; drives `isTonal` for a drums stem */
  filename: string;
  /** the stem row this file is, when it is one */
  stem: { name: string; model: string } | null;
  analysis: Analysis;
  /** silence before the downbeat, seconds */
  leadInS: number;
  bars: number;
  /** the tempo the audio was actually rendered at, which may be more than was measured */
  renderBpm: number;
  render: (sampleRate: number) => Pcm;
  /** cosine similarity of this record's embedding to the bed's; only breaks ties */
  timbre: number | null;
}

function breakSpec(over: Partial<BreakSpec> & Pick<BreakSpec, "bpm" | "bars" | "leadInS" | "kit" | "kick" | "snare" | "hat">): BreakSpec {
  return over;
}

const MASQUERADE = breakSpec({
  bpm: 88.5,
  bars: 4,
  leadInS: 0.22,
  kit: KIT_DUSTY,
  swing: 0.17,
  peak: 0.50,
  kick: ["X..x..x...X.....", "X..x..x...X.....", "X..x..x...X.....", "X..x..x...X..x.x"],
  snare: ["....X...g...X..g", "....X...g...X..g", "....X...g...X..g", "....X..g....X.gX"],
  hat: ["x.x.x.x.x.x.x.x.", "x.x.x.x.x.x.x.xo", "x.x.x.x.x.x.x.x.", "x.x.x.x.xox.x.xo"],
});

const IN_THE_SHADE = breakSpec({
  bpm: 95.5,
  bars: 4,
  leadInS: 0.38,
  kit: KIT_ROOM,
  swing: 0.08,
  peak: 0.48,
  kick: ["X.....x..X......", "X.....x..X....x.", "X.....x..X......", "X..x..x..X..x..."],
  snare: ["....X.g.....X...", "....X.g.....X..g", "....X.g.....X...", "....X.g...g.X.gX"],
  hat: ["x.x.xoxxx.x.xox.", "x.x.xoxxx.x.xox.", "x.x.xoxxx.x.xox.", "x.x.xoxxx.xxxoxx"],
});

const COLD_ROOM = breakSpec({
  bpm: 174,
  bars: 8,
  leadInS: 0.14,
  kit: KIT_HEAVY,
  peak: 0.52,
  // Eight fast bars that read as four slow ones: the kick bar, then the snare bar.
  kick: ["X.....x.........", "..........x....."],
  snare: ["........g.......", "X.............g."],
  hat: ["x...x...x...x...", "x...x...x...x..o"],
});

const TWO_ROOMS = breakSpec({
  bpm: 103.5,
  bars: 4,
  leadInS: 0.45,
  kit: KIT_MACHINE,
  peak: 0.46,
  kick: ["X...X...X...X..."],
  snare: ["....X.......X..."],
  hat: ["..x...x...x...x."],
  rim: ["..............x."],
});

const BASEMENT_TAPE = breakSpec({
  bpm: 96,
  bars: 4,
  leadInS: 0.52,
  kit: KIT_LIVE,
  swing: 0.12,
  peak: 0.48,
  kick: ["X.....x...X.....", "X.....x...X...x.", "X.....x...X.....", "X..x..x...X..x.."],
  snare: ["....X..g....X..g", "....X..g....X..g", "....X..g....X..g", "....X.g.....X.gX"],
  hat: ["x.x.x.x.x.x.x.x.", "x.x.x.x.x.x.x.x.", "x.x.x.x.x.x.x.x.", "x.x.x.x.x.x.x.xo"],
});

/**
 * The bed: four bars of a Rhodes figure in F minor with a bassline under it.
 * This is the record the producer is already working on, and the thing the
 * rack is asked to fit under.
 */
const BED: BedSpec = {
  bpm: DEMO_BPM,
  bars: DEMO_BARS,
  leadInS: 0.31,
  peak: 0.34,
  keys: [
    // Fm9 for two bars, Dbmaj7, then Eb
    ...chord(0, 0, [53, 56, 60, 63, 67], 12),
    ...chord(0, 10, [53, 56, 60, 63, 67], 6),
    ...chord(1, 0, [53, 56, 60, 63, 67], 12),
    ...chord(1, 10, [51, 56, 60, 63, 67], 6),
    ...chord(2, 0, [49, 53, 56, 60, 63], 14),
    ...chord(3, 0, [51, 55, 58, 62, 65], 8),
    ...chord(3, 8, [51, 55, 58, 62, 65], 6),
  ],
  bass: [
    { bar: 0, step: 0, midi: 41, steps: 6 },
    { bar: 0, step: 10, midi: 41, steps: 3 },
    { bar: 0, step: 14, midi: 44, steps: 2 },
    { bar: 1, step: 0, midi: 41, steps: 6 },
    { bar: 1, step: 10, midi: 41, steps: 3 },
    { bar: 1, step: 14, midi: 48, steps: 2 },
    { bar: 2, step: 0, midi: 37, steps: 6 },
    { bar: 2, step: 10, midi: 37, steps: 4 },
    { bar: 3, step: 0, midi: 39, steps: 6 },
    { bar: 3, step: 8, midi: 39, steps: 4 },
    { bar: 3, step: 14, midi: 36, steps: 2 },
  ],
};

function chord(bar: number, step: number, midis: number[], steps: number) {
  return midis.map((midi, i) => ({ bar, step, midi, steps, gain: i === 0 ? 0.9 : 0.72 }));
}

const RECORDS: Record_[] = [
  {
    id: BED_ID,
    parentId: BED_PARENT_ID,
    title: "Moonlight Highlife",
    artist: "Kwame Adjei",
    filename: "moonlight-highlife.wav",
    stem: null,
    leadInS: BED.leadInS,
    bars: BED.bars,
    renderBpm: BED.bpm,
    analysis: {
      bpm: DEMO_BPM,
      bpmConfidence: 0.91,
      tonic: "F",
      mode: "minor",
      keyConfidence: 0.74,
      tags: [["rhodes", 0.81], ["soul", 0.72], ["loop-based", 0.64]],
      beatConfidence: 0.89,
      downbeatConfidence: 0.81,
      tempoMethod: "tempogram over the onset envelope",
      tempoNote: null,
    },
    render: (sr) => renderBed(BED, sr),
    timbre: null,
  },
  {
    id: "demo-masquerade-drums",
    parentId: "demo-masquerade",
    title: "Masquerade — drums",
    artist: "The Ardent Few",
    filename: "masquerade-drums.wav",
    stem: { name: "drums", model: "htdemucs_ft" },
    leadInS: MASQUERADE.leadInS,
    bars: MASQUERADE.bars,
    renderBpm: MASQUERADE.bpm,
    analysis: {
      bpm: 88.5,
      bpmConfidence: 0.88,
      tonic: "A",
      mode: "minor",
      keyConfidence: 0.31,
      tags: [["drums", 0.96], ["break", 0.88], ["dusty", 0.7]],
      beatConfidence: 0.86,
      downbeatConfidence: 0.78,
      tempoMethod: "tempogram over the onset envelope",
      tempoNote: null,
    },
    render: (sr) => renderBreak(MASQUERADE, sr),
    timbre: 0.71,
  },
  {
    id: "demo-in-the-shade-drums",
    parentId: "demo-in-the-shade",
    title: "In The Shade — drums",
    artist: "Rosewood Trio",
    filename: "in-the-shade-drums.wav",
    stem: { name: "drums", model: "htdemucs_ft" },
    leadInS: IN_THE_SHADE.leadInS,
    bars: IN_THE_SHADE.bars,
    renderBpm: IN_THE_SHADE.bpm,
    analysis: {
      bpm: 95.5,
      bpmConfidence: 0.83,
      tonic: "C",
      mode: "major",
      keyConfidence: 0.28,
      tags: [["drums", 0.95], ["break", 0.81], ["live", 0.66]],
      beatConfidence: 0.82,
      downbeatConfidence: 0.7,
      tempoMethod: "tempogram over the onset envelope",
      tempoNote: null,
    },
    render: (sr) => renderBreak(IN_THE_SHADE, sr),
    timbre: 0.64,
  },
  {
    id: "demo-cold-room-drums",
    parentId: "demo-cold-room",
    title: "Cold Room — drums",
    artist: "Nine Ounce",
    filename: "cold-room-drums.wav",
    stem: { name: "drums", model: "bs_roformer" },
    leadInS: COLD_ROOM.leadInS,
    bars: COLD_ROOM.bars,
    renderBpm: COLD_ROOM.bpm,
    analysis: {
      bpm: 174,
      bpmConfidence: 0.79,
      tonic: "F",
      mode: "minor",
      keyConfidence: 0.33,
      tags: [["drums", 0.97], ["break", 0.9], ["heavy", 0.74]],
      beatConfidence: 0.88,
      downbeatConfidence: 0.62,
      tempoMethod: "tempogram over the onset envelope",
      tempoNote: "half-time is the alternate; the tempogram peaks at 174 and 87",
    },
    render: (sr) => renderBreak(COLD_ROOM, sr),
    timbre: 0.58,
  },
  {
    id: "demo-two-rooms-drums",
    parentId: "demo-two-rooms",
    title: "Two Rooms — drums",
    artist: "Halfmoon Club",
    filename: "two-rooms-drums.wav",
    stem: { name: "drums", model: "htdemucs_ft" },
    leadInS: TWO_ROOMS.leadInS,
    bars: TWO_ROOMS.bars,
    renderBpm: TWO_ROOMS.bpm,
    analysis: {
      bpm: 103.5,
      bpmConfidence: 0.94,
      tonic: "G",
      mode: "minor",
      keyConfidence: 0.35,
      tags: [["drums", 0.98], ["programmed", 0.86]],
      beatConfidence: 0.95,
      downbeatConfidence: 0.91,
      tempoMethod: "tempogram over the onset envelope",
      tempoNote: null,
    },
    render: (sr) => renderBreak(TWO_ROOMS, sr),
    timbre: 0.41,
  },
  {
    id: "demo-basement-tape-drums",
    parentId: "demo-basement-tape",
    title: "Basement Tape — drums",
    artist: "Unknown",
    filename: "basement-tape-drums.wav",
    stem: { name: "drums", model: "htdemucs_ft" },
    leadInS: BASEMENT_TAPE.leadInS,
    bars: BASEMENT_TAPE.bars,
    renderBpm: BASEMENT_TAPE.bpm,
    analysis: {
      // The point of this row: nothing measured a tempo, so nothing may claim
      // one. It plays at its own speed and the producer hears it drift.
      bpm: null,
      bpmConfidence: null,
      tonic: null,
      mode: null,
      keyConfidence: null,
      tags: [["drums", 0.93], ["break", 0.72], ["live", 0.8]],
      beatConfidence: 0.41,
      downbeatConfidence: 0.38,
      tempoMethod: "tempogram over the onset envelope",
      tempoNote: "the tempogram had no clear peak; the take drifts",
    },
    render: (sr) => renderBreak(BASEMENT_TAPE, sr),
    timbre: 0.55,
  },
];

// --- turning a record into a library row -------------------------------------

function tagsOf(pairs: Array<[string, number]>): Tag[] {
  return pairs.map(([tag, confidence]) => ({ tag, confidence, source: "model" as const }));
}

function reportFor(record: Record_, durationS: number, sampleRate: number, channels: number): AnalysisReport {
  const a = record.analysis;
  const beatS = 60 / record.renderBpm;
  // Not rounded: `downbeats_s[0]` is where a play starts and `duration_s` is
  // where a tiling ends, so a fourth-decimal rounding here would put every
  // repeat of a break a hair off the bar.
  const beats = Array.from({ length: record.bars * 4 + 1 }, (_, i) => record.leadInS + i * beatS);
  const downbeats = Array.from({ length: record.bars }, (_, b) => record.leadInS + b * barSeconds(record.renderBpm));
  return emptyReport({
    analysis_version: 1,
    file: {
      id: record.id,
      sha256: null,
      original_filename: record.filename,
      duration_s: durationS,
      sample_rate: sampleRate,
      channels,
      format: "wav",
      kind: record.stem ? "stem" : "original",
      parent_file_id: record.stem ? record.parentId : null,
    },
    tempo:
      a.bpm === null
        ? null
        : {
            bpm: a.bpm,
            confidence: a.bpmConfidence ?? 0,
            method: a.tempoMethod,
            alternates_bpm: [a.bpm / 2, a.bpm * 2],
            notes: a.tempoNote,
          },
    key:
      a.tonic === null || a.mode === null
        ? null
        : { tonic: a.tonic, mode: a.mode, confidence: a.keyConfidence ?? 0, method: "harmonic chroma against 24 profiles", alternate: null, notes: null },
    beats: {
      times_s: beats,
      confidence: a.beatConfidence,
      method: "beat tracker over the onset envelope",
      downbeats_s: downbeats,
      downbeat_phase: 0,
      downbeat_confidence: a.downbeatConfidence,
      downbeat_method: "low-band energy on the beat grid",
      meter: "4/4",
      notes: a.tempoNote,
    },
    tags: tagsOf(a.tags),
  });
}

function fileRowFor(record: Record_, pcm: Pcm, peaks: Peaks): FileRow {
  return {
    id: record.id,
    user_id: DEMO_USER_ID,
    sha256: record.id.padEnd(64, "0").slice(0, 64),
    original_filename: record.filename,
    storage_path: `demo/${record.id}.wav`,
    size_bytes: Math.round(pcm.durationS * pcm.sampleRate * pcm.channels.length * 2),
    duration_s: pcm.durationS,
    sample_rate: pcm.sampleRate,
    channels: pcm.channels.length,
    format: "wav",
    kind: record.stem ? "stem" : "original",
    parent_file_id: record.stem ? record.parentId : null,
    status: "ready",
    analysis_version: 1,
    report: reportFor(record, pcm.durationS, pcm.sampleRate, pcm.channels.length),
    peaks,
    title: record.title,
    artist: record.artist,
    created_at: AT,
    updated_at: AT,
  };
}

// --- the crate ---------------------------------------------------------------

export interface DemoLibrary {
  /** every row the demo's library holds, newest first, the way LibraryProvider wants them */
  files: FileRow[];
  stems: StemRow[];
  /** the loops the finder found inside Masquerade */
  loops: LoopRow[];
  /** decoded-audio-shaped PCM, by file id; the decode cache's loader reads this */
  pcm: Map<string, Pcm>;
  bed: FileRow;
  /** four bars of the bed, placed by hand: what goes into the song first */
  bedLoop: LoopRow;
}

/** One record, rendered: what the crate needs plus the samples themselves. */
export interface RenderedRecord {
  file: FileRow;
  stem: StemRow | null;
  pcm: Pcm;
}

/** How many records the demo's crate holds; the loader renders them one at a time. */
export const DEMO_RECORD_COUNT = RECORDS.length;

/**
 * Render one record and measure its peaks.
 *
 * Rendering is what buys the stored peaks: a rack row draws from `files.peaks`
 * and decodes nothing, exactly as it does with real uploads, and here those
 * peaks are measured from the very samples the transport will play. It is done
 * one record at a time because the whole crate is a few hundred milliseconds of
 * arithmetic and a page that freezes for it is a bad first impression.
 */
export function renderDemoRecord(index: number, sampleRate: number): RenderedRecord {
  const record = RECORDS[index];
  if (!record) throw new Error(`no demo record ${index}`);
  const pcm = record.render(sampleRate);
  return {
    file: fileRowFor(record, pcm, peaksFrom(pcm.channels)),
    stem: record.stem
      ? {
          id: `stem-${record.id}`,
          user_id: DEMO_USER_ID,
          file_id: record.parentId,
          stem: record.stem.name,
          model: record.stem.model,
          stem_file_id: record.id,
          created_at: AT,
        }
      : null,
    pcm,
  };
}

/** The crate, once every record is rendered. */
export function assembleDemoLibrary(rendered: readonly RenderedRecord[]): DemoLibrary {
  const files = rendered.map((r) => r.file);
  const stems = rendered.map((r) => r.stem).filter((s): s is StemRow => s !== null);
  const pcm = new Map(rendered.map((r) => [r.file.id, r.pcm]));
  const bed = files.find((f) => f.id === BED_ID);
  if (!bed) throw new Error("the demo crate has no bed");
  const barS = barSeconds(DEMO_BPM);
  const bedLoop: LoopRow = {
    id: "demo-bed-loop",
    user_id: DEMO_USER_ID,
    file_id: BED_ID,
    start_s: BED.leadInS,
    end_s: BED.leadInS + DEMO_BARS * barS,
    bars: DEMO_BARS,
    score: null,
    origin: "user",
    components: null,
    name: "Moonlight Highlife, bars 1–4",
    render_file_id: null,
    created_at: AT,
  };
  return { files, stems, loops: masqueradeLoops(), pcm, bed, bedLoop };
}

/** Every record at once. What the tests use; the page renders them one by one. */
export function buildDemoLibrary(sampleRate: number): DemoLibrary {
  return assembleDemoLibrary(RECORDS.map((_, i) => renderDemoRecord(i, sampleRate)));
}

/** Three loops the finder ranked inside Masquerade: the second rack in the demo. */
function masqueradeLoops(): LoopRow[] {
  const barS = barSeconds(MASQUERADE.bpm);
  const at = (bar: number) => MASQUERADE.leadInS + bar * barS;
  const row = (id: string, fromBar: number, bars: number, score: number, components: Record<string, number>, name: string): LoopRow => ({
    id,
    user_id: DEMO_USER_ID,
    file_id: "demo-masquerade-drums",
    start_s: at(fromBar),
    end_s: at(fromBar + bars),
    bars,
    score,
    origin: "finder",
    components,
    name,
    render_file_id: null,
    created_at: AT,
  });
  return [
    row("demo-loop-masq-1", 0, 2, 0.86, { grid: 0.94, self_similarity: 0.81, onset_agreement: 0.83 }, "Masquerade, bars 1–2"),
    row("demo-loop-masq-2", 2, 2, 0.72, { grid: 0.9, self_similarity: 0.64, onset_agreement: 0.7 }, "Masquerade, bars 3–4"),
    row("demo-loop-masq-3", 0, 4, 0.79, { grid: 0.93, self_similarity: 0.74, onset_agreement: 0.77 }, "Masquerade, bars 1–4"),
  ];
}

// --- the racks ---------------------------------------------------------------

/** The bed's effective vitals: what every candidate is fitted to. */
export function bedVitals(library: DemoLibrary): TrackVitals {
  return vitalsOf(library.bed);
}

/**
 * "Find me drums that fit this."
 *
 * The matches are computed by `buildMatches` — the same pure function the
 * /api/compat route calls — so the reason on every row, its confidence, its
 * fit ratio and the order they arrive in are all the product's own arithmetic
 * over the analysis values above. The rack is then built by `rackFromCompat`,
 * unchanged.
 */
export function demoCompatRack(library: DemoLibrary): Rack {
  const candidates = library.files.filter((f) => f.id !== BED_ID);
  const timbre = new Map<string, number>();
  for (const record of RECORDS) if (record.timbre !== null) timbre.set(record.id, record.timbre);
  const matches: CompatMatch[] = buildMatches(library.bed, candidates, timbre, { limit: 30 });
  const v = bedVitals(library);
  return rackFromCompat(
    {
      source: {
        file_id: library.bed.id,
        name: `${library.bed.artist} — ${library.bed.title}`,
        bpm: v.bpm,
        bpm_confidence: v.bpm_confidence,
        tonic: v.tonic,
        mode: v.mode,
        key_confidence: v.key_confidence,
      },
      matches,
      note: null,
      method: METHOD,
    },
    library.stems,
  );
}

/** "What loops are in Masquerade?" — the second rack, so the panel has a history. */
export function demoLoopsRack(library: DemoLibrary): Rack {
  const file = library.files.find((f) => f.id === "demo-masquerade-drums") as FileRow;
  return rackFromLoops(file, library.loops, bedVitals(library));
}

/**
 * The four bars of the bed the producer puts in the song first. Built by the
 * real loop builder, so it carries the same measurements, provenance and
 * lineage as anything else that lands on the timeline.
 */
export function bedCandidate(library: DemoLibrary): RackCandidate {
  return candidateFromLoop(library.bed, library.bedLoop, 1, null);
}

/** Every rack the demo can open, by the request it answers. */
export type DemoRackId = "fits" | "loops";

export function demoRack(library: DemoLibrary, id: DemoRackId): Rack {
  return id === "fits" ? demoCompatRack(library) : demoLoopsRack(library);
}
