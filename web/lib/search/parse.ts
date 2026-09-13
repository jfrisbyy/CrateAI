// Library search query parser, the deterministic half of the hybrid parser
// (BUILD_PACKET section 12). It claims the filters that have one right
// answer ("85 bpm", "80-95", "f minor", "kind:stem", "no drums", "loop",
// "like this") and recognizes producer terms as tags; whatever is left, minus
// filler, is `text_query`, the phrase the CLAP text embedding and the name
// match get. lib/search/hybrid.ts runs this first and asks Claude only when
// free text remains and a key is present.

import { parseKeyText } from "@/lib/music/keys";
import { FILE_KINDS, type FileKind } from "@/lib/types/db";
import type { Mode } from "@/lib/types/report";
import { isVocabularyTag, TAG_SYNONYMS, TAG_VOCABULARY } from "./vocabulary";

export interface ParsedQuery {
  /** the descriptive words left for the sound search; null when the query was filters only */
  text_query: string | null;
  bpm_min: number | null;
  bpm_max: number | null;
  /** sharp spelling, as the report stores it */
  tonic: string | null;
  mode: Mode | null;
  kind: FileKind | null;
  /** the producer's own words, in order; expandTags() maps them onto database tags */
  tags: string[];
  has_drums: boolean | null;
  is_loop_based: boolean | null;
  /** "like this", "similar to this": nearest neighbours of the current file */
  similar: boolean;
  /** the file `similar` refers to, resolved by the caller from the open file */
  similar_to_file_id: string | null;
  /** which parser produced the fields */
  parser: "rules" | "rules+claude";
}

export const BPM_TOLERANCE = 2;
export const AROUND_TOLERANCE = 5;
const BPM_RANGE: [number, number] = [40, 300];

const STOPWORDS = new Set([
  "a", "an", "the", "some", "something", "anything", "any", "in", "at", "on", "of", "with", "and", "or", "for", "to",
  "me", "my", "i", "find", "show", "give", "get", "want", "need", "looking", "look", "search", "that", "this", "it",
  "is", "are", "be", "like", "sounds", "sound", "please", "around", "about", "near", "roughly", "bpm", "tempo", "key",
  "kind", "type", "from", "by", "but", "not", "no", "than", "more", "less", "just", "only", "one", "which", "what",
  "files", "file", "samples", "tracks", "track", "songs", "song", "stuff", "things", "thing",
]);

function inRange(n: number): boolean {
  return n >= BPM_RANGE[0] && n <= BPM_RANGE[1];
}

