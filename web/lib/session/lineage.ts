// What a region actually is.
//
// A normal DAW throws this away at import: audio arrives, becomes a nameless
// block of samples, and the fact that it was bars 9 to 16 of a particular
// record, separated one way rather than another, is gone. Here it is the point.
// The breakdown is only honest if a region can say where it came from; the
// corrections table can only learn if a pick can be joined back to the ranking;
// and principle 1 ("nothing from nothing") is only enforceable if every second
// of audio on the timeline can be traced to audio the producer brought.
//
// So lineage rides on the region itself, and every edit carries it through.
// Moving, trimming, splitting and copying all spread the same object; nothing
// in `arrangement.ts` rewrites it. What *is* recomputed on every read is the
// part that an edit genuinely changes: which seconds of the source are
// sounding now, and therefore which of the source's own bars they are. Trim a
// bar off the front and the line says "bars 10-16", because that is what it
// now is.
//
// Pure and framework-free, like the rest of this folder: the describe
// functions are asserted in node against hand-built regions.

/** The kinds of thing a region's audio can be. Mirrors the library's file kinds. */
export type LineageKind = "loop" | "file" | "stem" | "chop" | "render";

/**
 * Where a region's audio came from and what was done to it. Written once, when
 * the material lands on the timeline, and never rewritten by an edit.
 *
 * The three transform fields are deliberately separate because they are
 * different things and a producer needs to tell them apart:
 *
 *   `cents`   pitch moved by a render, with time held.
 *   `stretch` time moved by a render, with pitch held.
 *   the region's own `rate` (on SessionRegion, not here) is resampling at
 *             playback: pitch and time move together, the way a sampler does.
 *
 * Today only the third one happens in the browser; the first two are carried
 * so a rendered region can say what was done to it without a round trip.
 */
export interface RegionLineage {
  /** the library file the samples live in */
  fileId: string;
  /** what a producer calls that record */
  fileName: string;
  /** the record a stem or a chop was cut out of, when this is derived */
  parentFileId: string | null;
  kind: LineageKind;
  /** "drums" when this is a separated stem */
  stem: string | null;
  /** which separator made it; everything downstream inherits that choice */
  separationModel: string | null;
  separationModelLabel: string | null;
  /** the span of the source the producer chose, before any trimming on the timeline */
  takeStartS: number;
  takeEndS: number;
  /** where the one is inside the source; bars are counted from here */
  downbeatS: number;
  /** the whole source's length, when it is known. A trim may not reveal past it. */
  sourceDurationS: number | null;
  /** the source's own measured tempo, so a span of it can be named in its own bars */
  sourceBpm: number | null;
  sourceBeatsPerBar: number;
  /** pitch a render applied, in cents; 0 when none */
  cents: number;
  /** time-stretch a render applied, pitch held; 1 when none */
  stretch: number;
  /** the rack row this arrived as, so a pick can be joined back to the ranking */
  candidateId: string | null;
  /** what the machine said when it offered this, kept verbatim */
  reason: string | null;
  confidence: number | null;
}

/** What a candidate has to carry for lineage; structural, so this file imports no rack. */
export interface LineageSource {
  id: string;
  kind: LineageKind | string;
  audio: { fileId: string; startS: number; endS: number; downbeatS: number };
  reason?: string | null;
  confidence?: number | null;
  fileDurationS?: number | null;
  provenance: {
    fileId: string;
    fileName: string;
    parentFileId: string | null;
    stem: string | null;
    separationModel: string | null;
    separationModelLabel: string | null;
  };
}

const KINDS: readonly LineageKind[] = ["loop", "file", "stem", "chop", "render"];

function kindOf(kind: LineageKind | string): LineageKind {
  return (KINDS as readonly string[]).includes(kind) ? (kind as LineageKind) : "file";
}

