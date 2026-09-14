// What is and is not playing inside a loop, read off `loops.components.sample_ready`.
//
// The finder measures this per candidate — vocal-free, drums-free, drums-only,
// how many stems are audible — and writes the claims, the caveats and the chip
// text beside each other (analysis/lockedgroove/loops/sample_ready.py). The web
// read none of it: `componentsOf` in LoopsTab keeps only numeric entries, so the
// whole object was dropped on the floor.
//
// The chips come from Python rather than being re-derived here on purpose. The
// claim-to-sentence rules in two languages is how the separator registry went
// stale; one set of rules, beside the measurement that produced them.

import type { Json, LoopRow } from "@/lib/types/db";
import type { SeparationTier } from "@/lib/types/stemModels";

export interface SampleReadyClaim {
  /** true, false, a count for `fullness` — or null when the claim was withheld */
  value: boolean | number | null;
  confidence: number | null;
  why: string | null;
  /** present only on a withheld claim: why nothing was claimed */
  withheld?: string;
}

export interface SampleReadySource {
  model: string | null;
  /** false when the separation is not claim-grade; every claim is then withheld */
  trusted: boolean;
  note: string | null;
  tier: SeparationTier | null;
  /** no claim drawn from these stems exceeds this */
  confidence: number;
}

export interface SampleReady {
  source: SampleReadySource;
  claims: Record<string, SampleReadyClaim>;
  /** short chips for the row, already worded by the code that made the claims */
  reasons: string[];
  /** the things a producer should know before believing the chips */
  caveats: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function claimOf(v: unknown): SampleReadyClaim | null {
  if (!isObject(v)) return null;
  const value = v.value;
  return {
    value: typeof value === "boolean" || typeof value === "number" ? value : null,
    confidence: typeof v.confidence === "number" ? v.confidence : null,
    why: typeof v.why === "string" ? v.why : null,
    ...(typeof v.withheld === "string" ? { withheld: v.withheld } : {}),
  };
}

/**
 * Read the block, or null when a loop has none.
 *
 * A loop found before the file had stems, or by a version of the finder that
 * did not measure this, simply has no block — which is not the same as a block
 * saying nothing is playing, and must not render as one.
 */
export function sampleReadyOf(components: LoopRow["components"] | Json): SampleReady | null {
  if (!isObject(components)) return null;
  const block = components.sample_ready;
  if (!isObject(block)) return null;

  const src = isObject(block.source) ? block.source : {};
  const claims: Record<string, SampleReadyClaim> = {};
  if (isObject(block.claims)) {
    for (const [name, raw] of Object.entries(block.claims)) {
      const claim = claimOf(raw);
      if (claim) claims[name] = claim;
    }
  }
  return {
    source: {
      model: typeof src.model === "string" ? src.model : null,
      // Absent means an old block from before the tier was recorded. Reading it
      // as untrusted would silence chips that were fine when they were written,
      // so absence keeps the block's own word for it.
      trusted: src.trusted !== false,
      note: typeof src.note === "string" ? src.note : null,
      tier: typeof src.tier === "string" ? (src.tier as SeparationTier) : null,
      confidence: typeof src.confidence === "number" ? src.confidence : 1,
    },
    claims,
    reasons: strings(block.reasons),
    caveats: strings(block.caveats),
  };
}

/** True only when the claim was measured and came out true — never for a withheld one. */
export function claimIsTrue(ready: SampleReady | null, name: string): boolean {
  return ready?.claims[name]?.value === true;
}

/**
 * What to say when there is nothing to say.
 *
 * An untrusted separation withholds every claim, so the row would otherwise show
 * no chips at all and read as "we looked and found nothing". It has to say that
 * we did not look.
 */
export function sampleReadyChips(ready: SampleReady | null): string[] {
  if (!ready) return [];
  if (ready.reasons.length > 0) return ready.reasons;
  if (!ready.source.trusted) return [ready.source.note ?? "no claim: these stems are not claim-grade"];
  return [];
}
