// Model routing, in one place, with the per-turn cost of each path written
// down (OPEN_QUESTIONS E.21). The prices and the arithmetic behind the numbers
// below are in `lib/billing/cost.ts`; this file is the decision.
//
// The rule: pay Opus-class rates where the prose is the product, and Sonnet
// rates where the model is doing a job whose quality is checked by something
// other than taste.
//
//   breakdown narration   claude-opus-5   (NARRATION_MODEL, lib/anthropic/narrate.ts)
//       The highest-stakes prose in the product: a full account of how a
//       record was made, which the producer reads instead of the numbers, and
//       which is validated fact by fact against the composed BreakdownContent
//       (lib/narration/validate.ts) before it is shown. One call per
//       breakdown, not per turn, so it is a rounding error on the bill:
//       about $0.04 for a ~2.5k-token prompt and a ~1.2k-token answer, with
//       its own frozen system prompt cached. Stays on Opus 5.
//
//   chat turns            claude-sonnet-5 (CHAT_MODEL, below)
//       Routine work: read the report, call the right tool, answer in a
//       paragraph. Every musical claim is already constrained by the grounding
//       contract in the system prompt and by strict tool schemas, so the model
//       is not being trusted to know things, only to route and to phrase.
//       About $0.033 a metered turn on Sonnet 5 with the system prompt cached,
//       against about $0.113 for the same turn on Opus 5 with no caching. This
//       is the single biggest cost line in the product and the reason the free
//       tier is affordable enough to open.
//
//   search query parser   claude-sonnet-5 (QUERY_PARSER_MODEL, below)
//       Structured output against a fixed zod schema (lib/search/
//       claudeParser.ts), run only when the rules parser left free text
//       behind, and discarded when it does not validate. There is nothing for
//       an Opus-class model to add: the schema is the quality gate. ~2k input
//       and a few hundred output tokens, so well under a tenth of a cent.
//
// Caches are per model, so the chat's cached prefix and the narrator's are
// separate entries. That costs nothing: they share no bytes.
//
// If the owner's ear says a routine turn reads worse on Sonnet 5, moving chat
// back is one line here — and roughly triples the per-turn cost, so the free
// tier's monthly cap in lib/billing/limits.ts has to come down with it.

import type { ModelId } from "@/lib/billing/cost";

export const CHAT_MODEL: ModelId = "claude-sonnet-5";
export const QUERY_PARSER_MODEL: ModelId = "claude-sonnet-5";

/** Output budget for a streamed chat turn (streaming, so a large cap is safe). */
export const CHAT_MAX_TOKENS = 64_000;
/** The parser returns one small JSON object. */
export const QUERY_PARSER_MAX_TOKENS = 2_000;
