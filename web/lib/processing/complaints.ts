// A producer's words, turned into a curve, with no round trip.
//
// The product already works this way everywhere else: the chat is a command
// line, it parses first and asks the model second, and the narrow half is the
// half that answers instantly and can never be wrong about what it did
// (lib/session/commands.ts). This is the narrow half for processing. "Make the
// horns less muddy" is unmistakable, so it does not need a model to become a
// -4 dB dip at 250 Hz — and because it comes back through `applyProposal` like
// everything else, the curve it produces is the same visible, draggable curve
// the model's answer produces.
//
// Everything in the table below is a *starting point*, and the confidences say
// so. There is no measurement anywhere in this file that says a particular
// record is muddy; what there is, is the frequency a producer reaches for when
// they say the word. That is the honest claim, it is what the hedge word is
// carrying, and the curve is editable precisely because the number will
// sometimes be wrong.

import type { ProcessingMove, ProcessingProposal } from "./moves";
import { type BandId, type EqPhrase, REGION_BAND, REGION_HZ } from "./types";

export interface ComplaintEntry {
  /** the canonical word, for the vocabulary list a refusal offers back */
  term: string;
  /** every way a producer says it */
  match: RegExp;
  /** what the move is for, in one clause. The hedge word is added by `summarise`. */
  summary: string;
  confidence: number;
  moves: (scale: number) => ProcessingMove[];
}

const band = (id: BandId, frequency: number, gainDb: number, q: number, why: string): ProcessingMove => ({ op: "band", band: id, frequency, gainDb, q, enabled: true, why });
const pass = (id: "hp" | "lp", frequency: number, why: string): ProcessingMove => ({ op: "band", band: id, frequency, enabled: true, why });

/**
 * The vocabulary. Ordered: the first entry that matches wins, so the specific
 * words ("sibilant") sit above the general ones ("harsh").
 */