export function emptyParsed(): ParsedQuery {
  return {
    text_query: null,
    bpm_min: null,
    bpm_max: null,
    tonic: null,
    mode: null,
    kind: null,
    tags: [],
    has_drums: null,
    is_loop_based: null,
    similar: false,
    similar_to_file_id: null,
    parser: "rules",
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// multi-word vocabulary terms first so "drum break" is one tag, not "drum" + "break"
const VOCAB_BY_LENGTH = [...TAG_VOCABULARY].sort((a, b) => b.length - a.length);
const SYNONYM_WORDS = Object.keys(TAG_SYNONYMS);

/** Producer terms present in the text, in order of appearance, without removing them. */
export function findTags(text: string): string[] {
  const lower = ` ${text.toLowerCase()} `;
  const found: Array<{ at: number; tag: string }> = [];
  let scratch = lower;
  for (const term of VOCAB_BY_LENGTH) {
    const re = new RegExp(`(?<=[\\s,;(])${escapeRe(term)}(?=[\\s,;).!?])`, "g");
    for (const m of scratch.matchAll(re)) {
      const at = m.index ?? 0;
      found.push({ at, tag: term });
      // blank the match so a shorter term inside it is not matched again
      scratch = `${scratch.slice(0, at)}${" ".repeat(term.length)}${scratch.slice(at + term.length)}`;
    }
  }
  for (const word of SYNONYM_WORDS) {
    const re = new RegExp(`(?<=[\\s,;(])${escapeRe(word)}(?=[\\s,;).!?])`, "g");
    for (const m of scratch.matchAll(re)) found.push({ at: m.index ?? 0, tag: word });
  }
  found.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const f of found) if (!out.includes(f.tag)) out.push(f.tag);
  return out;
}

export function parseQuery(input: string): ParsedQuery {
  let text = ` ${input.trim().replace(/\s+/g, " ")} `;
  const out = emptyParsed();

  // kind:stem / type:loop_render, and the plain words producers use
  text = text.replace(/\s(?:kind|type):([a-z_]+)(?=\s)/i, (_m, k: string) => {
    const lower = k.toLowerCase();
    const kind = (FILE_KINDS as readonly string[]).includes(lower)
      ? (lower as FileKind)
      : lower === "loop" ? "loop_render" : lower === "layer" ? "layer_render" : lower === "revoice" ? "revoice_render" : null;
    if (kind) out.kind = kind;
    return " ";
  });
  if (out.kind === null) {
    text = text.replace(/\s(stems?|chops?|re-?voices?|revoiced)(?=[\s,])/i, (_m, w: string) => {
      const lower = w.toLowerCase();
      out.kind = lower.startsWith("stem") ? "stem" : lower.startsWith("chop") ? "chop" : "revoice_render";
      return " ";
    });
  }

  // 80-95, 80 - 95 bpm, 80–95
  text = text.replace(/\s(\d{2,3})\s*[-–]\s*(\d{2,3})(?:\s*bpm)?(?=[\s,])/i, (_m, a: string, b: string) => {
    const lo = Math.min(Number(a), Number(b));
    const hi = Math.max(Number(a), Number(b));
    if (inRange(lo) && inRange(hi)) {
      out.bpm_min = lo;
      out.bpm_max = hi;
      return " ";
    }
    return _m;
  });

  // around 85, ~85, about 85
  if (out.bpm_min === null) {
    text = text.replace(/\s(?:around|about|~|near|roughly|approximately|circa)\s*(\d{2,3})(?:\s*bpm)?(?=[\s,])/i, (_m, a: string) => {
      const n = Number(a);
      if (!inRange(n)) return _m;
      out.bpm_min = n - AROUND_TOLERANCE;
      out.bpm_max = n + AROUND_TOLERANCE;
      return " ";
    });
  }

  // 85 bpm, bpm 85, bpm:85
  if (out.bpm_min === null) {
    text = text.replace(/\s(?:(\d{2,3})\s*bpm|bpm\s*:?\s*(\d{2,3}))(?=[\s,])/i, (_m, a?: string, b?: string) => {
      const n = Number(a ?? b);
      if (!inRange(n)) return _m;
      out.bpm_min = n - BPM_TOLERANCE;
      out.bpm_max = n + BPM_TOLERANCE;
      return " ";
    });
  }

  // key: "f minor", "fm", "bb major"
  const key = parseKeyText(text);
  if (key) {
    out.tonic = key.tonic;
    out.mode = key.mode;
    text = text.replace(key.match, " ");
  }

  // drums present or not
  text = text.replace(/\s(?:no|without|minus|w\/o)\s+drums?(?=[\s,.!?])|\sdrumless(?=[\s,.!?])/i, () => {
    out.has_drums = false;
    return " ";
  });
  if (out.has_drums === null) {
    text = text.replace(/\s(?:with\s+drums|drums\s+only|just\s+drums|drums\s+in)(?=[\s,.!?])/i, () => {
      out.has_drums = true;
      return " ";
    });
  }

  // loop-based material
  text = text.replace(/\s(?:loop-?based|loops?)(?=[\s,.!?])/i, () => {
    out.is_loop_based = true;
    return " ";
  });

  // nearest neighbours of the open file
  text = text.replace(
    /\s(?:(?:more|sounds?|something|anything)\s+)?(?:like|similar\s+to)\s+(?:this|that)(?:\s+(?:one|file|track|sample))?(?=[\s,.!?])|\ssimilar(?=[\s,.!?]|$)/i,
    () => {
      out.similar = true;
      return " ";
    },
  );

  // a bare 2-3 digit number in tempo range, when nothing else claimed a tempo
  if (out.bpm_min === null) {
    text = text.replace(/\s(\d{2,3})(?=[\s,])/, (_m, a: string) => {
      const n = Number(a);
      if (!inRange(n)) return _m;
      out.bpm_min = n - BPM_TOLERANCE;
      out.bpm_max = n + BPM_TOLERANCE;
      return " ";
    });
  }

  // tags stay in the text: "dusty horns" is exactly the phrase the sound search wants
  out.tags = findTags(text);

  const words = text
    .replace(/[,;!?]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .filter((w) => !STOPWORDS.has(w.toLowerCase()) || isVocabularyTag(w.toLowerCase()));
  out.text_query = words.length > 0 ? words.join(" ") : null;
  return out;
}

/** Human summary of the active filters, for the results header and the chips. */
export function describeParsed(p: ParsedQuery): string[] {
  const parts: string[] = [];
  if (p.bpm_min !== null && p.bpm_max !== null) parts.push(`${p.bpm_min}–${p.bpm_max} BPM`);
  if (p.tonic && p.mode) parts.push(`${p.tonic} ${p.mode}`);
  if (p.kind) parts.push(`kind ${p.kind}`);
  if (p.has_drums === false) parts.push("no drums");
  if (p.has_drums === true) parts.push("drums");
  if (p.is_loop_based === true) parts.push("loop-based");
  if (p.similar) parts.push("similar to the open file");
  if (p.tags.length > 0) parts.push(`tags ${p.tags.join(", ")}`);
  if (p.text_query) parts.push(`"${p.text_query}"`);
  return parts;
}
