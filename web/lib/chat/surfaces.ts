// The chat's reach into the surfaces that live in the browser.
//
// The knot this unties: the chat runs on the server, and the session — the
// transport, the arrangement, the processing graph, the rack, the keyboard
// instrument and the undo stack — is client state no route can see or change.
// Everything built since Phase 8 is on the wrong side of that line.
//
// The shape chosen, and the reason for it:
//
//   A sentence the producer types is already parsed by lib/session/commands.ts
//   (and lib/pads/commands.ts) into a command, and the shell applies it to the
//   same control a mouse would move. That machinery is built, tested and
//   working. So the model does not get its own set of session mutations: it
//   gets to *say the sentence*. `session_control` takes steps in the session's
//   own command vocabulary, runs them through the very same parsers here on
//   the server, checks them against a snapshot of the open session, and hands
//   the client a directive — the parsed command — which goes on the existing
//   bus. One parser, one dispatcher, one place a sentence can change the song.
//
//   What the model knows about the session comes from a compact block in the
//   per-request context (OPEN_QUESTIONS 39's "a compact summary of tracks and
//   regions, with a tool to read any region in detail"), never from the cached
//   prefix, and only when a session is actually open. `read_session` is the
//   detail half, and is the `get_report` precedent applied to the song.
//
//   Nothing here states a musical fact. Lane names, bars, gains and locators
//   are the positions of controls; the measured values that travel with them
//   (a record's tempo, its key, its bandwidth) come from the report rows the
//   route reads, with their method, exactly as get_report does.

import { z } from "zod";
import { describeKeyboardCommand, parseKeyboardCommand, type KeyboardCommand } from "@/lib/pads/commands";
import { arrangementEnd, describeBar, regionsInBar, trackById, type Arrangement } from "@/lib/session/arrangement";
import {
  ALL_TRACKS,
  describeCommand,
  parseSessionCommand,
  resolveRegionTarget,
  resolveTarget,
  SELECTION,
  type SessionCommand,
} from "@/lib/session/commands";
import { describeLineage, lineageParts, sourceBars } from "@/lib/session/lineage";
import { dbFromGain } from "@/lib/session/mix";
import { barAt, secondsPerBar, type SessionTempo } from "@/lib/session/time";
import type { SessionRegion, SessionTrack } from "@/lib/session/types";
import { effective } from "@/lib/report/effective";
import { displayKey } from "@/lib/music/keys";
import type { FileRow } from "@/lib/types/db";

// ---------------------------------------------------------------------------
// what the client sends
// ---------------------------------------------------------------------------

/**
 * The open session, as it travels with a chat turn.
 *
 * The arrangement is carried verbatim — the same `SessionTrack[]` /
 * `SessionRegion[]` the engine schedules over — because the export renders it
 * and a summary would be a second, lossy model of the song. It goes into the
 * ToolContext, never into the prompt: only `sessionLines` below is ever put in
 * front of the model. When the song tables land (the migration is written and
 * unapplied, docs/HANDOFF_timeline.md section 8), this field becomes a session
 * id and the server reads the same shape out of them.
 */
export interface SessionSnapshot {
  arrangement: Arrangement;
  tempo: SessionTempo | null;
  playing: boolean;
  positionS: number;
  loop: { startS: number; endS: number } | null;
  masterGain: number;
  snap: string;
  selectedRegionId: string | null;
  undoLabel: string | null;
  redoLabel: string | null;
  /** what each lane's chain reads right now, in the words the dock uses */
  chains: Array<{ trackId: string; line: string }>;
  /** the bus, in the words the master strip uses */
  master: string;
  /** the lane the processing dock is on: what a chain verb with no lane named means */
  focusTrackId: string | null;
  rack: SnapshotRack | null;
  /** the file the route has open; a rack of its own needs one */
  openFileId: string | null;
  /** the instrument lives on a file's surface, so its verbs only have a listener there */
  keyboardOpen: boolean;
  songName: string | null;
}

export interface SnapshotRack {
  title: string;
  /**
   * True when `rows` is the whole rack. The rack panel is another seam's
   * component and the chat pane cannot read its list, so today only the row
   * that is auditioning is known and this is false: the model is told what is
   * sounding and not what else is on the panel, and a step naming a row it
   * cannot see is carried to the rack, which answers for itself.
   */
  listed: boolean;
  rows: Array<{ index: number; title: string; reason: string; confidence: number | null }>;
  /** which row is sounding under the session, 1-based; null when nothing is */
  auditioning: number | null;
}

