// What an edit means for audio that is already scheduled.
//
// The engine schedules 250 ms ahead of the playhead. By the time a producer
// lets go of a region, some of what they just changed may already be in the
// audio thread's hands with an absolute start time on it. Handing the engine a
// new arrangement without thinking about that is how a timeline stutters: the
// whole session stops and restarts, or a moved region plays twice, once from
// where it was and once from where it now is.
//
// The engine already has the right primitive. `setTrackRegions` stops one lane,
// drops that lane's scheduling keys, swaps its material and re-plans
// immediately; everything else keeps playing and the new material joins at the
// point in the bar the transport is already on. It is the rack's A/B, and it is
// tested. So reconciliation is not about inventing a mechanism, it is about
// using the smallest number of them:
//
//   Lanes whose material did not change are never handed anything. Dragging a
//   region on the drums lane cannot interrupt the bass, because the bass is not
//   in the plan at all.
//
//   Mute, solo, level and lane order go through `patchTrack` / `setTracks`,
//   which move gain nodes and lists and stop nothing. Those edits are inaudible
//   as edits, which is what makes muting musical.
//
//   A lane that *is* handed new material and has something sounding will be
//   interrupted — that is what stopping the lane means. The plan says so, names
//   the regions that were only bystanders, and the UI can report it honestly
//   rather than the producer wondering what the click was.
//
// All of it is arithmetic over two snapshots, so the case that matters — an
// edit landing inside the lookahead window — is asserted in node at exact
// times rather than hunted for by ear.

import { sameRegion, sameTrackFields, type Arrangement } from "./arrangement";
import { regionEnd } from "./schedule";
import { LOOKAHEAD_S, type SessionRegion, type SessionTrack, type TransportLoop } from "./types";

/** Where the transport is when the edit lands. */
export interface FlightContext {
  playing: boolean;
  /** the playhead, session seconds */
  positionS: number;
  /** how far ahead the engine has scheduled; defaults to the engine's own lookahead */
  lookaheadS?: number;
  loop?: TransportLoop | null;
}

export interface LaneUpdate {
  trackId: string;
  regions: SessionRegion[];
  /**
   * True when this lane has audio in flight and handing it new material will
   * stop and re-join it. False when the lane is silent right now, in which
   * case the edit is inaudible.
   */
  interrupts: boolean;
  /**
   * Regions on this lane that were in flight and did *not* change — the ones
   * that are interrupted only because the engine's smallest unit of
   * replacement is a lane. They re-join in progress at the right sample; the
   * cost is the 2 ms declick, not a restart. Named so the handoff can be exact
   * and so a future engine change can be measured against it.
   */
  bystanders: string[];
}

export interface ReconcilePlan {
  /** hand this to `engine.setTracks` when the lane list changed at all */
  tracks: SessionTrack[] | null;
  /** lanes whose material changed, in the order they should be handed over */
  lanes: LaneUpdate[];
  /** lanes that went away */
  removed: string[];
  /** lanes that arrived */
  added: string[];
  /** true when at least one lane update interrupts something that is sounding */
  interrupts: boolean;
  /** nothing to do */
  empty: boolean;
}

export const NOTHING_TO_DO: ReconcilePlan = { tracks: null, lanes: [], removed: [], added: [], interrupts: false, empty: true };

/**
 * The windows of session time whose audio is already scheduled: from the
 * playhead to the lookahead horizon, wrapping at the end locator when the
 * transport is looping (the pass after the wrap is planned from the start
 * locator, so a region at the top of the loop is in flight even though the
 * playhead is at the bottom of it).
 */
export function flightWindows(flight: FlightContext): Array<[number, number]> {
  if (!flight.playing) return [];
  const look = flight.lookaheadS ?? LOOKAHEAD_S;
  const from = flight.positionS;
  const to = from + Math.max(0, look);
  const loop = flight.loop ?? null;
  if (!loop || !(loop.endS - loop.startS > 0) || from >= loop.endS) return [[from, to]];
  if (to <= loop.endS) return [[from, to]];
  const spill = to - loop.endS;
  const length = loop.endS - loop.startS;
  return [
    [from, loop.endS],
    [loop.startS, loop.startS + Math.min(spill, length)],
  ];
}

/** Region ids whose audio is sounding now or is already scheduled to. */
export function inFlight(regions: readonly SessionRegion[], flight: FlightContext): string[] {
  const windows = flightWindows(flight);
  if (windows.length === 0) return [];
  const out: string[] = [];
  for (const region of regions) {
    const from = region.startS;
    const to = regionEnd(region);
    if (windows.some(([wFrom, wTo]) => from < wTo - 1e-9 && to > wFrom + 1e-9)) out.push(region.id);
  }
  return out;
}

