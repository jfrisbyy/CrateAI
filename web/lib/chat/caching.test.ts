// Prompt caching, verified rather than assumed.
//
// The model here is a fake, but it implements the one rule that matters: the
// cache is a prefix match over the rendered request (tools, then system, then
// messages) up to each `cache_control` breakpoint, and any byte change
// anywhere in that prefix means no hit. So these tests fail for exactly the
// reasons production would — a timestamp interpolated into the system prompt,
// a tool list that stopped being deterministic, a breakpoint after the part
// that varies — and they pass for the right reason, not because a marker is
// present somewhere.
//
// What they cannot check is that the real API agrees. How to confirm that
// against the live API is in docs/HANDOFF_launch_readiness.md.

import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { outcome } from "./cards";
import { runToolLoop } from "./loop";
import { SYSTEM_PROMPT, buildContextBlock } from "./system";
import { fakeFile } from "./fakes";
import type { ChatModel, ModelStream } from "./loop";
import type { ChatEvent } from "./protocol";
import { CHAT_TOOLS } from "./tools";

// ---------------------------------------------------------------------------
// a model that caches the way the API does
// ---------------------------------------------------------------------------

interface Segment {
  text: string;
  breakpoint: boolean;
}

function blockText(block: unknown): string {
  if (typeof block === "string") return block;
  if (!block || typeof block !== "object") return "";
  const b = block as Record<string, unknown>;
  if (typeof b.text === "string") return b.text;
  if (typeof b.content === "string") return `${String(b.type)}:${String(b.tool_use_id ?? "")}:${b.content}`;
  return JSON.stringify({ ...b, cache_control: undefined });
}

function hasBreakpoint(block: unknown): boolean {
  return Boolean(block && typeof block === "object" && (block as Record<string, unknown>).cache_control);
}

/** The request as the cache sees it: render order, markers stripped from the bytes. */
function segmentsOf(params: Anthropic.MessageStreamParams): Segment[] {
  const segments: Segment[] = [{ text: `tools:${JSON.stringify(params.tools ?? [])}`, breakpoint: false }];
  const system = params.system;
  if (typeof system === "string") segments.push({ text: `sys:${system}`, breakpoint: false });
  else for (const block of system ?? []) segments.push({ text: `sys:${blockText(block)}`, breakpoint: hasBreakpoint(block) });
  for (const message of params.messages) {
    const content = message.content;
    if (typeof content === "string") segments.push({ text: `${message.role}:${content}`, breakpoint: false });
    else for (const block of content) segments.push({ text: `${message.role}:${blockText(block)}`, breakpoint: hasBreakpoint(block) });
  }
  return segments;
}

/**
 * Every position this request could read from, as a key that identifies the
 * exact blocks up to it. Whole blocks, not raw bytes: appending to the last
 * block of a cached prefix changes that block, so it is a different prefix.
 */
function positions(params: Anthropic.MessageStreamParams): Array<{ key: string; tokens: number; breakpoint: boolean }> {
  const segments = segmentsOf(params);
  const out: Array<{ key: string; tokens: number; breakpoint: boolean }> = [];
  let size = 0;
  for (let n = 0; n < segments.length; n++) {
    size += Math.ceil(segments[n]!.text.length / 4);
    out.push({ key: JSON.stringify(segments.slice(0, n + 1).map((s) => s.text)), tokens: size, breakpoint: segments[n]!.breakpoint });
  }
  return out;
}


export type Scripted = { text?: string; tools?: Array<{ id: string; name: string; input: unknown }>; stop?: Anthropic.StopReason };

interface CachingModel extends ChatModel {
  requests: Anthropic.MessageStreamParams[];
  usages: Anthropic.Usage[];
  breakpointCounts: number[];
}

/**
 * One workspace's 5-minute cache, shared across every request the returned
 * model serves — so two calls in a row share entries the way two turns from
 * the same producer do.
 */