const MAX_TRACKS = 32;
const MAX_REGIONS = 600;
const MAX_RACK_ROWS = 40;

const lineageSchema = z.object({
  fileId: z.string().max(64),
  fileName: z.string().max(200),
  parentFileId: z.string().max(64).nullable(),
  kind: z.enum(["loop", "file", "stem", "chop", "render"]),
  stem: z.string().max(64).nullable(),
  separationModel: z.string().max(64).nullable(),
  separationModelLabel: z.string().max(120).nullable(),
  takeStartS: z.number().finite(),
  takeEndS: z.number().finite(),
  downbeatS: z.number().finite(),
  sourceDurationS: z.number().finite().nullable(),
  sourceBpm: z.number().finite().nullable(),
  sourceBeatsPerBar: z.number().finite(),
  cents: z.number().finite(),
  stretch: z.number().finite(),
  candidateId: z.string().max(120).nullable(),
  reason: z.string().max(400).nullable(),
  confidence: z.number().nullable(),
});

const trackSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().max(160),
  gain: z.number().finite(),
  muted: z.boolean(),
  soloed: z.boolean(),
  fileId: z.string().max(64).nullable(),
  origin: z.enum(["candidate", "audition", "file", "render"]),
  provenance: z.string().max(400).nullable(),
  ephemeral: z.boolean().optional(),
});

const regionSchema = z.object({
  id: z.string().min(1).max(160),
  trackId: z.string().min(1).max(120),
  sourceId: z.string().min(1).max(120),
  startS: z.number().finite(),
  durationS: z.number().finite(),
  offsetS: z.number().finite(),
  gain: z.number().finite(),
  rate: z.number().finite().optional(),
  lineage: lineageSchema.optional(),
});

/** Bounded on purpose: a snapshot is caller input and travels on every turn. */
export const sessionSnapshotSchema = z.object({
  arrangement: z.object({
    tracks: z.array(trackSchema).max(MAX_TRACKS),
    regions: z.array(regionSchema).max(MAX_REGIONS),
  }),
  tempo: z.object({ bpm: z.number().positive().max(400), beatsPerBar: z.number().int().positive().max(16) }).nullable(),
  playing: z.boolean(),
  positionS: z.number().finite().min(0),
  loop: z.object({ startS: z.number().finite(), endS: z.number().finite() }).nullable(),
  masterGain: z.number().finite().min(0),
  snap: z.string().max(16),
  selectedRegionId: z.string().max(160).nullable(),
  undoLabel: z.string().max(160).nullable(),
  redoLabel: z.string().max(160).nullable(),
  chains: z.array(z.object({ trackId: z.string().max(120), line: z.string().max(400) })).max(MAX_TRACKS),
  master: z.string().max(200),
  focusTrackId: z.string().max(120).nullable(),
  rack: z
    .object({
      title: z.string().max(200),
      listed: z.boolean(),
      rows: z
        .array(z.object({ index: z.number().int().min(1), title: z.string().max(200), reason: z.string().max(300), confidence: z.number().nullable() }))
        .max(MAX_RACK_ROWS),
      auditioning: z.number().int().min(1).nullable(),
    })
    .nullable(),
  openFileId: z.string().max(64).nullable(),
  keyboardOpen: z.boolean(),
  songName: z.string().max(160).nullable(),
});

/** Every library record the open session's lanes point at, so bandwidth is read, never assumed. */
export function sessionFileIds(snapshot: SessionSnapshot): string[] {
  const ids = new Set<string>();
  for (const track of snapshot.arrangement.tracks) if (track.fileId) ids.add(track.fileId);
  for (const region of snapshot.arrangement.regions) if (region.lineage?.fileId) ids.add(region.lineage.fileId);
  return [...ids].slice(0, MAX_TRACKS * 2);
}

// ---------------------------------------------------------------------------
// what the model is told
// ---------------------------------------------------------------------------

function round(value: number, places = 2): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function dbLine(gain: number): string {
  const db = dbFromGain(gain);
  if (db <= -60) return "silent";
  return `${db >= 0 ? "+" : ""}${round(db, 1)} dB`;
}

function barLabel(sessionS: number, tempo: SessionTempo | null): string {
  const bar = barAt(sessionS, tempo);
  return bar === null ? `${round(sessionS, 2)}s` : `bar ${round(bar, 2)}`;
}

