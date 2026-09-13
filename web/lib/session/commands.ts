// The chat as a command line.
//
// The direction document's rule for the layout is that neither half is the
// real interface: everything the panels do by mouse can be said in a sentence,
// and whatever the sentence does shows up on the control the mouse would have
// used. This is the sentence half for the transport and the rack.
//
// It is deliberately narrow. A sentence only becomes a command when it is
// unmistakably one — "solo the drums", "loop bars 9 to 16", "next candidate".
// Anything else returns null and goes to the model as it always did, because
// swallowing "why do these drums sound muddy" as a mute command would be worse
// than having no command line at all. Every command names a control that
// exists on screen, and the caller moves that control, so the two halves can
// never disagree about what happened.

import { snapUnitFrom, type SnapUnit } from "./snap";
import type { SessionTrack } from "./types";

export type SessionCommand =
  | { kind: "play" }
  | { kind: "pause" }
  | { kind: "stop" }
  | { kind: "loop-off" }
  | { kind: "loop-bars"; fromBar: number; toBar: number }
  | { kind: "loop-seconds"; fromS: number; toS: number }
  | { kind: "mute"; target: string; on: boolean }
  | { kind: "solo"; target: string; on: boolean }
  | { kind: "gain"; target: string; db: number }
  | { kind: "audition"; index: number }
  | { kind: "audition-next" }
  | { kind: "audition-previous" }
  | { kind: "audition-off" }
  | { kind: "commit" }
  | { kind: "rack"; query: string }
  | { kind: "rack-fits" }
  | { kind: "rack-loops" }
  | { kind: "panel"; action: "close" | "back" }
  // --- the song: everything the mouse does on the timeline ---
  | { kind: "song" }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "snap"; unit: SnapUnit }
  | { kind: "zoom"; direction: "in" | "out" | "fit" }
  | { kind: "move-region"; target: string; toBar: number | null; toS: number | null }
  | { kind: "trim-region"; target: string; bars: number | null; seconds: number | null }
  | { kind: "duplicate-region"; target: string }
  | { kind: "split-region"; target: string; atBar: number | null }
  | { kind: "delete-region"; target: string }
  | { kind: "remove-track"; target: string };

/** Every lane, rather than one: "unmute everything", "drop all the levels". */
export const ALL_TRACKS = "*";

/**
 * The region the producer has selected on the timeline, rather than one named
 * by a lane. "move it to bar 17" moves what is selected; "move the drums to
 * bar 17" names a lane and only works when that lane has one region or the
 * selection is already on it. The shell resolves it and says which it used.
 */
export const SELECTION = "~selection";

const ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?]+$/g, "").replace(/\s+/g, " ");
}

function indexFrom(word: string): number | null {
  const asNumber = Number(word.replace(/(st|nd|rd|th)$/, ""));
  if (Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= 99) return asNumber;
  const named = ORDINALS[word];
  return named ?? null;
}

/**
 * A command, or null when the sentence is a question for the model. Only
 * whole-sentence matches count: "solo the drums" is a command, "can you solo
 * the drums and tell me why they are quiet" is a conversation.
 */
