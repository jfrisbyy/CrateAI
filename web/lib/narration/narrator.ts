// The narrator seam. The route talks to a `Narrator`; the Anthropic-backed
// one lives in lib/anthropic/narrate.ts, the deterministic one below needs
// no model, and tests script one. No test touches the network.

import type { BreakdownContent } from "@/lib/types/db";
import { deterministicParagraphs } from "./prompt";

/** Why the model stopped; "refusal" and "max_tokens" are reported to the producer, never papered over. */
export type NarratorStop = "end_turn" | "max_tokens" | "refusal" | "other";

export interface NarrateOptions {
  signal?: AbortSignal;
}

export interface Narrator {
  /** Streams the narration text as it is produced; the generator's return value says why the model stopped. */
  narrate(content: BreakdownContent, options?: NarrateOptions): AsyncGenerator<string, NarratorStop, undefined>;
}

/** The measured document itself, paragraph by paragraph. Used when no model is configured. */
export class DeterministicNarrator implements Narrator {
  async *narrate(content: BreakdownContent): AsyncGenerator<string, NarratorStop, undefined> {
    for (const paragraph of deterministicParagraphs(content)) yield `${paragraph}\n\n`;
    return "end_turn";
  }
}

/** A narrator that plays back fixed chunks, for tests and fixtures. */
export function scriptedNarrator(chunks: string[], stop: NarratorStop = "end_turn"): Narrator {
  return {
    async *narrate() {
      for (const chunk of chunks) yield chunk;
      return stop;
    },
  };
}
