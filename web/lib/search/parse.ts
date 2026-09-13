// Library search query parser.
//
// Phase 0/1: a small deterministic parser for the filters the `library_filter`
// RPC understands ("85 bpm", "80-95", "f minor", "fm", "kind:stem"). Anything
// it cannot claim becomes `text_query`.
//
// ---- SEAM (Phase 6, BUILD_PACKET section 12) ----------------------------
// The hybrid parser replaces `parseQuery` with a call to Claude using a tool
// schema returning { text_query, bpm_min, bpm_max, key, mode, kind, tags,
// has_drums, is_loop_based }, and `text_query` feeds a CLAP text embedding
// for nearest-neighbour search. Keep the `ParsedQuery` shape; extend it.
// ---------------------------------------------------------------------------

import { parseKeyText } from "@/lib/music/keys";
import { FILE_KINDS, type FileKind } from "@/lib/types/db";
import type { Mode } from "@/lib/types/report";

export interface ParsedQuery {
  text_query: string | null;
  bpm_min: number | null;
  bpm_max: number | null;
  tonic: string | null;
  mode: Mode | null;
  kind: FileKind | null;
}

const BPM_TOLERANCE = 2;
const AROUND_TOLERANCE = 5;
const BPM_RANGE: [number, number] = [40, 300];

function inRange(n: number): boolean {
  return n >= BPM_RANGE[0] && n <= BPM_RANGE[1];
}

export function parseQuery(input: string): ParsedQuery {
  let text = ` ${input.trim()} `;
  const out: ParsedQuery = { text_query: null, bpm_min: null, bpm_max: null, tonic: null, mode: null, kind: null };

  // kind:stem / type:loop_render
  text = text.replace(/\s(?:kind|type):([a-z_]+)(?=\s)/i, (_m, k: string) => {
    const lower = k.toLowerCase();
    const kind = (FILE_KINDS as readonly string[]).includes(lower)
      ? (lower as FileKind)
      : lower === "loop" ? "loop_render" : lower === "layer" ? "layer_render" : lower === "revoice" ? "revoice_render" : null;
    if (kind) out.kind = kind;
    return " ";
  });

  // 80-95, 80 - 95 bpm, 80–95
  text = text.replace(/\s(\d{2,3})\s*[-–]\s*(\d{2,3})(?:\s*bpm)?(?=\s)/i, (_m, a: string, b: string) => {
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
    text = text.replace(/\s(?:around|about|~|near|roughly)\s*(\d{2,3})(?:\s*bpm)?(?=\s)/i, (_m, a: string) => {
      const n = Number(a);
      if (!inRange(n)) return _m;
      out.bpm_min = n - AROUND_TOLERANCE;
      out.bpm_max = n + AROUND_TOLERANCE;
      return " ";
    });
  }

  // 85 bpm, bpm 85, bpm:85
  if (out.bpm_min === null) {
    text = text.replace(/\s(?:(\d{2,3})\s*bpm|bpm\s*:?\s*(\d{2,3}))(?=\s)/i, (_m, a?: string, b?: string) => {
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

  // a bare 2-3 digit number in tempo range, when nothing else claimed a tempo
  if (out.bpm_min === null) {
    text = text.replace(/\s(\d{2,3})(?=\s)/, (_m, a: string) => {
      const n = Number(a);
      if (!inRange(n)) return _m;
      out.bpm_min = n - BPM_TOLERANCE;
      out.bpm_max = n + BPM_TOLERANCE;
      return " ";
    });
  }

  const rest = text.replace(/\s+/g, " ").trim();
  out.text_query = rest.length > 0 ? rest : null;
  return out;
}

/** Human summary of the active filters, for the results header. */
export function describeParsed(p: ParsedQuery): string[] {
  const parts: string[] = [];
  if (p.bpm_min !== null && p.bpm_max !== null) parts.push(`${p.bpm_min}–${p.bpm_max} BPM`);
  if (p.tonic && p.mode) parts.push(`${p.tonic} ${p.mode}`);
  if (p.kind) parts.push(`kind ${p.kind}`);
  if (p.text_query) parts.push(`"${p.text_query}"`);
  return parts;
}