export function parseSessionCommand(text: string): SessionCommand | null {
  const s = normalise(text);
  if (s === "") return null;

  // --- transport ---
  if (/^(play|start|go|hit play|play it|play that|roll)$/.test(s)) return { kind: "play" };
  if (/^(pause|hold|pause it)$/.test(s)) return { kind: "pause" };
  if (/^(stop|stop it|kill it|halt)$/.test(s)) return { kind: "stop" };

  // --- locators ---
  if (/^(loop off|no loop|turn (the )?loop off|stop looping|unloop)$/.test(s)) return { kind: "loop-off" };
  const bars = /^loop (?:from )?bars? (\d{1,3}) (?:to|-|through|thru) (\d{1,3})$/.exec(s);
  if (bars) {
    const fromBar = Number(bars[1]);
    const toBar = Number(bars[2]);
    if (toBar > fromBar) return { kind: "loop-bars", fromBar, toBar };
    return null;
  }
  const firstBars = /^loop the (?:first|next) (\d{1,3}) bars$/.exec(s);
  if (firstBars) return { kind: "loop-bars", fromBar: 1, toBar: 1 + Number(firstBars[1]) };
  const seconds = /^loop (?:from )?(\d{1,4}(?:\.\d+)?) ?s? (?:to|-|through|thru) (\d{1,4}(?:\.\d+)?) ?s?$/.exec(s);
  if (seconds) {
    const fromS = Number(seconds[1]);
    const toS = Number(seconds[2]);
    if (toS > fromS) return { kind: "loop-seconds", fromS, toS };
    return null;
  }

  // --- the mix ---
  const mute = /^(un)?mute (?:the )?(.+)$/.exec(s);
  if (mute) {
    const target = targetOf(mute[2] as string);
    if (target) return { kind: "mute", target, on: mute[1] === undefined };
  }
  const solo = /^(un)?solo (?:the )?(.+)$/.exec(s);
  if (solo) {
    const target = targetOf(solo[2] as string);
    if (target) return { kind: "solo", target, on: solo[1] === undefined };
  }
  // "turn the drums down", or a level with a number on it. Not a bare
  // "<anything> up", which would make a command out of "what's up".
  const level = /^turn (?:the )?(.+?) (up|down)(?: (\d{1,2}(?:\.\d+)?) ?db)?$/.exec(s) ?? /^(?:the )?(.+?) (up|down) (\d{1,2}(?:\.\d+)?) ?db$/.exec(s);
  if (level) {
    const target = targetOf(level[1] as string);
    if (target) {
      const step = level[3] === undefined ? 3 : Number(level[3]);
      return { kind: "gain", target, db: level[2] === "up" ? step : -step };
    }
  }

  // --- the rack ---
  if (/^(next|try the next( one)?|next candidate|next one)$/.test(s)) return { kind: "audition-next" };
  if (/^(previous|back one|previous candidate|the one before( that)?)$/.test(s)) return { kind: "audition-previous" };
  if (/^(stop auditioning|drop the audition|clear the audition)$/.test(s)) return { kind: "audition-off" };
  const nth = /^(?:play|audition|try|hear) (?:the )?([a-z0-9]+)(?: one)?(?: under(?:neath)? (?:this|it|the session|the song))?$/.exec(s);
  if (nth) {
    const index = indexFrom(nth[1] as string);
    if (index !== null) return { kind: "audition", index };
  }
  if (/^(keep it|keep that|commit( it| that)?|add it to the session|use that one|use this one|that one)$/.test(s)) return { kind: "commit" };
  if (/^(hear|rack|play) what fits (this|it)$/.test(s)) return { kind: "rack-fits" };
  if (/^(hear|rack|play) the loops( here| in this)?$/.test(s)) return { kind: "rack-loops" };
  // "rack drums", "hear 90 bpm breaks": the crate, as rows you can play. Kept to
  // an explicit verb so "find me the loop under the hook" still reaches the model.
  const asRack = /^(?:rack|hear) (?:me )?(?:some )?(.{2,48})$/.exec(s);
  if (asRack) {
    const query = (asRack[1] as string).replace(/\b(please|in the crate|from the crate)\b/g, "").trim();
    if (query !== "" && !/\b(what|why|how|who|when|and|because)\b/.test(query)) return { kind: "rack", query };
  }

  // --- the song ---
  // Everything the mouse does on the timeline has a sentence here, and the
  // sentence moves the same control: `move-region` runs the same `moveRegion`
  // a drag runs, on the same grid, so the two cannot land in different places.
  if (/^(show|open) (the )?(song|timeline|arrangement)$/.test(s)) return { kind: "song" };
  if (/^(undo|undo that|undo it|take that back)$/.test(s)) return { kind: "undo" };
  if (/^(redo|redo that|put it back)$/.test(s)) return { kind: "redo" };
  if (/^zoom in$/.test(s)) return { kind: "zoom", direction: "in" };
  if (/^zoom out$/.test(s)) return { kind: "zoom", direction: "out" };
  if (/^(zoom to fit|fit the song|fit the whole song|show the whole song)$/.test(s)) return { kind: "zoom", direction: "fit" };
  const snapTo = /^snap (?:to )?([a-z0-9/]{2,12})$/.exec(s);
  if (snapTo) {
    const unit = snapUnitFrom(snapTo[1] as string);
    if (unit) return { kind: "snap", unit };
  }
  if (/^(no snap|snapping off|turn snapping off|free placement)$/.test(s)) return { kind: "snap", unit: "off" };

  const moveBar = /^(?:move|put|drag|slide) (?:the )?(.+?) (?:to|at|onto) bar (\d{1,3})$/.exec(s);
  if (moveBar) {
    const target = regionTargetOf(moveBar[1] as string);
    if (target) return { kind: "move-region", target, toBar: Number(moveBar[2]), toS: null };
  }
  const moveSeconds = /^(?:move|put|drag|slide) (?:the )?(.+?) (?:to|at) (\d{1,4}(?:\.\d+)?) ?s(?:ec|ecs|econds)?$/.exec(s);
  if (moveSeconds) {
    const target = regionTargetOf(moveSeconds[1] as string);
    if (target) return { kind: "move-region", target, toBar: null, toS: Number(moveSeconds[2]) };
  }
  const trimBars = /^(?:trim|make|cut) (?:the )?(.+?) (?:to |down to )?(\d{1,3}) bars?(?: long)?$/.exec(s);
  if (trimBars) {
    const target = regionTargetOf(trimBars[1] as string);
    if (target) return { kind: "trim-region", target, bars: Number(trimBars[2]), seconds: null };
  }
  const trimSeconds = /^(?:trim|make|cut) (?:the )?(.+?) (?:to |down to )?(\d{1,4}(?:\.\d+)?) ?s(?:ec|ecs|econds)?(?: long)?$/.exec(s);
  if (trimSeconds) {
    const target = regionTargetOf(trimSeconds[1] as string);
    if (target) return { kind: "trim-region", target, bars: null, seconds: Number(trimSeconds[2]) };
  }
  const duplicate = /^(?:duplicate|copy|repeat) (?:the )?(.+)$/.exec(s);
  if (duplicate) {
    const target = regionTargetOf(duplicate[1] as string);
    if (target) return { kind: "duplicate-region", target };
  }
  const splitAt = /^split (?:the )?(.+?) (?:at|on) bar (\d{1,3})$/.exec(s);
  if (splitAt) {
    const target = regionTargetOf(splitAt[1] as string);
    if (target) return { kind: "split-region", target, atBar: Number(splitAt[2]) };
  }
  const split = /^split (?:the )?(.+?)(?: here| at the playhead)?$/.exec(s);
  if (split) {
    const target = regionTargetOf(split[1] as string);
    if (target) return { kind: "split-region", target, atBar: null };
  }
  const remove = /^(?:delete|remove) (?:the )?(.+)$/.exec(s) ?? /^take (?:the )?(.+?) out$/.exec(s);
  if (remove) {
    const target = regionTargetOf(remove[1] as string);
    // A pronoun means the region under the producer's hand; a name means the
    // whole lane, because that is the control the name is written on.
    if (target === SELECTION) return { kind: "delete-region", target };
    if (target) return { kind: "remove-track", target };
  }

  // --- the panel ---
  if (/^(close the panel|hide the panel|dismiss the panel|full width)$/.test(s)) return { kind: "panel", action: "close" };
  if (/^(go back|back|previous surface)$/.test(s)) return { kind: "panel", action: "back" };

  return null;
}

