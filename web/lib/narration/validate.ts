// The grounding check on a narration (BUILD_PACKET section 14): every number
// in the text appears in some fact (text or value), every key name is a key
// the facts name, no chord progression that the facts don't carry, no
// instrument word that the facts don't use, and a value the facts hedge is
// not stated without a hedge. Works on a whole narration or one paragraph.
//
// The checks are deliberately literal. A false rejection costs one paragraph
// (the facts stay on screen); a false acceptance would put an unmeasured
// claim in the producer's hands.

import { normalizeTonic } from "@/lib/music/keys";
import type { BreakdownContent, Json } from "@/lib/types/db";
import { textCarriesHedge } from "./prompt";

export interface ValidationResult {
  ok: boolean;
  problems: string[];
}

const NUMBER_RE = /\d+(?:\.\d+)?/g;
const LIST_MARKER_RE = /^\s*\d+[.)]\s+/gm;
const KEY_RE = /\b([A-G])([#♯b♭])?[\s-]*(major|minor|maj|min)\b/g;
// "A minor" and "A major" are English as often as they are keys ("A minor caveat");
// a plain A counts as a key only after a word that introduces one.
const KEY_CONTEXT_RE = /\b(?:in|of|to|is|as|than|against|from|key|reads|be|and|or|at|around|about|likely|roughly|possibly)\s*$/i;
const CHORD_TOKEN = "[A-G][#♯b♭]?(?:maj7|maj|min7|min|m7|m|dim7|dim|aug|sus[24]?|add\\d|7|9|6)?";
const CHORD_PROGRESSION_RE = new RegExp(
  `(?<![A-Za-z])(${CHORD_TOKEN})(?:\\s*(?:–|—|-|→|>|,|then|to)\\s*(?<![A-Za-z])(${CHORD_TOKEN})(?![A-Za-z]))+`,
  "g",
);
const CHORD_SPLIT_RE = /\s*(?:–|—|-|→|>|,|then|to)\s*/;
const CHORD_LIKE_RE = /[#♯b♭]|maj|min|dim|aug|sus|add|\d|(?<=[A-G])m/;

/** Section-11 instrument vocabulary the narrator may not introduce on its own. */
export const INSTRUMENT_WORDS = [
  "piano", "rhodes", "guitar", "bass", "vocal", "strings", "brass", "synth", "808",
  "horn", "organ", "flute", "sax", "wurlitzer", "clav",
] as const;

const HEDGE_MARKERS = [
  "likely", "roughly", "possibly", "probably", "can't tell", "cannot tell", "can't be sure", "not sure", "not certain",
  "uncertain", "hard to tell", "maybe", "seems", "about", "around", "approximately", "rough", "reads as",
];

// ---------------------------------------------------------------------------
// what the facts allow
// ---------------------------------------------------------------------------

function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.replace(LIST_MARKER_RE, "").matchAll(NUMBER_RE)) out.push(Number(m[0]));
  return out;
}

function numbersInValue(value: Json | undefined, out: number[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) out.push(value);
    return;
  }
  if (typeof value === "string") {
    out.push(...numbersIn(value));
    return;
  }
  if (typeof value === "boolean") return;
  if (Array.isArray(value)) {
    for (const v of value) numbersInValue(v, out);
    return;
  }
  for (const v of Object.values(value)) numbersInValue(v, out);
}

type Quality = string;

function normalizeQuality(q: string | undefined): Quality {
  const raw = (q ?? "").replace(/^:/, "");
  switch (raw) {
    case "":
    case "maj":
    case "M":
    case "major":
      return "maj";
    case "m":
    case "min":
    case "minor":
      return "min";
    case "m7":
    case "min7":
      return "min7";
    case "sus":
      return "sus4";
    default:
      return raw;
  }
}