function cache() {
  const stored = new Map<string, number>();
  return {
    /**
     * What this request reads back, and what it has to write. A read lands on
     * any position a previous request wrote a breakpoint at, whether or not
     * this request still marks it — which is why rolling a marker forward
     * costs nothing. A write bills only the delta past the highest hit.
     */
    serve(params: Anthropic.MessageStreamParams): { read: number; created: number } {
      const here = positions(params);
      let read = 0;
      for (const p of here) {
        const hit = stored.get(p.key);
        if (hit !== undefined) read = Math.max(read, hit);
      }
      let longestNew = 0;
      for (const p of here) {
        if (p.breakpoint && !stored.has(p.key)) {
          stored.set(p.key, p.tokens);
          longestNew = Math.max(longestNew, p.tokens);
        }
      }
      return { read, created: Math.max(0, longestNew - read) };
    },
  };
}

function cachingModel(turns: Scripted[], shared = cache()): CachingModel {
  const requests: Anthropic.MessageStreamParams[] = [];
  const usages: Anthropic.Usage[] = [];
  const breakpointCounts: number[] = [];
  let i = 0;
  const model: CachingModel = {
    requests,
    usages,
    breakpointCounts,
    stream(params) {
      requests.push(structuredClone(params));
      breakpointCounts.push(segmentsOf(params).filter((s) => s.breakpoint).length);
      const { read, created } = shared.serve(params);
      const turn = turns[i] ?? { text: "done", stop: "end_turn" as const };
      i++;
      const usage = {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: created,
        cache_read_input_tokens: read,
      } as unknown as Anthropic.Usage;
      usages.push(usage);
      const listeners: Array<(delta: string) => void> = [];
      const stream: ModelStream = {
        on(event, listener) {
          if (event === "text") listeners.push(listener);
          return stream;
        },
        async finalMessage() {
          if (turn.text) for (const l of listeners) l(turn.text);
          const content: Anthropic.ContentBlock[] = [];
          if (turn.text) content.push({ type: "text", text: turn.text, citations: null });
          for (const t of turn.tools ?? []) content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input, caller: { type: "direct" } });
          return {
            id: "msg_fake",
            type: "message",
            role: "assistant",
            model: String(params.model),
            content,
            container: null,
            stop_reason: turn.stop ?? (turn.tools && turn.tools.length > 0 ? "tool_use" : "end_turn"),
            stop_details: null,
            stop_sequence: null,
            usage,
          } as unknown as Anthropic.Message;
        },
      };
      return stream;
    },
  };
  return model;
}

// ---------------------------------------------------------------------------
// the request the chat route builds
// ---------------------------------------------------------------------------

