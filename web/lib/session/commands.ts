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

import type { EqPhrase, SpectralRegion } from "@/lib/processing/types";
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
  | { kind: "remove-track"; target: string }
  // --- corrective processing: everything the EQ panel does ---
  | { kind: "processing"; target: string }
  /** the A/B. `on` null means toggle, which is what "a/b the drums" means. */
  | { kind: "processing-bypass"; target: string; on: boolean | null }
  | { kind: "processing-reset"; target: string }
  /** a complaint in the producer's own words; the curve is decided in lib/processing */
  | { kind: "fix"; target: string; complaint: string }
  | { kind: "eq"; target: string; phrase: EqPhrase }
  | { kind: "tune"; target: string; cents: number }
  | { kind: "limiter"; on: boolean };

/** Every lane, rather than one: "unmute everything", "drop all the levels". */
export const ALL_TRACKS = "*";

/**
 * The region the producer has selected on the timeline, rather than one named
 * by a lane. "move it to bar 17" moves what is selected; "move the drums to
 * bar 17" names a lane and only works when that lane has one region or the
 * selection is already on it. The shell resolves it and says which it used.
 *
 * The processing verbs use the same constant for the same reason, one level up:
 * "bypass the eq" with no lane named means the lane the producer is working on
 * — the one open in the processing dock, or the lane of the selected region.
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

/** The words a producer uses for a region of the spectrum, and which one they mean. */
const REGION_WORDS: ReadonlyArray<readonly [RegExp, SpectralRegion]> = [
  [/^(low mids?|lower mids?|low[- ]mid)$/, "low mids"],
  [/^(high mids?|upper mids?|presence)$/, "high mids"],
  [/^(lows?|low end|bottom|bass)$/, "lows"],
  [/^(mids?|middle|midrange)$/, "mids"],
  [/^(highs?|top|top end|treble)$/, "highs"],
  [/^(air|sparkle)$/, "air"],
];