/**
 * The lineage a candidate becomes when it lands on the timeline. `sourceBpm`
 * comes from the caller because the candidate carries the tempo as a
 * measurement line rather than a number; null is honest and means the region
 * cannot name its own bars.
 */
export function lineageFrom(source: LineageSource, options: { sourceBpm?: number | null; beatsPerBar?: number; cents?: number; stretch?: number } = {}): RegionLineage {
  const p = source.provenance;
  return {
    fileId: source.audio.fileId,
    fileName: p.fileName,
    parentFileId: p.parentFileId,
    kind: kindOf(source.kind),
    stem: p.stem,
    separationModel: p.separationModel,
    separationModelLabel: p.separationModelLabel,
    takeStartS: source.audio.startS,
    takeEndS: source.audio.endS,
    downbeatS: source.audio.downbeatS,
    sourceDurationS: source.fileDurationS ?? null,
    sourceBpm: options.sourceBpm ?? null,
    sourceBeatsPerBar: options.beatsPerBar ?? 4,
    cents: options.cents ?? 0,
    stretch: options.stretch ?? 1,
    candidateId: source.id,
    reason: source.reason ?? null,
    confidence: source.confidence ?? null,
  };
}

// --- what an edit changes, and what it does not -------------------------------

/** The part of a region an edit moves. Kept structural so this file imports no types. */
export interface EditedRegion {
  startS: number;
  durationS: number;
  offsetS: number;
  rate?: number;
}

function rateOf(region: EditedRegion): number {
  const rate = region.rate;
  return rate === undefined || !Number.isFinite(rate) || rate <= 0 ? 1 : rate;
}

export interface SourceSpan {
  startS: number;
  endS: number;
}

/**
 * Which seconds of the source are actually sounding, after every move and trim.
 *
 * A resampled region eats the source faster than the timeline: half a minute of
 * session time at rate 0.964 is 28.9 seconds of the record. Getting this wrong
 * is how a timeline ends up claiming a region is bars 9-16 when the producer
 * trimmed it to bars 11-16 four edits ago.
 */
export function soundingSpan(region: EditedRegion): SourceSpan {
  const rate = rateOf(region);
  const startS = region.offsetS;
  return { startS, endS: startS + Math.max(0, region.durationS) * rate };
}

/** Seconds of the source still available after the region's end; what a tail trim can reveal. */
export function headroomS(region: EditedRegion, lineage: RegionLineage | null | undefined): number | null {
  const total = lineage?.sourceDurationS ?? null;
  if (total === null || !Number.isFinite(total)) return null;
  return Math.max(0, total - soundingSpan(region).endS);
}

export interface SourceBars {
  /** 1-based, counted from the source's own downbeat */
  fromBar: number;
  /** the last bar the region touches, inclusive */
  toBar: number;
  /** how many bars long it is, to one decimal */
  bars: number;
}

/**
 * The source's own bars this region covers, or null when the source has no
 * measured tempo. Counted from the downbeat, so bar 1 is the one — a region
 * that starts before the downbeat reports a bar below 1, which is a pickup and
 * is the truth rather than a clamp.
 */
export function sourceBars(region: EditedRegion, lineage: RegionLineage | null | undefined): SourceBars | null {
  const bpm = lineage?.sourceBpm ?? null;
  if (lineage == null || bpm === null || !(bpm > 0)) return null;
  const beats = lineage.sourceBeatsPerBar > 0 ? lineage.sourceBeatsPerBar : 4;
  const barS = (60 / bpm) * beats;
  if (!(barS > 0)) return null;
  const span = soundingSpan(region);
  const from = (span.startS - lineage.downbeatS) / barS;
  const to = (span.endS - lineage.downbeatS) / barS;
  // The tolerance is in bars, not seconds: a four-bar region whose length was
  // written to four decimal places is a thousandth of a bar over, and a
  // seconds-sized epsilon would report it as touching bar 5 — true to the
  // millisecond and useless to a producer. A thousandth of a bar is under
  // three milliseconds at 90 BPM, well below anything that reads as a bar.
  const eps = 1e-3;
  return {
    fromBar: Math.floor(from + eps) + 1,
    toBar: Math.max(Math.floor(from + eps) + 1, Math.ceil(to - eps)),
    bars: Math.round((to - from) * 10) / 10,
  };
}

