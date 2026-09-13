// The song, as data, and every edit to it as a pure function.
//
// This is Surface 2 of the direction document. The transport already knows how
// to sound a set of regions; this is the set, and the rules for changing it:
// move a region, trim either edge, split it, copy it, take it out, set its
// level, add and remove lanes and reorder them. Nothing here touches Web
// Audio, React or the DOM, so the behaviour a producer will complain about if
// it is wrong — a trim that reveals audio nobody asked for, a drag that lands
// off the grid, a copy that loses where the material came from — is asserted
// in node instead of discovered by ear.
//
// Three rules hold everywhere in this file.
//
//   **Musical time, not pixel time.** Every edit takes a `Grid` and puts its
//   result on it. The mouse, the keyboard and the sentence all come through
//   the same functions, so they cannot land in different places.
//
//   **Lineage survives.** Regions are copied with a spread, and nothing
//   rewrites `lineage`. A region that has been moved to bar 33, trimmed at
//   both ends and duplicated twice still knows which record it is bars of and
//   what was done to it (`lineage.ts`).
//
//   **Nothing is edited in place.** Every function returns a new arrangement,
//   or the one it was given when the edit would change nothing. Identity is
//   meaningful: the caller uses it to skip work, and the undo stack uses it to
//   avoid recording an edit that did not happen.

import { headroomS, soundingSpan, type RegionLineage } from "./lineage";
import { rateOf, regionEnd } from "./schedule";
import { snapTime, nudgeSeconds, type Grid } from "./snap";
import { barAt, barToSeconds, type SessionTempo } from "./time";
import { clampGain } from "./mix";
import type { SessionRegion, SessionTrack } from "./types";

/**
 * The song: lanes in the order they are stacked, and every region on all of
 * them. Regions carry their own `trackId` rather than nesting inside a lane,
 * because that is the shape the scheduler already plans over and re-nesting it
 * twice a frame would be work for nothing.
 */
export interface Arrangement {
  tracks: SessionTrack[];
  regions: SessionRegion[];
}

export const EMPTY_ARRANGEMENT: Arrangement = { tracks: [], regions: [] };

/** Shorter than this and a region is a click, not a sound. */
export const MIN_REGION_S = 0.02;

export interface EditOptions {
  /** the grid the edit lands on; omit for free placement */
  grid?: Grid;
  minLengthS?: number;
}

const FREE: Grid = { tempo: null, snap: "off" };

function gridOf(options: EditOptions | undefined): Grid {
  return options?.grid ?? FREE;
}

function minLength(options: EditOptions | undefined): number {
  const value = options?.minLengthS ?? MIN_REGION_S;
  return value > 0 ? value : MIN_REGION_S;
}

// --- reading -------------------------------------------------------------------

export function regionById(arrangement: Arrangement, regionId: string): SessionRegion | null {
  return arrangement.regions.find((r) => r.id === regionId) ?? null;
}

export function trackById(arrangement: Arrangement, trackId: string): SessionTrack | null {
  return arrangement.tracks.find((t) => t.id === trackId) ?? null;
}

/** One lane's material, in timeline order. */
export function regionsOfTrack(arrangement: Arrangement, trackId: string): SessionRegion[] {
  return arrangement.regions.filter((r) => r.trackId === trackId).sort((a, b) => a.startS - b.startS);
}

/** The last session second anything sounds on: the length of the song. */
export function arrangementEnd(arrangement: Arrangement): number {
  let end = 0;
  for (const region of arrangement.regions) end = Math.max(end, regionEnd(region));
  return end;
}

/** Everything sounding at a session second. */
export function regionsAt(arrangement: Arrangement, sessionS: number): SessionRegion[] {
  return arrangement.regions.filter((r) => sessionS >= r.startS - 1e-9 && sessionS < regionEnd(r) - 1e-9);
}

/**
 * Everything that touches a bar. This is the query OPEN_QUESTIONS 38 is about
 * — "what is in bar 17" — answered from the arrangement rather than from a
 * blob, and it is the same function the persistence layer's row shape is built
 * to serve.
 */
export function regionsInBar(arrangement: Arrangement, bar: number, tempo: SessionTempo | null): SessionRegion[] {
  if (!tempo) return [];
  const fromS = barToSeconds(bar, tempo);
  const toS = barToSeconds(bar + 1, tempo);
  if (!(toS > fromS)) return [];
  return arrangement.regions.filter((r) => r.startS < toS - 1e-9 && regionEnd(r) > fromS + 1e-9).sort((a, b) => a.startS - b.startS);
}

