import { describe, expect, it } from "vitest";
import { encodeEvent, EventDecoder, parseEvent, type ChatEvent } from "./protocol";

const events: ChatEvent[] = [
  { type: "text", delta: "Kick on " },
  { type: "text", delta: "the one.\n" },
  { type: "tool_call", id: "toolu_1", name: "get_report", input: { file_id: "abc" } },
  { type: "tool_result", id: "toolu_1", name: "get_report", card: { type: "report", file_id: "abc", file_name: "song.wav", vitals: { bpm: 92, bpm_confidence: 0.9, bpm_hedge: "", key: "F minor", key_confidence: 0.7, key_hedge: "likely", meter: "4/4", feel: null, swing_pct: null, duration_s: 10, status: "ready" }, not_analyzed: ["chords"] }, summary: "song.wav: 92 BPM, F minor" },
  { type: "citations", items: [{ url: "https://x.example/", title: "X" }] },
  { type: "done", message_id: "m1", conversation_id: "c1" },
  { type: "error", message: "boom" },
];

describe("streaming protocol", () => {
  it("round-trips every event type, one per line", () => {
    const wire = events.map(encodeEvent).join("");
    expect(wire.split("\n").filter(Boolean)).toHaveLength(events.length);
    const decoder = new EventDecoder();
    expect(decoder.push(wire)).toEqual(events);
    expect(decoder.flush()).toEqual([]);
  });

  it("survives chunk boundaries anywhere, including inside a JSON string", () => {
    const wire = events.map(encodeEvent).join("");
    for (const size of [1, 3, 7, 50, 1000]) {
      const decoder = new EventDecoder();
      const out: ChatEvent[] = [];
      for (let i = 0; i < wire.length; i += size) out.push(...decoder.push(wire.slice(i, i + size)));
      out.push(...decoder.flush());
      expect(out).toEqual(events);
    }
  });

  it("delivers a trailing line without a newline on flush", () => {
    const decoder = new EventDecoder();
    expect(decoder.push('{"type":"text","delta":"a"}')).toEqual([]);
    expect(decoder.flush()).toEqual([{ type: "text", delta: "a" }]);
  });

  it("ignores blank and malformed lines", () => {
    const decoder = new EventDecoder();
    expect(decoder.push('\n\nnot json\n{"type":"nope"}\n{"type":"text","delta":"ok"}\n')).toEqual([{ type: "text", delta: "ok" }]);
    expect(parseEvent("[]")).toBeNull();
    expect(parseEvent("null")).toBeNull();
  });
});