/** The words a producer uses for "the thing I am pointing at". */
const PRONOUNS = /^(it|this|that|this one|that one|the region|this region|that region|the selection|the selected region|the clip)$/;

/**
 * Which region or lane a sentence names. Stricter than `targetOf`, because
 * these verbs are destructive: "remove the vocals from this record" is a
 * separation request and has to reach the model intact, so a target with a
 * preposition in it is not a target.
 */
function regionTargetOf(raw: string): string | null {
  const name = raw.trim();
  if (PRONOUNS.test(name)) return SELECTION;
  if (/\b(from|into|out of|with|for|like|than|about|instead)\b/.test(name)) return null;
  return targetOf(name);
}

/**
 * The lane a sentence names, or null when the sentence has more in it than a
 * name. "solo the drums" is a command; "solo the drums and tell me why they
 * are quiet" is a question, and a question must reach the model intact.
 */
function targetOf(raw: string): string | null {
  const name = raw.trim().replace(/^(track|lane|stem) /, "").replace(/ (track|lane|stem)$/, "");
  if (name === "" || name.split(" ").length > 4) return null;
  if (/\b(and|then|but|because|so|why|how|what|if|when)\b/.test(name)) return null;
  if (/^(everything|all|all of it|all tracks|the session|the lot)$/.test(name)) return ALL_TRACKS;
  return name;
}

/**
 * Which lane a spoken name refers to. Exact name first, then a word inside it
 * ("drums" finding "Masquerade drums"), then the provenance line. Null when
 * nothing matches, so the caller can say so instead of guessing a lane.
 */
export function resolveTarget(target: string, tracks: readonly SessionTrack[]): string[] | null {
  if (target === ALL_TRACKS) return tracks.map((t) => t.id);
  const needle = target.trim().toLowerCase();
  if (needle === "") return null;
  const exact = tracks.filter((t) => t.name.toLowerCase() === needle);
  if (exact.length > 0) return exact.map((t) => t.id);
  const partial = tracks.filter((t) => t.name.toLowerCase().includes(needle));
  if (partial.length > 0) return partial.map((t) => t.id);
  const byProvenance = tracks.filter((t) => (t.provenance ?? "").toLowerCase().includes(needle));
  if (byProvenance.length > 0) return byProvenance.map((t) => t.id);
  return null;
}