/** The bandwidth the analysis measured for one record, with what measured it. */
function bandwidthOf(file: FileRow | undefined): { hz: number; method: string | null } | null {
  const report = file?.report ? effective(file.report) : null;
  const measured = report?.spectral?.bandwidth;
  if (!measured || typeof measured.value !== "number") return null;
  return { hz: measured.value, method: measured.method };
}

function vitalsLine(file: FileRow | undefined): string {
  const report = file?.report ? effective(file.report) : null;
  if (!report) return "not analyzed";
  const parts: string[] = [];
  const bpm = report.tempo?.bpm;
  if (typeof bpm === "number") parts.push(`${round(bpm, 1)} BPM (${round(report.tempo?.confidence ?? 0, 2)})`);
  const key = report.key;
  if (key?.tonic && key.mode) parts.push(`${displayKey(key.tonic, key.mode)} (${round(key.confidence ?? 0, 2)})`);
  const band = bandwidthOf(file);
  if (band) parts.push(`bandwidth ${round(band.hz / 1000, 1)} kHz${band.method ? ` (${band.method})` : ""}`);
  else parts.push("bandwidth not measured");
  return parts.join(", ");
}

/**
 * The command vocabulary, by family. It lives here rather than in the tool
 * description for one measured reason: `lib/billing/promptBudget.test.ts` caps
 * the cached prefix at what the tiers were priced from and there are ~360
 * tokens left in it, which a full grammar does not fit. So the grammar rides
 * in the volatile block, where it costs nothing at all until a session is
 * open, and only the families that have a listener right now are listed.
 */
const GRAMMAR: ReadonlyArray<readonly [string, string]> = [
  ["transport", "play | pause | stop | loop bars 9 to 16 | loop 12s to 20s | loop off"],
  ["mix", "mute the drums | unmute everything | solo the horns | unsolo the horns | turn the drums down | turn the horns up 4db"],
  [
    "song",
    "show the song | move the drums to bar 17 | move it to 12s | trim the drums to 4 bars | duplicate it | repeat the drums | split it here | split the drums at bar 9 | delete it | take the horns out | snap to bars | snap to 16ths | no snap | zoom in | zoom out | fit the song | undo | redo",
  ],
  ["rack", "rack drums | hear what fits this | hear the loops here | play the third one | next | previous | keep it | stop auditioning"],
  [
    "chain",
    "show the eq on the horns | make the horns less muddy | the horns are too harsh | clean up the trumpet | cut 250 on the horns by 4db | boost the air on the horns | high-pass the bass at 80 | tune the horns up 20 cents | a/b the drums | bypass the horns | engage the horns | reset the eq on the drums | limit the master | limiter off",
  ],
  [
    "keyboard",
    "gate | one-shot | note mode | chop mode | the 32 key layout | root on g | propose cuts for melodic | cut it | order the kit by pitch | swap pads 3 and 5 | record 4 bars | stop recording | tighten 50% | keep the take | all off",
  ],
  ["panel", "close the panel | go back"],
];

/** Which families have something listening for them right now. */
function familiesFor(snapshot: SessionSnapshot | null): ReadonlyArray<readonly [string, string]> {
  if (!snapshot) return GRAMMAR;
  const lanes = snapshot.arrangement.tracks.length;
  return GRAMMAR.filter(([family]) => {
    if (family === "keyboard") return snapshot.keyboardOpen;
    if (family === "rack") return snapshot.rack !== null || snapshot.openFileId !== null;
    // Nothing to mix, arrange or filter until a lane exists, so an empty
    // session costs a few lines rather than the whole vocabulary.
    if (family === "mix" || family === "song" || family === "chain") return lanes > 0;
    return true;
  });
}

export function grammarLines(snapshot: SessionSnapshot | null): string[] {
  return familiesFor(snapshot).map(([family, forms]) => `  ${family}: ${forms}`);
}

/**
 * The session as a handful of lines. Compact on purpose: this is in the
 * volatile half of every turn that has a session open, so it says what a
 * producer would need said and nothing else. Detail is `read_session`.
 */