/** Exactly the shape app/api/chat/route.ts assembles: frozen prompt first, breakpoint, then the volatile block. */
function systemBlocks(now: Date): Anthropic.TextBlockParam[] {
  const file = fakeFile();
  return [
    { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
    { type: "text", text: buildContextBlock([file], file.id, now) },
  ];
}

function run(model: ChatModel, system: Anthropic.TextBlockParam[], question: string) {
  const events: ChatEvent[] = [];
  return runToolLoop({
    model,
    modelId: "claude-sonnet-5",
    maxTokens: 1000,
    system,
    tools: CHAT_TOOLS,
    messages: [{ role: "user", content: question }],
    execute: async (call) => outcome({ text: `result of ${call.name}`, summary: `${call.name} done` }),
    emit: (e) => events.push(e),
  });
}

describe("the system block is cached across turns", () => {
  it("reads the tools and the system prompt back on the second identical request", async () => {
    const model = cachingModel([{ text: "one" }, { text: "two" }]);
    const system = systemBlocks(new Date("2026-09-13T00:00:00Z"));
    await run(model, system, "what tempo is this");
    await run(model, system, "what tempo is this");
    expect(model.usages[0]!.cache_read_input_tokens).toBe(0);
    expect(model.usages[0]!.cache_creation_input_tokens).toBeGreaterThan(0);
    expect(model.usages[1]!.cache_read_input_tokens).toBeGreaterThan(0);
    // what was read back is the tools plus the system prompt, not a scrap
    expect(model.usages[1]!.cache_read_input_tokens).toBeGreaterThan(3_000);
    expect(model.usages[1]!.cache_creation_input_tokens).toBe(0);
  });

  it("still hits when only the volatile part changed, which is the whole point of the ordering", async () => {
    const model = cachingModel([{ text: "one" }, { text: "two" }]);
    await run(model, systemBlocks(new Date("2026-09-13T00:00:00Z")), "what tempo is this");
    // a different day, a different open file, a different question: everything
    // that moves is after the breakpoint
    await run(model, systemBlocks(new Date("2026-09-14T00:00:00Z")), "and the key?");
    expect(model.usages[1]!.cache_read_input_tokens).toBeGreaterThan(3_000);
  });

  it("misses when anything before the breakpoint moves, so the test can actually fail", async () => {
    const model = cachingModel([{ text: "one" }, { text: "two" }]);
    const stable = systemBlocks(new Date("2026-09-13T00:00:00Z"));
    await run(model, stable, "what tempo is this");
    const drifted: Anthropic.TextBlockParam[] = [
      { type: "text", text: `${SYSTEM_PROMPT}\nRequest id: 4f1c.`, cache_control: { type: "ephemeral" } },
      stable[1]!,
    ];
    await run(model, drifted, "what tempo is this");
    expect(model.usages[1]!.cache_read_input_tokens).toBe(0);
  });

  it("misses when the tool list is reordered, because tools render first", async () => {
    const model = cachingModel([{ text: "one" }, { text: "two" }]);
    const system = systemBlocks(new Date("2026-09-13T00:00:00Z"));
    await run(model, system, "q");
    const events: ChatEvent[] = [];
    await runToolLoop({
      model,
      modelId: "claude-sonnet-5",
      maxTokens: 1000,
      system,
      tools: [...CHAT_TOOLS].reverse(),
      messages: [{ role: "user", content: "q" }],
      execute: async () => outcome({ text: "x", summary: "x" }),
      emit: (e) => events.push(e),
    });
    expect(model.usages[1]!.cache_read_input_tokens).toBe(0);
  });
});

describe("the rolling breakpoint inside a tool loop", () => {
  it("lets a later round read back what an earlier round already sent", async () => {
    const model = cachingModel([
      { tools: [{ id: "t1", name: "get_report", input: { file_id: "a" } }] },
      { tools: [{ id: "t2", name: "find_loops", input: { file_id: "a" } }] },
      { tools: [{ id: "t3", name: "search", input: { query: "x" } }] },
      { text: "here it is" },
    ]);
    await run(model, systemBlocks(new Date("2026-09-13T00:00:00Z")), "find me the drums");
    expect(model.requests).toHaveLength(4);
    // round 1 writes the system prefix; round 2 reads it and writes the first
    // tool results; round 3 reads those back
    const reads = model.usages.map((u) => u.cache_read_input_tokens ?? 0);
    expect(reads[0]).toBe(0);
    expect(reads[1]).toBeGreaterThan(0);
    expect(reads[2]).toBeGreaterThan(reads[1]!);
    expect(reads[3]).toBeGreaterThan(reads[2]!);
  });

  it("never sends more than the four breakpoints a request may carry", async () => {
    const model = cachingModel(Array.from({ length: 12 }, (_, i) => ({ tools: [{ id: `t${i}`, name: "get_report", input: {} }] })));
    await run(model, systemBlocks(new Date("2026-09-13T00:00:00Z")), "keep going");
    expect(model.requests.length).toBeGreaterThan(4);
    expect(Math.max(...model.breakpointCounts)).toBeLessThanOrEqual(4);
    // one on the system block, one rolling through the messages
    expect(Math.max(...model.breakpointCounts)).toBe(2);
  });
});
