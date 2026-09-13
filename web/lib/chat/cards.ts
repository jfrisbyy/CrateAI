// What a tool hands back: text for the model, a one-line summary for the
// transcript, a card for the pane, and the citations any world fact rests
// on. Cards are plain JSON so they persist in messages.tool_calls and render
// again from the rows.

import type { Matched } from "@/lib/search/merge";
import type { FileKind, FileStatus, JobKind, JobStatus, Json, LoopOrigin } from "@/lib/types/db";

export interface Citation {
  url: string;
  title: string;
}

export interface LoopSummary {
  id: string;
  file_id: string;
  start_s: number;
  end_s: number;
  bars: number | null;
  name: string | null;
  score: number | null;
  origin: LoopOrigin;
  render_file_id: string | null;
}

export interface Vitals {
  bpm: number | null;
  bpm_confidence: number | null;
  bpm_hedge: string;
  key: string | null;
  key_confidence: number | null;
  key_hedge: string;
  meter: string | null;
  feel: string | null;
  swing_pct: number | null;
  duration_s: number | null;
  status: FileStatus;
}

export interface BatchOperation {
  tool: string;
  /** the operation's input, as a JSON object string (the batch schema stays strict) */
  input_json: string;
}

export type Card =
  | { type: "job"; job_id: string; kind: JobKind; file_id: string | null; status: JobStatus; label: string; dispatch: string | null }
  | { type: "loop"; loop: LoopSummary; file_name: string }
  | { type: "loops"; file_id: string; file_name: string; loops: LoopSummary[]; job_id: string | null }
  | {
      type: "layer";
      layer_id: string;
      name: string | null;
      tempo_bpm: number | null;
      key: string | null;
      items: Array<{ file_id: string; name: string; gain_db: number; offset_s: number }>;
      job_id: string | null;
    }
  | {
      type: "breakdown";
      file_id: string;
      file_name: string;
      status: "ready" | "queued";
      breakdown_id: string | null;
      version: number | null;
      job_id: string | null;
      requires: string[];
    }
  | {
      type: "compare";
      file_a_id: string;
      file_b_id: string;
      a_name: string;
      b_name: string;
      status: "ready" | "queued";
      comparison_id: string | null;
      job_id: string | null;
      deltas: Array<{ metric: string; text: string }>;
    }
  | {
      type: "search";
      query: string;
      mode: "vector" | "filters";
      note: string | null;
      results: Array<{ file_id: string; name: string; kind: FileKind; matched: Matched; similarity?: number }>;
    }
  | {
      type: "web";
      kind: "search" | "page" | "context";
      query: string | null;
      items: Array<{ title: string; url: string; snippet: string; kind?: string }>;
      citations: Citation[];
    }
  | { type: "edit"; file_id: string; file_name: string; field: string; predicted: Json; corrected: Json }
  | { type: "report"; file_id: string; file_name: string; vitals: Vitals; not_analyzed: string[] }
  | { type: "confirm"; batch_id: string; operations: BatchOperation[]; gpu_count: number; estimate: string; message: string }
  | { type: "batch"; items: Array<{ tool: string; summary: string; card: Card | null; is_error: boolean }> };

export type CardType = Card["type"];

export interface ToolOutcome {
  /** what the model reads (JSON or prose) */
  text: string;
  /** one line for the transcript and the tool row */
  summary: string;
  card: Card | null;
  /** every world fact in `text` traces to one of these */
  citations: Citation[];
  is_error: boolean;
  /** web searches this call spent, for the daily count */
  searches?: number;
  /** batch: the nested records, so counts can be read back from the row */
  nested?: ToolCallRecord[];
}

/** One entry of messages.tool_calls. */
export interface ToolCallRecord {
  id: string;
  name: string;
  input: Json;
  summary: string;
  card: Card | null;
  is_error: boolean;
  searches?: number;
  nested?: ToolCallRecord[];
}

export function outcome(partial: Partial<ToolOutcome> & { text: string; summary: string }): ToolOutcome {
  return { card: null, citations: [], is_error: false, ...partial };
}

export function errorOutcome(text: string): ToolOutcome {
  return { text, summary: text, card: null, citations: [], is_error: true };
}