/** "300", "300hz", "4k", "1.2khz" -> Hz. Null when it is not a frequency at all. */
function hzFrom(token: string): number | null {
  const match = /^(\d{1,5}(?:\.\d+)?) ?(k|khz|hz)?$/.exec(token.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const unit = match[2];
  const hz = unit === "k" || unit === "khz" ? value * 1000 : value;
  return hz >= 20 && hz <= 20000 ? hz : null;
}

/**
 * "cut 300", "boost the highs", "dip 1.2k by 3db" as a phrase. Null when the
 * thing being cut is not a frequency or a part of the spectrum — "cut the drums
 * to 4 bars" is an arrangement trim and has to fall through to it.
 */
function phraseFor(verb: string, what: string, db: string | undefined): EqPhrase | null {
  const move = verb === "cut" || verb === "dip" ? "cut" : "boost";
  const amount = db === undefined ? null : Number(db);
  const hz = hzFrom(what);
  if (hz !== null) return { move, atHz: hz, region: null, db: amount };
  const name = what.trim();
  for (const [pattern, region] of REGION_WORDS) {
    if (pattern.test(name)) return { move, atHz: null, region, db: amount };
  }
  return null;
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

  // --- corrective processing (lib/processing) ---
  // The same rule as everything else here: a sentence only becomes a command
  // when it is unmistakably one. "the horns are too harsh" is; "why do these
  // drums sound muddy" is a question and reaches the model untouched. Nothing
  // in this block decides what a complaint means — that is complaints.ts — and
  // nothing here decides a frequency; the command names the control and the
  // shell moves it.
  const showChain = /^(?:show|open) (?:the )?(?:eq|processing|chain|filters?)(?: on (?:the )?(.+))?$/.exec(s);
  if (showChain) {
    const target = showChain[1] === undefined ? SELECTION : targetOf(showChain[1]);
    if (target) return { kind: "processing", target };
  }
  const resetChain = /^(?:reset|clear|remove|take off) (?:the )?(?:eq|processing|chain|filters?)(?: on (?:the )?(.+))?$/.exec(s);
  if (resetChain) {
    const target = resetChain[1] === undefined ? SELECTION : targetOf(resetChain[1]);
    if (target) return { kind: "processing-reset", target };
  }
  const compare = /^(?:a\/b|ab|compare)(?: the (?:eq|processing|chain))?(?: on)? (?:the )?(.+)$/.exec(s);
  if (compare) {
    const target = targetOf(compare[1] as string);
    if (target) return { kind: "processing-bypass", target, on: null };
  }
  if (/^(?:a\/b|ab|compare)(?: the (?:eq|processing|chain))?$/.test(s)) return { kind: "processing-bypass", target: SELECTION, on: null };
  const bypass = /^(bypass|un-?bypass|engage) (?:the (?:eq|processing|chain) on )?(?:the )?(.+)$/.exec(s);
  if (bypass) {
    const target = targetOf(bypass[2] as string);
    if (target) return { kind: "processing-bypass", target, on: bypass[1] === "bypass" };
  }
  const bypassHere = /^(bypass|un-?bypass|engage)(?: the (?:eq|processing|chain))$/.exec(s);
  if (bypassHere) return { kind: "processing-bypass", target: SELECTION, on: bypassHere[1] === "bypass" };

  if (/^(limit(?:er)? (?:the )?(?:master|mix|bus)|limiter on|turn the limiter on)$/.test(s)) return { kind: "limiter", on: true };
  if (/^(limiter off|turn the limiter off|stop limiting|no limiter)$/.test(s)) return { kind: "limiter", on: false };

  const eq = /^(cut|dip|boost|lift) (?:the )?([a-z0-9.+ ]+?)(?: by (\d{1,2}(?:\.\d+)?) ?db)?(?: on (?:the )?(.+))?$/.exec(s);
  if (eq) {
    const phrase = phraseFor(eq[1] as string, eq[2] as string, eq[3]);
    if (phrase) {
      const target = eq[4] === undefined ? SELECTION : targetOf(eq[4]);
      if (target) return { kind: "eq", target, phrase };
    }
  }
  const passFilter = /^(?:(high|low)[- ]?pass|(hpf|lpf)) (?:the )?(.+?) (?:at|to) ([a-z0-9.]+)$/.exec(s);
  if (passFilter) {
    const hz = hzFrom(passFilter[4] as string);
    const high = passFilter[1] === "high" || passFilter[2] === "hpf";
    if (hz !== null) {
      const target = targetOf(passFilter[3] as string);
      if (target) return { kind: "eq", target, phrase: { move: high ? "highpass" : "lowpass", atHz: hz, region: null, db: null } };
    }
  }

  const tune = /^tune (?:the )?(.+?) (up|down) (\d{1,4}(?:\.\d+)?) ?(cents?|semitones?|st)$/.exec(s);
  if (tune) {
    const target = targetOf(tune[1] as string);
    const amount = Number(tune[3]);
    const cents = (tune[4] as string).startsWith("cent") ? amount : amount * 100;
    if (target && Number.isFinite(cents)) return { kind: "tune", target, cents: tune[2] === "down" ? -cents : cents };
  }

  // A complaint. The target is a lane; the complaint is the whole sentence, so
  // "a bit" and "way too" survive into the decision.
  const cleanUp = /^(?:clean|tidy) (?:up )?(?:the )?(.+?)(?: up)?$/.exec(s) ?? /^sort (?:out )?(?:the )?(.+?)(?: out)?$/.exec(s);
  if (cleanUp) {
    const target = targetOf(cleanUp[1] as string);
    if (target) return { kind: "fix", target, complaint: s };
  }
  // "this trumpet sounds awful, clean it up" — the owner's own sentence, and the
  // one the rest of this parser would refuse on principle because it has two
  // clauses in it. It is allowed through because a trailing "clean it up" is an
  // instruction however the sentence starts, but only when there is no question
  // word and no conjunction anywhere in it: "why does this sound bad, clean it
  // up" is still a question and still reaches the model whole.
  const trailing = /^.*\S,? (?:clean|sort) (?:it|this|that) (?:up|out)$/.exec(s);
  if (trailing && !/\b(what|why|how|who|when|which|and|because|but)\b/.test(s)) return { kind: "fix", target: SELECTION, complaint: s };
  if (/^fix (?:it|this|that)$/.test(s)) return { kind: "fix", target: SELECTION, complaint: "clean it up" };

  const makeIt = /^(?:make|get) (?:the )?(.+?) (less [a-z]+|more [a-z]+|[a-z]+er)$/.exec(s);
  if (makeIt) {
    const target = targetOf(makeIt[1] as string);
    if (target) return { kind: "fix", target, complaint: `make it ${makeIt[2]}` };
  }
  const tooMuch = /^(?:the )?(.+?) (?:sounds?|is|are) (too [a-z]+|muddy|boomy|harsh|dull|muffled|sibilant|boxy|honky|thin)$/.exec(s);
  if (tooMuch) {
    const target = targetOf(tooMuch[1] as string);
    if (target) return { kind: "fix", target, complaint: `${tooMuch[1]} is ${tooMuch[2]}` };
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
    case "processing":
      return `the chain on ${name(command.target)}`;
    case "processing-bypass":
      return command.on === null ? `A/B on ${name(command.target)}` : `${command.on ? "bypassed" : "engaged"} the chain on ${name(command.target)}`;
    case "processing-reset":
      return `cleared the chain on ${name(command.target)}`;
    case "fix":
      return `working on ${name(command.target)}`;
    case "eq":
      return `${command.phrase.move === "cut" ? "cut" : "boost"} on ${name(command.target)}`;
    case "tune":
      return `tuned ${name(command.target)} ${command.cents > 0 ? "up" : "down"} ${Math.abs(Math.round(command.cents))} cents`;
    case "limiter":
      return command.on ? "limiter on the master" : "limiter off";
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