/** Does this edit touch audio the engine has already handed to the audio thread? */
export function touchesFlight(previous: Arrangement, next: Arrangement, flight: FlightContext): boolean {
  const changed = new Set(changedRegionIds(previous, next));
  if (changed.size === 0) return false;
  const scheduled = new Set([...inFlight(previous.regions, flight), ...inFlight(next.regions, flight)]);
  for (const id of changed) if (scheduled.has(id)) return true;
  return false;
}

/** Ids that were added, removed, or moved in any way. */
export function changedRegionIds(previous: Arrangement, next: Arrangement): string[] {
  const before = new Map(previous.regions.map((r) => [r.id, r]));
  const after = new Map(next.regions.map((r) => [r.id, r]));
  const ids = new Set<string>();
  for (const [id, region] of before) {
    const now = after.get(id);
    if (!now || !sameRegion(region, now)) ids.add(id);
  }
  for (const [id, region] of after) {
    const was = before.get(id);
    if (!was || !sameRegion(was, region)) ids.add(id);
  }
  return [...ids];
}

function byTrack(regions: readonly SessionRegion[]): Map<string, SessionRegion[]> {
  const out = new Map<string, SessionRegion[]>();
  for (const region of regions) {
    const list = out.get(region.trackId);
    if (list) list.push(region);
    else out.set(region.trackId, [region]);
  }
  return out;
}

function laneChanged(before: readonly SessionRegion[], after: readonly SessionRegion[]): boolean {
  if (before.length !== after.length) return true;
  const was = new Map(before.map((r) => [r.id, r]));
  for (const region of after) {
    const previous = was.get(region.id);
    if (!previous || !sameRegion(previous, region)) return true;
  }
  return false;
}

function tracksChanged(before: readonly SessionTrack[], after: readonly SessionTrack[]): boolean {
  if (before.length !== after.length) return true;
  for (let i = 0; i < after.length; i++) {
    const a = before[i];
    const b = after[i];
    if (!a || !b || !sameTrackFields(a, b)) return true;
  }
  return false;
}

/**
 * The smallest set of engine calls that turns `previous` into `next`.
 *
 * The plan is data, not effects, so the decision of what to interrupt is
 * asserted in tests and the provider that applies it stays three lines long.
 */
export function planReconcile(previous: Arrangement, next: Arrangement, flight: FlightContext): ReconcilePlan {
  const beforeLanes = byTrack(previous.regions);
  const afterLanes = byTrack(next.regions);
  const beforeIds = new Set(previous.tracks.map((t) => t.id));
  const afterIds = new Set(next.tracks.map((t) => t.id));

  const removed = previous.tracks.filter((t) => !afterIds.has(t.id)).map((t) => t.id);
  const added = next.tracks.filter((t) => !beforeIds.has(t.id)).map((t) => t.id);
  const trackListChanged = tracksChanged(previous.tracks, next.tracks);

  const lanes: LaneUpdate[] = [];
  for (const track of next.tracks) {
    const before = beforeLanes.get(track.id) ?? [];
    const after = afterLanes.get(track.id) ?? [];
    if (!laneChanged(before, after)) continue;
    // Removing a lane already stops it; a lane that is gone needs no material.
    const sounding = new Set(inFlight(before, flight));
    const changed = new Set(changedRegionIds({ tracks: [], regions: before }, { tracks: [], regions: after }));
    const bystanders = [...sounding].filter((id) => !changed.has(id));
    lanes.push({ trackId: track.id, regions: after, interrupts: sounding.size > 0, bystanders });
  }

  const interrupts = lanes.some((l) => l.interrupts);
  const empty = !trackListChanged && lanes.length === 0;
  return { tracks: trackListChanged ? next.tracks : null, lanes, removed, added, interrupts, empty };
}

/** One line for the echo: what the edit is about to disturb, if anything. */
export function describeReconcile(plan: ReconcilePlan): string {
  if (plan.empty) return "nothing changed";
  const lanes = plan.lanes.length;
  if (!plan.interrupts) return lanes === 0 ? "lanes updated" : `${lanes} ${lanes === 1 ? "lane" : "lanes"} updated, nothing interrupted`;
  const bystanders = plan.lanes.reduce((n, l) => n + l.bystanders.length, 0);
  const head = `${lanes} ${lanes === 1 ? "lane" : "lanes"} re-scheduled under the playhead`;
  return bystanders === 0 ? head : `${head}; ${bystanders} region${bystanders === 1 ? "" : "s"} re-joined in progress`;
}