/**
 * Which region an arrangement verb is about.
 *
 * The rule is the one the direction document asks for: the sentence moves the
 * same control the mouse does, which is one region. A pronoun means the
 * selection. A lane's name means that lane's region when it has exactly one,
 * or the selection when the selection is already on it. Anything else is
 * ambiguous, and an ambiguous destructive edit is answered with a question
 * rather than a guess.
 */
export interface RegionTarget {
  regionId: string | null;
  /** why there is no region, in the words the panel uses */
  note: string | null;
}

export function resolveRegionTarget(
  target: string,
  tracks: readonly SessionTrack[],
  regions: readonly { id: string; trackId: string }[],
  selectedRegionId: string | null,
): RegionTarget {
  if (target === SELECTION) {
    if (selectedRegionId && regions.some((r) => r.id === selectedRegionId)) return { regionId: selectedRegionId, note: null };
    return { regionId: null, note: "nothing is selected on the timeline, so there is no region to change. Click one, or name the lane." };
  }
  const trackIds = resolveTarget(target, tracks);
  if (!trackIds || trackIds.length === 0) return { regionId: null, note: `nothing in the session is called ${target}.` };
  const ids = new Set(trackIds);
  const onLane = regions.filter((r) => ids.has(r.trackId));
  if (onLane.length === 0) return { regionId: null, note: `${target} has nothing on it yet.` };
  if (onLane.length === 1) return { regionId: onLane[0]?.id ?? null, note: null };
  if (selectedRegionId && onLane.some((r) => r.id === selectedRegionId)) return { regionId: selectedRegionId, note: null };
  return { regionId: null, note: `${target} has ${onLane.length} regions. Click the one you mean, then say it again.` };
}

/** What the command did, in one line, for the log under the composer. */
export function describeCommand(command: SessionCommand): string {
  switch (command.kind) {
    case "play":
      return "playing";
    case "pause":
      return "paused";
    case "stop":
      return "stopped";
    case "loop-off":
      return "loop off";
    case "loop-bars":
      return `looping bars ${command.fromBar}–${command.toBar}`;
    case "loop-seconds":
      return `looping ${command.fromS}s–${command.toS}s`;
    case "mute":
      return `${command.on ? "muted" : "unmuted"} ${name(command.target)}`;
    case "solo":
      return `${command.on ? "soloed" : "unsoloed"} ${name(command.target)}`;
    case "gain":
      return `${name(command.target)} ${command.db > 0 ? "up" : "down"} ${Math.abs(command.db)} dB`;
    case "audition":
      return `auditioning candidate ${command.index}`;
    case "audition-next":
      return "next candidate";
    case "audition-previous":
      return "previous candidate";
    case "audition-off":
      return "audition cleared";
    case "commit":
      return "committed to the session";
    case "rack":
      return `racking “${command.query}”`;
    case "rack-fits":
      return "racking what fits this";
    case "rack-loops":
      return "racking the loops in this file";
    case "panel":
      return command.action === "close" ? "panel closed" : "back";
    case "song":
      return "the song";
    case "undo":
      return "undone";
    case "redo":
      return "redone";
    case "snap":
      return command.unit === "off" ? "snapping off" : `snapping to ${snapWord(command.unit)}`;
    case "zoom":
      return command.direction === "fit" ? "fitted the whole song" : `zoomed ${command.direction}`;
    case "move-region":
      return command.toBar !== null ? `moved ${name(command.target)} to bar ${command.toBar}` : `moved ${name(command.target)} to ${command.toS}s`;
    case "trim-region":
      return command.bars !== null ? `trimmed ${name(command.target)} to ${command.bars} ${command.bars === 1 ? "bar" : "bars"}` : `trimmed ${name(command.target)} to ${command.seconds}s`;
    case "duplicate-region":
      return `duplicated ${name(command.target)}`;
    case "split-region":
      return command.atBar !== null ? `split ${name(command.target)} at bar ${command.atBar}` : `split ${name(command.target)} at the playhead`;
    case "delete-region":
      return "region deleted";
    case "remove-track":
      return `took ${name(command.target)} out of the session`;
  }
}

function snapWord(unit: SnapUnit): string {
  switch (unit) {
    case "bar":
      return "bars";
    case "beat":
      return "beats";
    case "eighth":
      return "eighths";
    case "sixteenth":
      return "sixteenths";
    case "off":
      return "nothing";
  }
}

function name(target: string): string {
  return target === ALL_TRACKS ? "everything" : target === SELECTION ? "the region" : target;
}