/** "Fm" | "F:min" | "Bb:maj" | "Db" | "C#m7" -> "F:min" | "A#:maj" | "C#:maj" | "C#:min7"; null for "N" and anything else. */
export function normalizeChordLabel(label: string): string | null {
  const m = /^([A-G][#♯b♭]?)(?::?(maj7|maj|min7|min|m7|m|dim7|dim|aug|sus[24]?|add\d|7|9|6|major|minor))?$/.exec(label.trim());
  if (!m) return null;
  const tonic = normalizeTonic(m[1]!.replace("♯", "#").replace("♭", "b"));
  if (!tonic) return null;
  return `${tonic}:${normalizeQuality(m[2])}`;
}

function keysIn(text: string): Array<{ key: string; match: string; index: number }> {
  const out: Array<{ key: string; match: string; index: number }> = [];
  for (const m of text.matchAll(KEY_RE)) {
    const tonic = normalizeTonic(`${m[1]}${(m[2] ?? "").replace("♯", "#").replace("♭", "b")}`);
    if (!tonic) continue;
    const mode = m[3]!.toLowerCase().startsWith("maj") ? "major" : "minor";
    out.push({ key: `${tonic} ${mode}`, match: m[0], index: m.index ?? 0 });
  }
  return out;
}

function keysInValue(value: Json | undefined, out: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const tonic = value.tonic;
  const mode = value.mode;
  if (typeof tonic === "string" && (mode === "major" || mode === "minor")) {
    const t = normalizeTonic(tonic);
    if (t) out.add(`${t} ${mode}`);
  }
  for (const v of Object.values(value)) keysInValue(v, out);
}

function chordsInValue(value: Json | undefined, out: Set<string>): void {
  if (typeof value === "string") {
    const c = normalizeChordLabel(value);
    if (c) out.add(c);
    return;
  }
  if (Array.isArray(value)) for (const v of value) chordsInValue(v, out);
}

export interface Allowed {
  numbers: Set<number>;
  hedgedOnly: Set<number>;
  keys: Set<string>;
  chords: Set<string>;
  text: string;
}

export function allowedFrom(content: BreakdownContent): Allowed {
  const numbers = new Set<number>();
  const plain = new Set<number>();
  const hedged = new Set<number>();
  const keys = new Set<string>();
  const chords = new Set<string>();
  const texts: string[] = [];
  for (const section of content.sections) {
    texts.push(section.title);
    for (const fact of section.facts) {
      const nums: number[] = numbersIn(fact.text);
      numbersInValue(fact.value, nums);
      if (fact.citation?.title) nums.push(...numbersIn(String(fact.citation.title)));
      for (const n of nums) {
        numbers.add(n);
        (textCarriesHedge(fact) ? hedged : plain).add(n);
      }
      for (const k of keysIn(fact.text)) keys.add(k.key);
      keysInValue(fact.value, keys);
      chordsInValue(fact.value, chords);
      for (const part of fact.text.split(CHORD_SPLIT_RE)) {
        const c = normalizeChordLabel(part.replace(/[.:]$/, "").replace(/^.*:\s*/, ""));
        if (c) chords.add(c);
      }
      texts.push(fact.text);
      if (fact.citation?.title) texts.push(String(fact.citation.title));
    }
    for (const m of section.missing) texts.push(m.text);
  }
  if (content.title) {
    texts.push(content.title);
    for (const n of numbersIn(content.title)) numbers.add(n);
  }
  if (content.artist) {
    texts.push(content.artist);
    for (const n of numbersIn(content.artist)) numbers.add(n);
  }
  const hedgedOnly = new Set<number>();
  for (const n of hedged) if (!plain.has(n)) hedgedOnly.add(n);
  return { numbers, hedgedOnly, keys, chords, text: texts.join("\n").toLowerCase() };
}

// ---------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------

function hasHedge(sentence: string): boolean {
  const lower = sentence.toLowerCase();
  return HEDGE_MARKERS.some((h) => lower.includes(h));
}

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Check a narration (or one paragraph of it) against the content it was
 * narrated from. `ok` is true only when nothing had to be questioned. Pass
 * `allowed` (from `allowedFrom`) when checking many paragraphs of one document.
 */
export function validateNarration(narration: string, content: BreakdownContent, allowed: Allowed = allowedFrom(content)): ValidationResult {
  const problems: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    if (!seen.has(p)) {
      seen.add(p);
      problems.push(p);
    }
  };

  // numbers: every one must be a measured value
  for (const n of numbersIn(narration)) {
    if (!allowed.numbers.has(n)) add(`the number ${n} is not in the facts`);
  }

  // keys: every "X major/minor" must be a key the facts name
  for (const k of keysIn(narration)) {
    const before = narration.slice(Math.max(0, k.index - 24), k.index);
    const plainA = /^A[\s-]/.test(k.match);
    if (plainA && !KEY_CONTEXT_RE.test(before)) continue; // "A minor caveat" is English, not a key
    if (!allowed.keys.has(k.key)) add(`the key ${k.match.trim()} is not in the facts`);
  }

  // chord progressions: a run of chord symbols must be one the facts carry
  for (const m of narration.matchAll(CHORD_PROGRESSION_RE)) {
    const run = m[0];
    const tokens = run.split(CHORD_SPLIT_RE).map((t) => t.trim()).filter(Boolean);
    if (!tokens.some((t) => CHORD_LIKE_RE.test(t))) continue; // "A, B, A, B" are section labels
    for (const t of tokens) {
      const c = normalizeChordLabel(t);
      if (c && !allowed.chords.has(c)) add(`the chord ${t} is not in the facts`);
    }
  }

  // instruments: section-11 vocabulary only where the facts use it
  const lower = narration.toLowerCase();
  for (const word of INSTRUMENT_WORDS) {
    const re = new RegExp(`\\b${word}(?:s|es)?\\b`);
    if (re.test(lower) && !re.test(allowed.text)) add(`the instrument "${word}" is not in the facts`);
  }

  // hedges: a value the facts only state hedged cannot be stated plainly
  if (allowed.hedgedOnly.size > 0) {
    for (const sentence of sentencesOf(narration)) {
      const nums = numbersIn(sentence).filter((n) => allowed.hedgedOnly.has(n));
      if (nums.length > 0 && !hasHedge(sentence)) {
        add(`"${sentence.length > 80 ? `${sentence.slice(0, 77)}...` : sentence}" states ${nums[0]} without its hedge`);
      }
    }
  }

  return { ok: problems.length === 0, problems };
}
