import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { outcome } from "./cards";
import { scriptedModel } from "./fakes";
import { runToolLoop, type ToolLoopInput } from "./loop";
import type { ChatEvent } from "./protocol";
import { CHAT_TOOLS } from "./tools";

function run(model: ReturnType<typeof scriptedModel>, execute?: ToolLoopInput["execute"], maxIterations?: number) {
  const events: ChatEvent[] = [];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: "hello" }];
  const promise = runToolLoop({
    model,
    modelId: "claude-opus-5",
    maxTokens: 1000,
    system: [{ type: "text", text: "sys" }],
    tools: CHAT_TOOLS,
    messages,
    execute:
      execute ??
      (async (call) => outcome({ text: `result of ${call.name}`, summary: `${call.name} done`, citations: call.name === "web_search" ? [{ url: "https://a.example/", title: "A" }] : [] })),
    emit: (e) => events.push(e),
    maxIterations,
  });
  return { events, messages, promise };
}

describe("runToolLoop", () => {
  it("streams text deltas and stops on end_turn", async () => {
    const model = scriptedModel([{ text: "Kick on the one." }]);
    const { events, promise } = run(model);
    const res = await promise;
    expect(res.text).toBe("Kick on the one.");
    expect(res.stopReason).toBe("end_turn");
    expect(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("")).toBe("Kick on the one.");
    expect(model.requests).toHaveLength(1);
    const req = model.requests[0]!;
    expect(req.model).toBe("claude-opus-5");
    expect(req.thinking).toEqual({ type: "adaptive" });
    expect(req.output_config).toEqual({ effort: "medium" });
    expect(req.tools).toHaveLength(CHAT_TOOLS.length);
  });

  it("feeds every tool result of a turn back in ONE user message", async () => {
    const model = scriptedModel([
      { text: "Let me look.", tools: [{ id: "t1", name: "get_report", input: { file_id: "a" } }, { id: "t2", name: "web_search", input: { query: "q" } }] },
      { text: "Done." },
    ]);
    const { events, messages, promise } = run(model);
    const res = await promise;

    expect(model.requests).toHaveLength(2);
    const second = model.requests[1]!.messages;
    expect(second).toHaveLength(3); // user, assistant (tool_use), user (tool_results)
    expect(second[1]?.role).toBe("assistant");
    const last = second[2]!;
    expect(last.role).toBe("user");
    expect(Array.isArray(last.content)).toBe(true);
    const blocks = last.content as Anthropic.ToolResultBlockParam[];
    expect(blocks.map((b) => b.type)).toEqual(["tool_result", "tool_result"]);
    expect(blocks.map((b) => b.tool_use_id)).toEqual(["t1", "t2"]);
    expect(blocks[0]?.content).toBe("result of get_report");
    // user, assistant (tool_use), user (tool_results); the final end_turn message is persisted by the route, not appended here
    expect(messages).toHaveLength(3);

    expect(res.toolCalls.map((c) => c.name)).toEqual(["get_report", "web_search"]);
    expect(res.citations).toEqual([{ url: "https://a.example/", title: "A" }]);
    expect(res.text).toBe("Let me look.\n\nDone.");
    const types = events.map((e) => e.type);
    expect(types.indexOf("tool_call")).toBeLessThan(types.indexOf("tool_result"));
    expect(types.filter((t) => t === "tool_call")).toHaveLength(2);
    // the second iteration's text is separated from the first by a break
    const text = events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join("");
    expect(text).toBe("Let me look.\n\nDone.");
  });

  it("marks a failed tool with is_error and keeps going", async () => {
    const model = scriptedModel([{ tools: [{ id: "t1", name: "get_report", input: {} }] }, { text: "That failed." }]);
    const { promise } = run(model, async () => {
      throw new Error("db down");
    });
    const res = await promise;
    expect(res.toolCalls[0]).toMatchObject({ is_error: true, summary: "get_report failed: db down" });
    const blocks = model.requests[1]!.messages[2]!.content as Anthropic.ToolResultBlockParam[];
    expect(blocks[0]?.is_error).toBe(true);
  });

  it("continues through pause_turn by pushing the assistant turn back", async () => {
    const model = scriptedModel([{ text: "part one", stop: "pause_turn" }, { text: " part two" }]);
    const { promise } = run(model);
    const res = await promise;
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.messages[1]?.role).toBe("assistant");
    expect(res.text).toBe("part one\n\n part two");
  });

  it("says so on refusal and max_tokens", async () => {
    const refused = await run(scriptedModel([{ stop: "refusal" }])).promise;
    expect(refused.text).toContain("declined");
    const cut = await run(scriptedModel([{ text: "half", stop: "max_tokens" }])).promise;
    expect(cut.text).toContain("ran out of room");
  });

  it("caps the number of tool rounds", async () => {
    const forever = scriptedModel(Array.from({ length: 30 }, () => ({ tools: [{ id: "t", name: "get_report", input: {} }] })));
    const res = await run(forever, undefined, 3).promise;
    expect(res.iterations).toBe(3);
    expect(res.text).toContain("stopped after 3 rounds");
  });
});
