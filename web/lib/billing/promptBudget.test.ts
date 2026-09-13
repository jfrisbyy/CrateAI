// The cost model in cost.ts assumes a shape for a chat turn. Two of its
// numbers are not assumptions at all — they are the size of things in this
// repository, and they drift every time someone adds a tool or a paragraph of
// system prompt. This test measures them and fails when they outgrow the
// budget the tiers were set from, so the free tier can never quietly become
// unaffordable through prompt growth.
//
// Characters, not tokens: there is no tokenizer in the test environment and
// calling `messages.count_tokens` would need a key and the network. The
// ratios below are the usual ones for this kind of content (prose ~3.7
// characters a token, JSON schemas ~3.2) and are deliberately conservative.

import { describe, expect, it } from "vitest";
import { fakeFile } from "@/lib/chat/fakes";
import { buildContextBlock, SYSTEM_PROMPT } from "@/lib/chat/system";
import { CHAT_TOOLS } from "@/lib/chat/tools";
import { CHAT_TURN_SHAPE } from "./cost";

const PROSE_CHARS_PER_TOKEN = 3.7;
const JSON_CHARS_PER_TOKEN = 3.2;

function estimateTokens(text: string, ratio: number): number {
  return Math.round(text.length / ratio);
}

describe("the chat prompt fits the budget the tiers were priced from", () => {
  it("keeps tools plus the frozen system prompt inside the cached-prefix estimate", () => {
    const tools = estimateTokens(JSON.stringify(CHAT_TOOLS), JSON_CHARS_PER_TOKEN);
    const system = estimateTokens(SYSTEM_PROMPT, PROSE_CHARS_PER_TOKEN);
    const prefix = tools + system;
    // Not a tight equality: the estimate has to have headroom or every edit to
    // a tool description breaks the build. It has to have a ceiling, though,
    // because everything before the breakpoint is what caching pays for.
    expect(prefix).toBeLessThanOrEqual(CHAT_TURN_SHAPE.cached_prefix_tokens);
    expect(prefix).toBeGreaterThan(CHAT_TURN_SHAPE.cached_prefix_tokens * 0.7);
  });

  it("keeps the per-request context block inside the volatile-tail estimate", () => {
    const file = fakeFile();
    const block = buildContextBlock([file], file.id, new Date("2026-09-13T00:00:00Z"));
    const tokens = estimateTokens(block, PROSE_CHARS_PER_TOKEN);
    // The tail also carries the replayed history and the question; the context
    // block on its own must be a fraction of it.
    expect(tokens).toBeLessThan(CHAT_TURN_SHAPE.fresh_input_tokens / 2);
  });

  it("keeps the cacheable half the larger half, which is why caching is worth it", () => {
    expect(CHAT_TURN_SHAPE.cached_prefix_tokens).toBeGreaterThan(CHAT_TURN_SHAPE.fresh_input_tokens);
  });
});
