// The Anthropic client, constructed lazily so `next build` and the test suite
// run without ANTHROPIC_API_KEY. Server-side only: the key never leaves the
// route handlers (docs/CONTRACTS.md section 1).

import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";

let cached: Anthropic | null = null;

export function hasAnthropicKey(): boolean {
  return serverEnv("ANTHROPIC_API_KEY") !== undefined;
}

/** The shared client. Throws with the variable's name when the key is missing. */
export function getAnthropic(): Anthropic {
  if (cached) return cached;
  const apiKey = serverEnv("ANTHROPIC_API_KEY");
  if (!apiKey) {
    throw new Error("Missing environment variable ANTHROPIC_API_KEY. Chat and the search parser need it.");
  }
  cached = new Anthropic({ apiKey });
  return cached;
}

/** A readable sentence for an Anthropic API failure, checked most specific first. */
export function describeAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.RateLimitError) return "The model is rate-limited right now; try again in a moment.";
  if (err instanceof Anthropic.AuthenticationError) return "ANTHROPIC_API_KEY was rejected; check the key in web/.env.local.";
  if (err instanceof Anthropic.APIError) return `The model returned an error (${err.status ?? "unknown"}): ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
