// The streaming tool loop (BUILD_PACKET section 14): one turn of the chat.
//
//   stream -> text deltas out as they arrive -> final message
//     end_turn                        stop
//     pause_turn                      push the assistant turn, continue
//     tool_use                        push the assistant turn, run every tool,
//                                     push ONE user message with all results, loop
//     refusal / max_tokens / other    say so, stop
//
// The model is an interface so the tests script it; the real one is
// `client.messages.stream` from lib/anthropic/client.ts.
//
// ---------------------------------------------------------------------------
// Prompt caching
// ---------------------------------------------------------------------------
//
// The cache is a prefix match and the render order is tools, then system, then
// messages, so a breakpoint on the last system block covers both the tool
// schemas and the frozen system prompt — about 7,000 tokens, two thirds of a
// typical turn's input. The route places that one (app/api/chat/route.ts) and
// keeps everything volatile after it: the date, the attached files and the
// open file's report are the second system block, and the producer's question
// is a message.
//
// This file places the second breakpoint: a rolling one on the last tool
// result of each round, the standard multi-turn placement. A turn that calls
// tools sends the whole conversation again on every round, so round three
// reads back what round two wrote instead of paying full input price for it.
// It rolls rather than accumulating because a request may carry at most four
// breakpoints and a turn may run twelve rounds; moving a `cache_control`
// marker does not invalidate anything, since the markers are not part of the
// cache key (blocks marked by an earlier request stay readable).
//
// Verification is `caching.test.ts`, which drives this loop against a model
// that implements the prefix rule and asserts the second request reports
// non-zero `cache_read_input_tokens`. Live: see docs/HANDOFF_launch_readiness.md.

import type Anthropic from "@anthropic-ai/sdk";
import type { Json } from "@/lib/types/db";
import { errorOutcome, type Citation, type ToolCallRecord, type ToolOutcome } from "./cards";
import type { ChatEvent } from "./protocol";

export interface ModelStream {
  on(event: "text", listener: (delta: string) => void): unknown;
  finalMessage(): Promise<Anthropic.Message>;
}

export interface ChatModel {
  stream(params: Anthropic.MessageStreamParams): ModelStream;
}

export const MAX_TOOL_ITERATIONS = 12;
/** a tool result larger than this is clipped before it reaches the model */
export const MAX_TOOL_RESULT_CHARS = 30_000;

export interface ToolLoopInput {
  model: ChatModel;
  modelId: string;
  maxTokens: number;
  system: Anthropic.TextBlockParam[];
  tools: Anthropic.Tool[];
  /** the conversation so far, ending with the new user message; the loop appends to it */
  messages: Anthropic.MessageParam[];
  execute: (call: { id: string; name: string; input: unknown }) => Promise<ToolOutcome>;
  emit: (event: ChatEvent) => void;
  maxIterations?: number;
}

export interface ToolLoopResult {
  /** the assistant's text, every iteration's text blocks joined */
  text: string;
  toolCalls: ToolCallRecord[];
  citations: Citation[];
  stopReason: Anthropic.StopReason | null;
  iterations: number;
}

function clip(text: string): string {
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[clipped: ${text.length - MAX_TOOL_RESULT_CHARS} more characters]` : text;
}

export async function runToolLoop(input: ToolLoopInput): Promise<ToolLoopResult> {
  const maxIterations = input.maxIterations ?? MAX_TOOL_ITERATIONS;
  const messages = input.messages;
  const textParts: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const citations = new Map<string, Citation>();
  let stopReason: Anthropic.StopReason | null = null;
  let iterations = 0;
  let emittedAny = false;
  /** where the rolling message breakpoint currently sits, so it can be moved */
  let cachedBlock: Anthropic.ToolResultBlockParam | null = null;

  const say = (text: string) => {
    input.emit({ type: "text", delta: emittedAny ? `\n\n${text}` : text });
    textParts.push(text);
    emittedAny = true;
  };

  for (;;) {
    if (iterations >= maxIterations) {
      say(`I stopped after ${maxIterations} rounds of tool calls; ask me to continue if there is more to do.`);
      break;
    }
    iterations++;

    let iterText = "";
    const stream = input.model.stream({
      model: input.modelId,
      max_tokens: input.maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: input.system,
      tools: input.tools,
      messages,
    });
    stream.on("text", (delta) => {
      if (iterText === "" && emittedAny) input.emit({ type: "text", delta: "\n\n" });
      iterText += delta;
      emittedAny = true;
      input.emit({ type: "text", delta });
    });
    const message = await stream.finalMessage();
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    if (text) textParts.push(text);
    stopReason = message.stop_reason;

    if (stopReason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }

    if (stopReason === "tool_use") {
      const uses = message.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      messages.push({ role: "assistant", content: message.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of uses) {
        input.emit({ type: "tool_call", id: use.id, name: use.name, input: use.input as Json });
        let out: ToolOutcome;
        try {
          out = await input.execute({ id: use.id, name: use.name, input: use.input });
        } catch (err) {
          out = errorOutcome(`${use.name} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        for (const c of out.citations) citations.set(c.url, c);
        toolCalls.push({
          id: use.id,
          name: use.name,
          input: use.input as Json,
          summary: out.summary,
          card: out.card,
          is_error: out.is_error,
          ...(out.searches !== undefined ? { searches: out.searches } : {}),
          ...(out.nested ? { nested: out.nested } : {}),
        });
        input.emit({ type: "tool_result", id: use.id, name: use.name, card: out.card, summary: out.summary, ...(out.is_error ? { is_error: true } : {}) });
        results.push({ type: "tool_result", tool_use_id: use.id, content: clip(out.text), ...(out.is_error ? { is_error: true } : {}) });
      }
      // every result in ONE user message, so parallel calls stay parallel
      messages.push({ role: "user", content: results });
      // roll the message breakpoint onto the end of what the next request will
      // send, so the round after it reads this prefix back instead of paying
      // full input price for it
      const last = results[results.length - 1];
      if (last) {
        if (cachedBlock) delete cachedBlock.cache_control;
        last.cache_control = { type: "ephemeral" };
        cachedBlock = last;
      }
      continue;
    }

    if (stopReason === "refusal") {
      say("I declined that request.");
    } else if (stopReason === "max_tokens") {
      say("I ran out of room for this answer; ask me to continue.");
    } else if (stopReason === "model_context_window_exceeded") {
      say("This conversation is longer than I can hold; start a new one and attach the files again.");
    }
    break;
  }

  return { text: textParts.join("\n\n"), toolCalls, citations: [...citations.values()], stopReason, iterations };
}
