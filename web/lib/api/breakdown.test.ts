import { describe, expect, it } from "vitest";
import { encodeNarrationEvent, NarrationEventParser, type NarrationWireEvent } from "@/lib/narration/stream";
import { readNarrationStream } from "./breakdown";
import { ApiError } from "./client";

const events: NarrationWireEvent[] = [
  { type: "paragraph", text: "The vitals. Likely it sits at 92 BPM." },
  { type: "note", text: "One line was removed because it said something that wasn't measured; the facts below are complete." },
  { type: "paragraph", text: "The recipe.\n1. Find a 4-bar loop around 92 in F minor." },
  { type: "done", text: "The vitals. Likely it sits at 92 BPM.\n\nThe recipe.\n1. Find a 4-bar loop around 92 in F minor.", source: "model", removed: 1, stop: "end_turn", saved: true, version: 2 },
];

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
}

describe("the narration wire format", () => {
  it("round-trips events through the line parser whatever the chunk boundaries", () => {
    const wire = events.map(encodeNarrationEvent).join("");
    for (const size of [1, 5, 17, 1000]) {
      const parser = new NarrationEventParser();
      const got: NarrationWireEvent[] = [];
      for (let i = 0; i < wire.length; i += size) got.push(...parser.push(wire.slice(i, i + size)));
      got.push(...parser.flush());
      expect(got).toEqual(events);
    }
  });

  it("keeps a trailing line without a newline until flush and skips noise", () => {
    const parser = new NarrationEventParser();
    expect(parser.push('{"type":"note","text":"a"}\nnot json\n{"type":"paragraph","text":"b"}')).toEqual([{ type: "note", text: "a" }]);
    expect(parser.flush()).toEqual([{ type: "paragraph", text: "b" }]);
    expect(parser.flush()).toEqual([]);
  });
});

describe("readNarrationStream", () => {
  it("delivers every event from a streaming response", async () => {
    const wire = events.map(encodeNarrationEvent).join("");
    const res = new Response(streamOf([wire.slice(0, 40), wire.slice(40, 90), wire.slice(90)]), {
      status: 200,
      headers: { "content-type": "application/x-ndjson; charset=utf-8" },
    });
    const got: NarrationWireEvent[] = [];
    await readNarrationStream(res, (e) => got.push(e));
    expect(got).toEqual(events);
  });

  it("turns an error response into an ApiError with the route's message", async () => {
    const res = new Response(JSON.stringify({ error: "No breakdown yet. Run the breakdown first.", details: null }), { status: 404 });
    await expect(readNarrationStream(res, () => {})).rejects.toMatchObject({ name: "ApiError", status: 404, message: "No breakdown yet. Run the breakdown first." });
    const plain = new Response("gateway timeout", { status: 504, statusText: "Gateway Timeout" });
    await expect(readNarrationStream(plain, () => {})).rejects.toBeInstanceOf(ApiError);
  });
});