/** One line naming what is in a bar, lane by lane. The chat's answer, from measurements only. */
export function describeBar(arrangement: Arrangement, bar: number, tempo: SessionTempo | null): string {
  if (!tempo) return "the session has no measured tempo yet, so it has no bars.";
  const regions = regionsInBar(arrangement, bar, tempo);
  if (regions.length === 0) return `nothing is in bar ${bar}.`;
  const names = regions.map((r) => {
    const track = trackById(arrangement, r.trackId);
    const lane = track?.name ?? r.trackId;
    const lineage = r.lineage;
    return lineage ? `${lane} (${lineage.fileName}${lineage.stem ? `, ${lineage.stem}` : ""})` : lane;
  });
  return `bar ${bar}: ${names.join(", ")}.`;
}

/** Which bar a region starts in, for a readout; null without a tempo. */
export function startBarOf(region: SessionRegion, tempo: SessionTempo | null): number | null {
  return barAt(region.startS, tempo);
}

// --- ids -----------------------------------------------------------------------

/**
 * A free id derived from an existing one, so a split or a copy is deterministic
 * and a test can name the region it expects. No randomness: two runs of the
 * same edits produce the same ids, which is what makes the undo stack and the
 * scheduler's keys comparable across a reload.
 */
export function nextRegionId(arrangement: Arrangement, baseId: string): string {
  const base = baseId.replace(/~\d+$/, "");
  const taken = new Set(arrangement.regions.map((r) => r.id));
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base}~${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}~${taken.size + 1}`;
}

// --- the limits an edit may not cross ------------------------------------------

export interface RegionLimits {
  /** the earliest a head trim may go: the source runs out before this */
  minStartS: number;
  /** the latest an end may go: past this there is no more recording */
  maxEndS: number | null;
}

/**
 * What the material allows. Trimming the head backwards asks for audio before
 * the region's current offset, and there is only as much of that as the source
 * has before it; trimming the tail forwards asks for audio after the end, and
 * the same is true. When the source's length is unknown the tail is not
 * clamped — better to let a producer drag into silence than to invent a limit
 * from a duration nobody measured.
 */
export function limitsOf(region: SessionRegion): RegionLimits {
  const rate = rateOf(region);
  const minStartS = Math.max(0, region.startS - region.offsetS / rate);
  const headroom = headroomS(region, region.lineage);
  const maxEndS = headroom === null ? null : regionEnd(region) + headroom / rate;
  return { minStartS, maxEndS };
}

// --- moving --------------------------------------------------------------------

function replaceRegion(arrangement: Arrangement, next: SessionRegion): Arrangement {
  return { tracks: arrangement.tracks, regions: arrangement.regions.map((r) => (r.id === next.id ? next : r)) };
}

/**
 * Move a region to a new start, and optionally to a new lane. `offsetS` and
 * `durationS` do not change: a move slides the same audio along the timeline,
 * which is the whole difference between a move and a trim.
 */
export function moveRegion(arrangement: Arrangement, regionId: string, toStartS: number, options: EditOptions & { toTrackId?: string } = {}): Arrangement {
  const region = regionById(arrangement, regionId);
  if (!region) return arrangement;
  const startS = Math.max(0, snapTime(toStartS, gridOf(options)));
  const trackId = options.toTrackId ?? region.trackId;
  if (Math.abs(startS - region.startS) < 1e-9 && trackId === region.trackId) return arrangement;
  if (options.toTrackId !== undefined && !trackById(arrangement, options.toTrackId)) return arrangement;
  return replaceRegion(arrangement, { ...region, startS, trackId });
}

/** Move by whole grid steps: the keyboard's arrow keys, and "nudge it a bar later". */
export function nudgeRegion(arrangement: Arrangement, regionId: string, steps: number, options: EditOptions = {}): Arrangement {
  const region = regionById(arrangement, regionId);
  if (!region || steps === 0) return arrangement;
  const step = nudgeSeconds(gridOf(options));
  // Nudging is relative, so the result keeps whatever offset from the grid the
  // region already had; snapping it here would silently pull an off-grid
  // region onto the grid on the first arrow press.
  const startS = Math.max(0, region.startS + steps * step);
  if (Math.abs(startS - region.startS) < 1e-9) return arrangement;
  return replaceRegion(arrangement, { ...region, startS });
}

/** Put a region on another lane at the same second. */
export function moveRegionToTrack(arrangement: Arrangement, regionId: string, toTrackId: string): Arrangement {
  const region = regionById(arrangement, regionId);
  if (!region || region.trackId === toTrackId || !trackById(arrangement, toTrackId)) return arrangement;
  return replaceRegion(arrangement, { ...region, trackId: toTrackId });
}

// --- trimming ------------------------------------------------------------------

/**
 * Trim the head: the region starts later (or earlier) and starts from a
 * different second of the source.
 *
 * `startS` and `offsetS` move together and `durationS` shrinks by the same
 * amount, so the audio under the part that is left does not move. Change
 * `startS` alone and the whole region slides; change `offsetS` alone and the
 * material slips under a region that stayed put. Both are wrong in ways a
 * producer hears immediately and cannot name, which is why this is its own
 * function with its own tests.
 *
 * A resampled region eats the source at `rate`, so the offset moves by
 * `delta * rate` rather than by `delta`.
 */
export function trimHead(arrangement: Arrangement, regionId: string, toStartS: number, options: EditOptions = {}): Arrangement {
  const region = regionById(arrangement, regionId);
  if (!region) return arrangement;
  const rate = rateOf(region);
  const limits = limitsOf(region);
  const min = limits.minStartS;
  const max = regionEnd(region) - minLength(options);
  const startS = Math.min(max, Math.max(min, snapTime(toStartS, gridOf(options))));
  const delta = startS - region.startS;
  if (Math.abs(delta) < 1e-9) return arrangement;
  return replaceRegion(arrangement, {
    ...region,
    startS,
    offsetS: Math.max(0, region.offsetS + delta * rate),
    durationS: region.durationS - delta,
  });
}

/**
 * Trim the tail: only `durationS` changes. `startS` stays where the producer
 * put it and `offsetS` stays where the material starts, so the region keeps
 * playing exactly the same audio from exactly the same place and simply stops
 * sooner or later.
 */
export function trimTail(arrangement: Arrangement, regionId: string, toEndS: number, options: EditOptions = {}): Arrangement {
  const region = regionById(arrangement, regionId);
  if (!region) return arrangement;
  const limits = limitsOf(region);
  const min = region.startS + minLength(options);
  const snapped = snapTime(toEndS, gridOf(options));
  const endS = Math.max(min, limits.maxEndS === null ? snapped : Math.min(limits.maxEndS, snapped));
  const durationS = endS - region.startS;
  if (Math.abs(durationS - region.durationS) < 1e-9) return arrangement;
  return replaceRegion(arrangement, { ...region, durationS });
}

// --- splitting, copying, removing ----------------------------------------------

/**
 * Cut a region in two at a session second. Both halves keep the lineage, the
 * gain and the rate; the right half's offset advances by exactly the audio the
 * left half used, so the join is sample-continuous and playing across it
 * sounds like nothing happened.
 */
export function splitRegion(arrangement: Arrangement, regionId: string, atS: number, options: EditOptions = {}): Arrangement {
  const region = regionById(arrangement, regionId);
  if (!region) return arrangement;
  const min = minLength(options);
  const at = snapTime(atS, gridOf(options));
  if (at <= region.startS + min - 1e-9 || at >= regionEnd(region) - min + 1e-9) return arrangement;
  const rate = rateOf(region);
  const left: SessionRegion = { ...region, durationS: at - region.startS };
  const right: SessionRegion = {
    ...region,
    id: nextRegionId(arrangement, region.id),
    startS: at,
    offsetS: region.offsetS + (at - region.startS) * rate,
    durationS: regionEnd(region) - at,
  };
  return { tracks: arrangement.tracks, regions: arrangement.regions.flatMap((r) => (r.id === regionId ? [left, right] : [r])) };
}

/**
 * Copy a region. By default it lands immediately after itself, which is how a
 * four-bar loop becomes eight — and the copy carries the lineage, so the
 * second four bars still know which record they are bars of. That is the case
 * a normal DAW loses.
 */
export function duplicateRegion(arrangement: Arrangement, regionId: string, options: EditOptions & { atS?: number } = {}): Arrangement {
  const region = regionById(arrangement, regionId);
  if (!region) return arrangement;
  const startS = Math.max(0, options.atS === undefined ? regionEnd(region) : snapTime(options.atS, gridOf(options)));
  const copy: SessionRegion = { ...region, id: nextRegionId(arrangement, region.id), startS };
  return { tracks: arrangement.tracks, regions: [...arrangement.regions, copy] };
}

export function deleteRegion(arrangement: Arrangement, regionId: string): Arrangement {
  if (!regionById(arrangement, regionId)) return arrangement;
  return { tracks: arrangement.tracks, regions: arrangement.regions.filter((r) => r.id !== regionId) };
}

/** A region's own trim, on top of its lane's fader. */
export function setRegionGain(arrangement: Arrangement, regionId: string, gain: number): Arrangement {
  const region = regionById(arrangement, regionId);
  if (!region) return arrangement;
  const next = clampGain(gain);
  if (Math.abs(next - region.gain) < 1e-9) return arrangement;
  return replaceRegion(arrangement, { ...region, gain: next });
}

// --- lanes ---------------------------------------------------------------------

export function addTrack(arrangement: Arrangement, track: SessionTrack, regions: SessionRegion[] = []): Arrangement {
  const tracks = [...arrangement.tracks.filter((t) => t.id !== track.id), track];
  const kept = arrangement.regions.filter((r) => r.trackId !== track.id);
  return { tracks, regions: [...kept, ...regions] };
}

export function removeTrack(arrangement: Arrangement, trackId: string): Arrangement {
  if (!trackById(arrangement, trackId)) return arrangement;
  return { tracks: arrangement.tracks.filter((t) => t.id !== trackId), regions: arrangement.regions.filter((r) => r.trackId !== trackId) };
}

export function patchTrack(arrangement: Arrangement, trackId: string, patch: Partial<Omit<SessionTrack, "id">>): Arrangement {
  const track = trackById(arrangement, trackId);
  if (!track) return arrangement;
  const next = { ...track, ...patch };
  if (sameTrackFields(track, next)) return arrangement;
  return { tracks: arrangement.tracks.map((t) => (t.id === trackId ? next : t)), regions: arrangement.regions };
}

export function setTrackMute(arrangement: Arrangement, trackId: string, muted: boolean): Arrangement {
  return patchTrack(arrangement, trackId, { muted });
}

export function setTrackSolo(arrangement: Arrangement, trackId: string, soloed: boolean): Arrangement {
  return patchTrack(arrangement, trackId, { soloed });
}

export function setTrackGain(arrangement: Arrangement, trackId: string, gain: number): Arrangement {
  return patchTrack(arrangement, trackId, { gain: clampGain(gain) });
}

export function renameTrack(arrangement: Arrangement, trackId: string, name: string): Arrangement {
  const trimmed = name.trim();
  return trimmed === "" ? arrangement : patchTrack(arrangement, trackId, { name: trimmed });
}

/** Stack a lane somewhere else. Lane order is the producer's, and it is not audible. */
export function moveTrack(arrangement: Arrangement, trackId: string, toIndex: number): Arrangement {
  const from = arrangement.tracks.findIndex((t) => t.id === trackId);
  if (from < 0) return arrangement;
  const to = Math.min(arrangement.tracks.length - 1, Math.max(0, toIndex));
  if (to === from) return arrangement;
  const tracks = arrangement.tracks.slice();
  const [moved] = tracks.splice(from, 1);
  if (!moved) return arrangement;
  tracks.splice(to, 0, moved);
  return { tracks, regions: arrangement.regions };
}

/** An empty lane to drop material onto. */
export function emptyTrack(id: string, name: string): SessionTrack {
  return { id, name, gain: 1, muted: false, soloed: false, fileId: null, origin: "file", provenance: null };
}

// --- dragging ------------------------------------------------------------------

export type DragKind = "move" | "trim-head" | "trim-tail";

/**
 * A drag in progress, in musical terms rather than pixels. The component turns
 * the pointer into a session second with `xToTime` and hands over this; every
 * decision about where the region actually goes is made here, where it can be
 * tested without a DOM.
 */
export interface DragIntent {
  kind: DragKind;
  regionId: string;
  /** seconds between the region's start and where the pointer grabbed it (move only) */
  grabOffsetS: number;
  /** the lane the pointer is over now; undefined leaves the region where it is */
  toTrackId?: string;
}

export function dragIntentFor(region: SessionRegion, kind: DragKind, pointerS: number): DragIntent {
  return { kind, regionId: region.id, grabOffsetS: kind === "move" ? pointerS - region.startS : 0 };
}

/** The arrangement this drag would produce if the pointer went up here. */
export function applyDrag(arrangement: Arrangement, intent: DragIntent, pointerS: number, options: EditOptions = {}): Arrangement {
  switch (intent.kind) {
    case "move":
      return moveRegion(arrangement, intent.regionId, pointerS - intent.grabOffsetS, { ...options, ...(intent.toTrackId === undefined ? {} : { toTrackId: intent.toTrackId }) });
    case "trim-head":
      return trimHead(arrangement, intent.regionId, pointerS, options);
    case "trim-tail":
      return trimTail(arrangement, intent.regionId, pointerS, options);
  }
}

/**
 * Just the region being dragged, without copying the rest. A drag fires on
 * every pointer move; a song with four hundred regions must not rebuild its
 * array sixty times a second to draw one block in a new place.
 */
export function previewDrag(arrangement: Arrangement, intent: DragIntent, pointerS: number, options: EditOptions = {}): SessionRegion | null {
  const before = regionById(arrangement, intent.regionId);
  if (!before) return null;
  const after = regionById(applyDrag(arrangement, intent, pointerS, options), intent.regionId);
  if (!after) return null;
  return intent.kind === "move" && intent.toTrackId !== undefined && after.trackId !== intent.toTrackId && trackById(arrangement, intent.toTrackId)
    ? { ...after, trackId: intent.toTrackId }
    : after;
}

// --- the audition lane is not part of the song ---------------------------------

/**
 * The arrangement, taken out of an engine snapshot.
 *
 * Auditioning is not an edit: the rack's ephemeral lane comes and goes while a
 * producer is deciding, and undo must not walk back through thirty auditions
 * to find the drag they actually want back. So the ephemeral lanes are held
 * out of the arrangement entirely, and put back when it is handed to the
 * engine.
 */
export function arrangementOf(snapshot: { tracks: readonly SessionTrack[]; regions: readonly SessionRegion[] }): Arrangement {
  const tracks = snapshot.tracks.filter((t) => !t.ephemeral);
  const ids = new Set(tracks.map((t) => t.id));
  return { tracks: [...tracks], regions: snapshot.regions.filter((r) => ids.has(r.trackId)) };
}

/** The ephemeral half of a snapshot: the audition lane and whatever is on it. */
export function ephemeralOf(snapshot: { tracks: readonly SessionTrack[]; regions: readonly SessionRegion[] }): Arrangement {
  const tracks = snapshot.tracks.filter((t) => t.ephemeral === true);
  const ids = new Set(tracks.map((t) => t.id));
  return { tracks: [...tracks], regions: snapshot.regions.filter((r) => ids.has(r.trackId)) };
}

/** Put the audition lane back on top of an edited arrangement. */
export function withEphemeral(arrangement: Arrangement, ephemeral: Arrangement): Arrangement {
  if (ephemeral.tracks.length === 0) return arrangement;
  return { tracks: [...arrangement.tracks, ...ephemeral.tracks], regions: [...arrangement.regions, ...ephemeral.regions] };
}

// --- comparing -----------------------------------------------------------------

/** Field-by-field, because object identity says nothing after a spread. */
export function sameRegion(a: SessionRegion, b: SessionRegion): boolean {
  return (
    a.id === b.id &&
    a.trackId === b.trackId &&
    a.sourceId === b.sourceId &&
    Math.abs(a.startS - b.startS) < 1e-9 &&
    Math.abs(a.durationS - b.durationS) < 1e-9 &&
    Math.abs(a.offsetS - b.offsetS) < 1e-9 &&
    Math.abs(a.gain - b.gain) < 1e-9 &&
    rateOf(a) === rateOf(b)
  );
}

export function sameTrackFields(a: SessionTrack, b: SessionTrack): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    Math.abs(a.gain - b.gain) < 1e-9 &&
    a.muted === b.muted &&
    a.soloed === b.soloed &&
    a.fileId === b.fileId &&
    a.origin === b.origin &&
    a.provenance === b.provenance &&
    (a.ephemeral ?? false) === (b.ephemeral ?? false)
  );
}

/**
 * Are these the same song? Used to tell an edit apart from the engine handing
 * back what it was already given, so the undo stack does not record the echo
 * of its own edit as a new one.
 */
export function sameArrangement(a: Arrangement, b: Arrangement): boolean {
  if (a === b) return true;
  if (a.tracks.length !== b.tracks.length || a.regions.length !== b.regions.length) return false;
  for (let i = 0; i < a.tracks.length; i++) {
    const x = a.tracks[i];
    const y = b.tracks[i];
    if (!x || !y || !sameTrackFields(x, y)) return false;
  }
  const byId = new Map(b.regions.map((r) => [r.id, r]));
  for (const region of a.regions) {
    const other = byId.get(region.id);
    if (!other || !sameRegion(region, other)) return false;
  }
  return true;
}

/** The lineage on a region, for the inspector and for the persistence layer. */
export function lineageOf(region: SessionRegion | null): RegionLineage | null {
  return region?.lineage ?? null;
}

/** The seconds of the source a region is sounding, re-exported so callers need one import. */
export { soundingSpan };