export function sessionLines(snapshot: SessionSnapshot, files: readonly FileRow[] = []): string[] {
  const fileOf = (id: string | null | undefined) => (id ? files.find((f) => f.id === id) : undefined);
  const { arrangement, tempo } = snapshot;
  const lines: string[] = [];
  lines.push("");
  lines.push("The producer has a session open. These are the positions of controls on their screen, not measurements of audio.");

  const grid = tempo
    ? `${round(tempo.bpm, 1)} BPM, ${tempo.beatsPerBar}/4, bar 1 is second 0`
    : "no measured tempo, so the session has no bars (say positions in seconds)";
  const transport = snapshot.playing ? `playing at ${barLabel(snapshot.positionS, tempo)}` : `stopped at ${barLabel(snapshot.positionS, tempo)}`;
  const loop = snapshot.loop ? `loop ${barLabel(snapshot.loop.startS, tempo)} to ${barLabel(snapshot.loop.endS, tempo)}` : "loop off";
  lines.push(`grid: ${grid} | snap ${snapshot.snap} | ${transport} | ${loop} | master ${dbLine(snapshot.masterGain)}, ${snapshot.master}`);

  if (arrangement.tracks.length === 0) {
    lines.push("lanes: none yet — the song is empty until a candidate is committed from a rack.");
  } else {
    lines.push(`lanes (${arrangement.tracks.length}), in the producer's order:`);
    for (const track of arrangement.tracks) {
      const regions = arrangement.regions.filter((r) => r.trackId === track.id);
      const chain = snapshot.chains.find((c) => c.trackId === track.id)?.line ?? null;
      const flags = [track.muted ? "muted" : null, track.soloed ? "soloed" : null].filter(Boolean).join(", ");
      const bits = [
        track.name,
        track.provenance ?? null,
        dbLine(track.gain),
        `${regions.length} ${regions.length === 1 ? "region" : "regions"}`,
        flags || null,
        chain ? `chain: ${chain}` : null,
        track.fileId ? `record: ${vitalsLine(fileOf(track.fileId))}` : null,
      ].filter((b): b is string => b !== null && b !== "");
      lines.push(`  ${bits.join(" | ")}`);
    }
    const end = arrangementEnd(arrangement);
    lines.push(`  song length ${round(end, 2)}s${tempo ? ` (${round(end / secondsPerBar(tempo) + 1, 2)} bars)` : ""}`);
  }

  const selected = snapshot.selectedRegionId ? arrangement.regions.find((r) => r.id === snapshot.selectedRegionId) : undefined;
  if (selected) {
    const lane = trackById(arrangement, selected.trackId)?.name ?? selected.trackId;
    lines.push(`selected region: on ${lane}, ${barLabel(selected.startS, tempo)} for ${round(selected.durationS, 2)}s — this is what "it" means in a step.`);
  } else {
    lines.push('no region is selected, so "it" names nothing; name the lane instead.');
  }

  if (snapshot.focusTrackId) {
    const lane = trackById(arrangement, snapshot.focusTrackId)?.name ?? snapshot.focusTrackId;
    lines.push(`the processing dock is on ${lane}, which is the lane a chain step with no lane named means.`);
  }

  if (snapshot.rack) {
    const rack = snapshot.rack;
    lines.push(`rack "${rack.title}"${rack.listed ? ` (${rack.rows.length} rows)` : " — the rows are on the panel and not listed here"}:`);
    for (const row of rack.rows.slice(0, 12)) {
      const sounding = rack.auditioning === row.index ? ", auditioning under the session now" : "";
      lines.push(`  ${row.index}. ${row.title} — ${row.reason}${row.confidence === null ? "" : ` (${round(row.confidence, 2)})`}${sounding}`);
    }
    if (rack.listed && rack.rows.length > 12) lines.push(`  …and ${rack.rows.length - 12} more rows.`);
    if (!rack.listed) lines.push("  say \"next\", \"play the third one\" or \"keep it\" and the rack answers for itself.");
  }

  const history = [snapshot.undoLabel ? `undo: ${snapshot.undoLabel}` : null, snapshot.redoLabel ? `redo: ${snapshot.redoLabel}` : null]
    .filter((h): h is string => h !== null)
    .join(" | ");
  if (history) lines.push(history);

  lines.push("session_control steps, in the session's own words — one control per step, said exactly like these:");
  lines.push(...grammarLines(snapshot));
  return lines;
}

/** What to say when there is no session at all: the same list, so a miss teaches the vocabulary. */
export function noSessionText(): string {
  return [
    "There is no session open in this conversation, so there is no transport, no song, no rack and no chain to move. The producer opens one by committing a candidate from a rack (\"hear what fits this\", then \"keep it\"). These are the steps this tool takes once there is:",
    ...grammarLines(null),
  ].join("\n");
}

// ---------------------------------------------------------------------------
// a step becomes a directive
// ---------------------------------------------------------------------------

export type DirectiveBus = "session" | "keyboard";