export const COMPLAINTS: readonly ComplaintEntry[] = [
  {
    term: "rumbly",
    match: /\b(rumble|rumbly|rumbling|subsonic|hum|low end noise)\b/,
    summary: "clearing what is under the instrument",
    confidence: 0.7,
    moves: (s) => [pass("hp", Math.round(70 + 20 * s), "a separator leaves low-frequency mush under a part that never had any; a high-pass takes it out without touching the instrument")],
  },
  {
    term: "boomy",
    match: /\b(boomy|boom|bass[- ]heavy|too much (bass|low end|bottom)|heavy (on the )?(bottom|low end))\b/,
    summary: "taking weight off the bottom",
    confidence: 0.6,
    moves: (s) => [band("ls", 110, -4 * s, 0.707, "a shelf rather than a dip, because boom is the whole bottom end rather than one note"), pass("hp", 45, "and nothing useful lives under 45 Hz in a flip")],
  },
  {
    term: "muddy",
    match: /\b(muddy|mud|murky|cloudy|woolly|wooly|congested|clogged)\b/,
    summary: "the build-up in the low mids",
    confidence: 0.6,
    moves: (s) => [
      band("lo", 250, -4 * s, 1.2, "200-300 Hz is where two parts stacked on each other stop being two parts; a dip here is what lets a loop and a break share the same bar"),
      pass("hp", 60, "with the sub cleared so the dip is not fighting rumble"),
    ],
  },
  {
    term: "boxy",
    match: /\b(boxy|box|cardboard)\b/,
    summary: "the box around 400-500 Hz",
    confidence: 0.55,
    moves: (s) => [band("lo", 450, -4 * s, 1.4, "boxiness sits above mud and below honk, and wants a narrower dip than either")],
  },
  {
    term: "honky",
    match: /\b(honky|honk|nasal|nasally|quacky)\b/,
    summary: "the honk in the mids",
    confidence: 0.55,
    moves: (s) => [band("mid", 800, -4 * s, 1.6, "700-900 Hz is where a horn or a vocal that has been through a separator starts to shout")],
  },
  {
    term: "sibilant",
    match: /\b(sibilant|sibilance|essy|hissy|hiss|harsh esses)\b/,
    summary: "the esses",
    confidence: 0.5,
    moves: (s) => [band("hi", 7000, -4 * s, 3, "narrow and high: sibilance is a spike, not a region, so a wide cut would take the whole top with it")],
  },
  {
    term: "harsh",
    match: /\b(harsh|brittle|fizzy|piercing|shrill|spiky|edgy|abrasive|ear[- ]?piercing)\b/,
    summary: "the edge at 3 kHz",
    confidence: 0.55,
    moves: (s) => [band("hi", 3200, -3.5 * s, 1.4, "3 kHz is where the ear is most sensitive and where separation artefacts land hardest")],
  },
  {
    term: "dull",
    match: /\b(dull|muffled|muffed|dark|darker than|veiled|lifeless|no (air|top|sparkle)|closed|blanket)\b/,
    summary: "opening the top back up",
    confidence: 0.5,
    moves: (s) => [
      band("hs", 8000, 3.5 * s, 0.707, "separation takes air off the top; a shelf puts back the band it took rather than inventing a peak"),
      band("hi", 3500, 2 * s, 0.9, "with a little presence under it so the part comes forward as well as brightening"),
    ],
  },
  {
    term: "thin",
    match: /\b(thin|weak|weedy|tinny|small|no (body|weight)|lacks body)\b/,
    summary: "putting body back under it",
    confidence: 0.55,
    moves: (s) => [band("ls", 160, 3 * s, 0.707, "a low shelf adds weight across the bottom instead of a bump at one note")],
  },
  {
    term: "brighter",
    match: /\b(brighter|brightness|airier|more air|open it up|opened up|crisper)\b/,
    summary: "lifting the top",
    confidence: 0.6,
    moves: (s) => [band("hs", 8000, 3 * s, 0.707, "a shelf from 8 kHz is the air band, which is the part separation costs most")],
  },
  {
    term: "warmer",
    match: /\b(warmer|warmth|rounder)\b/,
    summary: "warming it up",
    confidence: 0.55,
    moves: (s) => [band("ls", 200, 2.5 * s, 0.707, "warmth is the low mids, not the sub")],
  },
  {
    term: "fuller",
    match: /\b(fuller|bigger|more (body|weight)|beefier)\b/,
    summary: "filling it out",
    confidence: 0.55,
    moves: (s) => [band("ls", 150, 3 * s, 0.707, "weight under the part, kept above the sub so it does not fight the kick")],
  },
  {
    term: "darker",
    match: /\b(darker|softer on top|take the top off|less bright)\b/,
    summary: "taking the top down",
    confidence: 0.55,
    moves: (s) => [band("hs", 6000, -3 * s, 0.707, "a shelf down from 6 kHz, so it sits behind whatever is in front of it")],
  },
  {
    term: "tighter",
    match: /\b(tighter|tighten (up )?the (low end|bottom)|flabby)\b/,
    summary: "tightening the bottom",
    confidence: 0.55,
    moves: () => [pass("hp", 70, "a high-pass is what tightens a bottom end; a dip only makes it quieter")],
  },
  {
    term: "loud",
    match: /\b(too loud|too hot|clipping|overloading|jumping out)\b/,
    summary: "levelling it",
    confidence: 0.7,
    moves: (s) => [{ op: "trim", db: -3 * s, why: "the trim before the filters, so the lane's fader is still free for the balance" }],
  },
  {
    term: "quiet",
    match: /\b(too quiet|too low|buried|can'?t hear it|disappears)\b/,
    summary: "bringing it up",
    confidence: 0.7,
    moves: (s) => [{ op: "trim", db: 3 * s, why: "the trim before the filters, so the lane's fader is still free for the balance" }],
  },
];

/** What a refusal offers back, so a producer knows the words that do work. */
export const COMPLAINT_WORDS = "muddy, boomy, rumbly, boxy, honky, harsh, sibilant, dull, thin, too loud, too quiet — or brighter, warmer, fuller, darker, tighter";

/** "clean it up" with nothing else said. The only entry that guesses, and it says so. */
const GENERIC = /\b(clean(ing)? (it |this |that )?up|clean up|sort (it|this|that) out|sounds? (awful|bad|rough|terrible)|rescue|salvage|make it work)\b/;

export interface ComplaintContext {
  /** where the source's real bandwidth ends; the guard in moves.ts uses it too */
  sourceCeilingHz?: number | null;
}

/**
 * How hard. A producer says "a bit" and "way too" and means it; taking the
 * words at face value is the difference between a move that lands and one that
 * has to be dragged back immediately.
 */
export function intensityOf(text: string): number {
  if (/\b(a bit|a little|slightly|a touch|a hair|gently|subtle)\b/.test(text)) return 0.6;
  if (/\b(way|really|very|far|super|massively|so much)\b/.test(text)) return 1.5;
  return 1;
}

/**
 * The complaint as moves, or null when these words name no problem this knows.
 * Null is the important return: it is what sends the sentence to the model
 * instead of guessing, which is the same rule the command line already follows.
 */
export function proposeForComplaint(complaint: string, context: ComplaintContext = {}): ProcessingProposal | null {
  const text = complaint.trim().toLowerCase();
  if (text === "") return null;
  const scale = intensityOf(text);
  const inverted = /\bmore\b/.test(text) && !/\bmore (air|body|weight)\b/.test(text);

  for (const entry of COMPLAINTS) {
    if (!entry.match.test(text)) continue;
    const quality = ["brighter", "warmer", "fuller", "darker", "tighter"].includes(entry.term);
    const sign = inverted && !quality ? -1 : 1;
    const moves = entry.moves(scale * sign).filter((move) => sign > 0 || move.op !== "band" || move.gainDb !== undefined);
    if (moves.length === 0) continue;
    return { moves, summary: entry.summary, confidence: entry.confidence, notes: [] };
  }

  if (GENERIC.test(text)) return genericClean(context);
  return null;
}

/**
 * "Clean it up", with nothing named. This is the owner's own sentence, so it
 * has to do something — but nothing measured this record and said it was
 * muddy, so the confidence is in the band that reads "roughly" and the note
 * says plainly that it is a starting point. The three moves are the ones that
 * are almost always right on separated material: the rumble a separator leaves
 * under the part, the low-mid build-up that stops two parts sharing a bar, and
 * the air the separation took off the top.
 */
export function genericClean(context: ComplaintContext = {}): ProcessingProposal {
  const moves: ProcessingMove[] = [
    { op: "band", band: "hp", frequency: 60, enabled: true, why: "separated material almost always has low-frequency mush under it that was never part of the instrument" },
    { op: "band", band: "lo", frequency: 250, gainDb: -3, q: 1.2, enabled: true, why: "the low mids are where a part stops sitting under a loop and starts fighting it" },
  ];
  const ceiling = context.sourceCeilingHz ?? null;
  if (ceiling === null || ceiling > 9000) {
    moves.push({ op: "band", band: "hs", frequency: 8000, gainDb: 2.5, q: 0.707, enabled: true, why: "and a shelf to put back some of the air separation took off" });
  }
  return {
    moves,
    summary: "a starting point for separated material",
    confidence: 0.4,
    notes: [
      ceiling !== null && ceiling <= 9000
        ? `the record stops at ${Math.round(ceiling)} Hz, so there is no air up there to put back; the top is left alone.`
        : "nothing measured this part and called it muddy — this is the shape that is usually right after separation, not a diagnosis.",
      `say what is wrong with it (${COMPLAINT_WORDS}) and the move is aimed rather than general.`,
    ],
  };
}

// --- an EQ move said out loud ------------------------------------------------

const DEFAULT_STEP_DB = 4;

/** Which slot a named frequency belongs to. Fixed thresholds, so a sentence always lands on the same control. */
export function bandForFrequency(hz: number): BandId {
  if (hz < 150) return "ls";
  if (hz < 500) return "lo";
  if (hz < 1800) return "mid";
  if (hz < 6000) return "hi";
  return "hs";
}

/** "cut 300 on the drums", "high-pass the bass at 80", "boost the highs" — as moves. */
export function proposeForPhrase(phrase: EqPhrase): ProcessingProposal {
  const hz = phrase.atHz ?? (phrase.region ? REGION_HZ[phrase.region] : null);

  if (phrase.move === "highpass") {
    const frequency = hz ?? 80;
    return {
      moves: [{ op: "band", band: "hp", frequency, enabled: true, why: "a high-pass clears room under the part without changing the part" }],
      summary: `high-passing at ${Math.round(frequency)} Hz`,
      confidence: null,
      notes: [],
    };
  }
  if (phrase.move === "lowpass") {
    const frequency = hz ?? 12000;
    return {
      moves: [{ op: "band", band: "lp", frequency, enabled: true, why: "a low-pass puts the part behind whatever is in front of it" }],
      summary: `low-passing at ${Math.round(frequency)} Hz`,
      confidence: null,
      notes: [],
    };
  }

  const frequency = hz ?? 1000;
  const id = phrase.region ? REGION_BAND[phrase.region] : bandForFrequency(frequency);
  const size = phrase.db === null ? DEFAULT_STEP_DB : Math.abs(phrase.db);
  const gainDb = phrase.move === "cut" ? -size : size;
  return {
    moves: [{ op: "band", band: id, frequency, gainDb, q: id === "ls" || id === "hs" ? 0.707 : 1.1, enabled: true, why: "the band a producer would reach for at that frequency" }],
    summary: `${phrase.move === "cut" ? "cutting" : "boosting"} ${Math.round(frequency)} Hz`,
    confidence: null,
    notes: [],
  };
}
