// The wire shape of POST /api/breakdowns/[fileId]/narrate: newline-delimited
// JSON, one event per line, so the panel can show validated paragraphs as
// they land and still learn how it ended. Shared by the route and the
// browser client; nothing here is server-only.

import type { NarratorStop } from "./narrator";
import type { NarrationEvent, NarrationSource } from "./run";

export type NarrationWireEvent =
  | NarrationEvent
  | {
      type: "done";
      /** the text that was saved (or, for the measured document, shown) */
      text: string;
      source: NarrationSource;
      removed: number;
      stop: NarratorStop | null;
      /** true when the narration was written to breakdowns.narration */
      saved: boolean;
      version: number;
    }
  | { type: "error"; message: string };

export const NARRATION_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

export function encodeNarrationEvent(event: NarrationWireEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * Incremental line parser: feed it chunks, get complete events back. The
 * remainder of a partial line is kept until the next chunk (or `flush`).
 */
export class NarrationEventParser {
  private rest = "";

  push(chunk: string): NarrationWireEvent[] {
    this.rest += chunk;
    const lines = this.rest.split("\n");
    this.rest = lines.pop() ?? "";
    return lines.map(parseLine).filter((e): e is NarrationWireEvent => e !== null);
  }

  flush(): NarrationWireEvent[] {
    const tail = this.rest;
    this.rest = "";
    const event = parseLine(tail);
    return event ? [event] : [];
  }
}

function parseLine(line: string): NarrationWireEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as { type?: unknown };
    if (!value || typeof value !== "object" || typeof value.type !== "string") return null;
    return value as NarrationWireEvent;
  } catch {
    return null;
  }
}