export interface DirectiveStep {
  /** the sentence, as the model said it */
  said: string;
  bus: DirectiveBus;
  command: SessionCommand | KeyboardCommand;
  /** what the control will say, from the same describe* the echo uses */
  line: string;
}

export interface RefusedStep {
  said: string;
  /** why, in the words the control uses */
  note: string;
}

export interface StepPlan {
  steps: DirectiveStep[];
  refused: RefusedStep[];
}

function noSuchLane(target: string): string {
  return `nothing in the session is called ${target === ALL_TRACKS ? "that" : target === SELECTION ? "the lane you are on" : target}.`;
}

const NO_TEMPO = "the session has no measured tempo yet, so it has no bars. Say it in seconds, or commit something with a tempo.";

/**
 * Can this command be carried out on the session as it stands? Every check
 * here runs the same exported resolver `components/shell/applyCommand.ts` and
 * `components/processing/ProcessingProvider.tsx` run, so a step that passes
 * here is a step those two will carry out, and a step that fails comes back
 * with the line they would have put in the chat.
 */
export function checkSessionCommand(command: SessionCommand, snapshot: SessionSnapshot): string | null {
  const { arrangement, tempo } = snapshot;
  const tracks = arrangement.tracks;
  const lane = (target: string): string | null => {
    if (target === SELECTION) return snapshot.focusTrackId ? null : noSuchLane(SELECTION);
    const ids = resolveTarget(target, tracks);
    return ids && ids.length > 0 ? null : noSuchLane(target);
  };

  switch (command.kind) {
    case "loop-bars":
      return tempo ? null : "the session has no measured tempo yet, so it has no bars. Say it in seconds, or commit something with a tempo.";
    case "mute":
    case "solo":
    case "gain":
    case "remove-track": {
      const ids = resolveTarget(command.target, tracks);
      return ids && ids.length > 0 ? null : noSuchLane(command.target);
    }
    case "move-region":
    case "trim-region":
    case "duplicate-region":
    case "split-region":
    case "delete-region": {
      const found = resolveRegionTarget(command.target, tracks, arrangement.regions, snapshot.selectedRegionId);
      if (!found.regionId) return found.note ?? "there is no region to change.";
      if (command.kind === "move-region" && command.toBar !== null && !tempo) return NO_TEMPO;
      if (command.kind === "trim-region" && command.bars !== null && !tempo) return NO_TEMPO;
      if (command.kind === "split-region" && command.atBar !== null && !tempo) return NO_TEMPO;
      return null;
    }
    case "audition": {
      // Only decided here when the whole rack is known; otherwise the rack
      // itself answers, because refusing a row we cannot see would be a guess.
      if (!snapshot.rack?.listed) return null;
      return snapshot.rack.rows.some((r) => r.index === command.index) ? null : `there is no candidate ${command.index} in the rack.`;
    }
    case "audition-next":
    case "audition-previous":
      if (!snapshot.rack?.listed) return null;
      return snapshot.rack.rows.length > 0 ? null : "there is no rack on the panel to step through.";
    case "commit":
      return snapshot.rack?.auditioning ? null : "nothing is auditioning, so there is nothing to keep.";
    case "rack-fits":
    case "rack-loops":
      return snapshot.openFileId ? null : "no file is open, so there is nothing to rack against.";
    case "undo":
      return snapshot.undoLabel ? null : "there is nothing to undo yet.";
    case "redo":
      return snapshot.redoLabel ? null : "there is nothing to redo.";
    case "processing":
    case "processing-bypass":
    case "processing-reset":
    case "fix":
    case "eq":
      return lane(command.target);
    case "tune":
      return lane(command.target);
    default:
      return null;
  }
}

/**
 * Steps in, directives out. A step is tried as a session command first and a
 * keyboard command second, which is the order the command line already uses;
 * anything neither parser recognises is refused with the vocabulary attached,
 * because a step that silently did nothing would be the worst answer of the
 * three.
 */
export function planSteps(said: readonly string[], snapshot: SessionSnapshot | null): StepPlan {
  const steps: DirectiveStep[] = [];
  const refused: RefusedStep[] = [];
  for (const raw of said) {
    const text = raw.trim();
    if (text === "") continue;
    const session = parseSessionCommand(text);
    if (session) {
      const note = snapshot ? checkSessionCommand(session, snapshot) : "there is no session open.";
      if (note) refused.push({ said: text, note });
      else steps.push({ said: text, bus: "session", command: session, line: describeCommand(session) });
      continue;
    }
    const keyboard = parseKeyboardCommand(text);
    if (keyboard) {
      if (snapshot && !snapshot.keyboardOpen) {
        refused.push({ said: text, note: "the keyboard instrument is not on screen, so nothing would hear that. Open a file's chops surface first." });
      } else {
        steps.push({ said: text, bus: "keyboard", command: keyboard, line: describeKeyboardCommand(keyboard) });
      }
      continue;
    }
    refused.push({ said: text, note: "that is not one of the session's steps. Say it in the vocabulary listed in the session block." });
  }
  return { steps, refused };
}

