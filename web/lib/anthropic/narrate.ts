// The Anthropic-backed narrator (BUILD_PACKET section 11; OPEN_QUESTIONS E.21:
// the Opus-class model narrates the breakdown, the highest-stakes prose in the
// product). Server only. The SDK reads ANTHROPIC_API_KEY itself; when it is
// unset, `createAnthropicNarrator` returns null and the route falls back to
// the measured document with a note (lib/narration/run.ts).
//
// This file builds its own client on purpose: lib/anthropic/client.ts and
// models.ts belong to the chat seam and are written concurrently.

import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { serverEnv } from "@/lib/env";
import type { NarrateOptions, Narrator, NarratorStop } from "@/lib/narration/narrator";
import { buildNarrationPrompt } from "@/lib/narration/prompt";
import type { BreakdownContent } from "@/lib/types/db";

export const NARRATION_MODEL = "claude-opus-5";
export const NARRATION_MAX_TOKENS = 16000;

/** Bridges the stream's text events into an async iterable the orchestrator can pull from. */
class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<{ resolve: (r: IteratorResult<T>) => void; reject: (err: unknown) => void }> = [];
  private closed = false;
  private failure: unknown = null;
  private failed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.waiters.splice(0)) w.resolve({ value: undefined, done: true });
  }

  fail(err: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.failed = true;
    this.failure = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  next(): Promise<IteratorResult<T>> {
    if (this.items.length > 0) return Promise.resolve({ value: this.items.shift() as T, done: false });
    if (this.failed) return Promise.reject(this.failure);
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }
}

function stopOf(reason: Anthropic.Message["stop_reason"]): NarratorStop {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

export class AnthropicNarrator implements Narrator {
  constructor(private readonly client: Anthropic = new Anthropic()) {}

  async *narrate(content: BreakdownContent, options: NarrateOptions = {}): AsyncGenerator<string, NarratorStop, undefined> {
    const { system, user } = buildNarrationPrompt(content);
    const stream = this.client.messages.stream({
      model: NARRATION_MODEL,
      max_tokens: NARRATION_MAX_TOKENS,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: user }],
    });

    const queue = new AsyncQueue<string>();
    stream.on("text", (delta) => queue.push(delta));
    stream.on("error", (err) => queue.fail(err));
    stream.on("abort", (err) => queue.fail(err));
    const final = stream.finalMessage();
    final.then(
      () => queue.close(),
      (err) => queue.fail(err),
    );
    const onAbort = () => stream.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const delta of queue) yield delta;
      // A refusal or a max_tokens stop is reported to the producer, never smoothed over.
      const message = await final;
      return stopOf(message.stop_reason);
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

let shared: AnthropicNarrator | null = null;

/** The narrator for the route, or null when ANTHROPIC_API_KEY is not set. */
export function createAnthropicNarrator(): Narrator | null {
  if (!serverEnv("ANTHROPIC_API_KEY")) return null;
  shared ??= new AnthropicNarrator();
  return shared;
}