/** Cents of pitch movement a playback rate causes. Resampling moves pitch with tempo. */
export function rateCents(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0 || rate === 1) return 0;
  return Math.round(1200 * Math.log2(rate));
}

// --- saying it -----------------------------------------------------------------

/** One claim on a region, with the thing behind it for the title attribute. */
export interface LineagePart {
  label: string;
  detail: string;
}

/**
 * Everything the region can say about itself, as parts so the UI can show each
 * one with its own explanation. The order is the order a producer asks in:
 * which record, which part of it, what was done to it, how it was made.
 */
export function lineageParts(region: EditedRegion, lineage: RegionLineage | null | undefined): LineagePart[] {
  if (!lineage) return [{ label: "no lineage", detail: "this region arrived without a record behind it, which should not happen" }];
  const parts: LineagePart[] = [{ label: lineage.fileName, detail: `library file ${lineage.fileId}` }];
  if (lineage.stem) parts.push({ label: lineage.stem, detail: lineage.separationModelLabel ?? "a separated stem" });

  const bars = sourceBars(region, lineage);
  const span = soundingSpan(region);
  if (bars) {
    parts.push({
      label: bars.fromBar === bars.toBar ? `bar ${bars.fromBar}` : `bars ${bars.fromBar}–${bars.toBar}`,
      detail: `${bars.bars} ${bars.bars === 1 ? "bar" : "bars"} of the record at ${lineage.sourceBpm?.toFixed(1)} BPM, counted from its downbeat at ${fmtTime(lineage.downbeatS)}`,
    });
  }
  parts.push({ label: `${fmtTime(span.startS)}–${fmtTime(span.endS)}`, detail: "the seconds of the record this region is playing right now" });

  const rate = rateOf(region);
  if (rate !== 1) {
    parts.push({
      label: `×${rate.toFixed(3)}`,
      detail: `resampled to fit, which moves the pitch with the tempo by ${signed(rateCents(rate))} cents the way a sampler does`,
    });
  }
  if (lineage.stretch !== 1) {
    parts.push({ label: `stretched to ${lineage.stretch.toFixed(3)}`, detail: "time-stretched by a render, with the pitch held" });
  }
  if (lineage.cents !== 0) {
    parts.push({ label: `${signed(lineage.cents)} cents`, detail: "pitched by a render, with the time held" });
  }
  if (lineage.separationModel) {
    parts.push({ label: `separated: ${lineage.separationModel}`, detail: lineage.separationModelLabel ?? "the separator that made this stem" });
  }
  return parts;
}

/** The one line a producer reads off a region, in the vocabulary the rest of the product uses. */
export function describeLineage(region: EditedRegion, lineage: RegionLineage | null | undefined): string {
  return lineageParts(region, lineage)
    .map((p) => p.label)
    .join(" · ");
}

/**
 * The provenance line a lane carries. The lane says which record; the regions
 * on it say which bars, because trimming one region must not change the lane's
 * claim about the others.
 */
export function laneProvenance(lineage: RegionLineage | null | undefined): string | null {
  if (!lineage) return null;
  const parts = [lineage.fileName, lineage.stem, lineage.separationModel ? `separated: ${lineage.separationModel}` : null].filter((x): x is string => Boolean(x));
  return parts.length > 0 ? parts.join(", ") : null;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function fmtTime(s: number): string {
  if (!Number.isFinite(s)) return "—";
  const sign = s < 0 ? "-" : "";
  const abs = Math.abs(s);
  const m = Math.floor(abs / 60);
  return `${sign}${m}:${(abs - m * 60).toFixed(2).padStart(5, "0")}`;
}