// ---------------------------------------------------------------------------
// reading the song
// ---------------------------------------------------------------------------

export interface ReadSessionInput {
  bar?: number;
  track?: string;
}

export interface SessionReading {
  text: string;
  summary: string;
}

function regionLine(region: SessionRegion, tempo: SessionTempo | null, lane: string): string {
  const where = barAt(region.startS, tempo);
  const at = where === null ? `${round(region.startS, 2)}s` : `bar ${round(where, 2)}`;
  const lineage = describeLineage(region, region.lineage ?? null);
  return `${lane}: ${at} for ${round(region.durationS, 2)}s — ${lineage}`;
}

/**
 * The detail half of OPEN_QUESTIONS 39. Every line is derived by the same pure
 * functions the timeline's inspector draws from (`describeBar`, `regionsInBar`,
 * `lineageParts`), so the chat and the panel cannot say different things about
 * the same region.
 */
export function readSession(snapshot: SessionSnapshot, input: ReadSessionInput): SessionReading {
  const { arrangement, tempo } = snapshot;
  if (input.bar !== undefined) {
    if (!tempo) return { text: "the session has no measured tempo yet, so it has no bars. Nothing invents one.", summary: "the session has no bars" };
    const regions = regionsInBar(arrangement, input.bar, tempo);
    const lines = regions.map((r) => regionLine(r, tempo, trackById(arrangement, r.trackId)?.name ?? r.trackId));
    return {
      text: [describeBar(arrangement, input.bar, tempo), ...lines].join("\n"),
      summary: `bar ${input.bar}: ${regions.length} ${regions.length === 1 ? "region" : "regions"}`,
    };
  }

  if (input.track !== undefined) {
    const ids = resolveTarget(input.track, arrangement.tracks);
    if (!ids || ids.length === 0) return { text: noSuchLane(input.track), summary: noSuchLane(input.track) };
    const lines: string[] = [];
    for (const id of ids) {
      const track = trackById(arrangement, id);
      if (!track) continue;
      const chain = snapshot.chains.find((c) => c.trackId === id)?.line ?? "nothing on the chain";
      lines.push(`${track.name} | ${track.provenance ?? "no provenance line"} | ${dbLine(track.gain)}${track.muted ? " | muted" : ""}${track.soloed ? " | soloed" : ""} | chain: ${chain}`);
      for (const region of arrangement.regions.filter((r) => r.trackId === id)) {
        lines.push(`  ${regionLine(region, tempo, track.name)}`);
        for (const part of lineageParts(region, region.lineage ?? null)) lines.push(`    ${part.label} — ${part.detail}`);
        const bars = sourceBars(region, region.lineage ?? null);
        if (bars) lines.push(`    the record's own bars: ${bars.fromBar}–${bars.toBar} (${bars.bars})`);
      }
    }
    return { text: lines.join("\n"), summary: `${input.track}: ${lines.length} lines` };
  }

  const lines = sessionLines(snapshot);
  return { text: lines.join("\n"), summary: `${arrangement.tracks.length} lanes, ${arrangement.regions.length} regions` };
}

/** Every lane and region as one object, for a tool result the model reads as JSON. */
export function songShape(snapshot: SessionSnapshot): {
  tempo: SessionTempo | null;
  tracks: Array<Pick<SessionTrack, "id" | "name" | "muted" | "soloed" | "provenance">>;
  regions: Array<{ id: string; trackId: string; startS: number; durationS: number; bar: number | null }>;
} {
  return {
    tempo: snapshot.tempo,
    tracks: snapshot.arrangement.tracks.map((t) => ({ id: t.id, name: t.name, muted: t.muted, soloed: t.soloed, provenance: t.provenance })),
    regions: snapshot.arrangement.regions.map((r) => ({
      id: r.id,
      trackId: r.trackId,
      startS: round(r.startS, 3),
      durationS: round(r.durationS, 3),
      bar: barAt(r.startS, snapshot.tempo),
    })),
  };
}
