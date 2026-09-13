// In-memory doubles for the chat tests: a ChatDb, a WebInfo, a library search
// and a scripted model. Nothing here touches the network. Used only by tests.

import type Anthropic from "@anthropic-ai/sdk";
import { emptyReport } from "@/lib/report/effective";
import type { HybridSearchResult } from "@/lib/search/hybrid";
import type { BreakdownRow, ComparisonRow, CorrectionRow, FileRow, JobRow, LayerItemRow, LayerRow, LoopRow, StemRow } from "@/lib/types/db";
import type { AnalysisReport } from "@/lib/types/report";
import type { FetchOutcome, IdentifyResult, SearchResult, WebInfo } from "@/lib/webinfo/types";
import type { ChatDb } from "./db";
import type { ToolContext } from "./handlers";
import type { ChatModel, ModelStream } from "./loop";

let counter = 0;
export function fakeId(): string {
  counter++;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`;
}

const NOW = "2026-09-13T12:00:00.000Z";

export function fakeFile(partial: Partial<FileRow> = {}, report: Partial<AnalysisReport> | null = {}): FileRow {
  const id = partial.id ?? fakeId();
  return {
    id,
    user_id: "user-1",
    sha256: id,
    original_filename: "song.wav",
    storage_path: `library/user-1/${id}.wav`,
    size_bytes: 1000,
    duration_s: 120,
    sample_rate: 44100,
    channels: 2,
    format: "wav",
    kind: "original",
    parent_file_id: null,
    status: "ready",
    analysis_version: 1,
    report:
      report === null
        ? null
        : emptyReport({
            tempo: { bpm: 92, confidence: 0.91, method: "tempogram", alternates_bpm: [46, 184], notes: null },
            key: { tonic: "F", mode: "minor", confidence: 0.7, method: "krumhansl", alternate: { tonic: "G#", mode: "major", correlation: 0.6 }, notes: null },
            beats: {
              times_s: Array.from({ length: 64 }, (_, i) => i * (60 / 92)),
              confidence: 0.85,
              method: "beat_track",
              downbeats_s: Array.from({ length: 16 }, (_, i) => i * 4 * (60 / 92)),
              downbeat_phase: 0,
              downbeat_confidence: 0.75,
              downbeat_method: "low-band",
              meter: "4/4",
              notes: null,
            },
            ...report,
          }),
    peaks: null,
    title: null,
    artist: null,
    created_at: NOW,
    updated_at: NOW,
    ...partial,
  };
}

export class MemoryChatDb implements ChatDb {
  files = new Map<string, FileRow>();
  jobs: JobRow[] = [];
  loops: LoopRow[] = [];
  layers: LayerRow[] = [];
  layerItems: LayerItemRow[] = [];
  corrections: CorrectionRow[] = [];
  breakdowns: BreakdownRow[] = [];
  comparisons: ComparisonRow[] = [];
  stems: StemRow[] = [];

  constructor(files: FileRow[] = []) {
    for (const f of files) this.files.set(f.id, f);
  }

  async getFile(id: string) {
    return this.files.get(id) ?? null;
  }
  async getFiles(ids: string[]) {
    return ids.map((id) => this.files.get(id)).filter((f): f is FileRow => f !== undefined);
  }
  async updateFileReport(id: string, report: AnalysisReport) {
    const file = this.files.get(id);
    if (!file) throw new Error("missing file");
    const next = { ...file, report, updated_at: NOW };
    this.files.set(id, next);
    return next;
  }
  async insertCorrection(row: { file_id: string; field: string; predicted: CorrectionRow["predicted"]; corrected: CorrectionRow["corrected"] }) {
    const c: CorrectionRow = { id: fakeId(), user_id: "user-1", created_at: NOW, ...row };
    this.corrections.push(c);
    return c;
  }
  async insertJob(row: { file_id: string | null; kind: JobRow["kind"]; params: JobRow["params"] }) {
    const job: JobRow = {
      id: fakeId(),
      user_id: "user-1",
      file_id: row.file_id,
      kind: row.kind,
      status: "queued",
      params: row.params,
      result: null,
      error: null,
      modal_call_id: null,
      progress: null,
      created_at: NOW,
      started_at: null,
      finished_at: null,
    };
    this.jobs.push(job);
    return job;
  }
  async findActiveJob(kind: JobRow["kind"], fileId: string | null, match?: (params: JobRow["params"]) => boolean) {
    return this.jobs.find((j) => j.kind === kind && j.file_id === fileId && (j.status === "queued" || j.status === "running") && (match ? match(j.params) : true)) ?? null;
  }
  async listLoops(fileId: string) {
    return this.loops.filter((l) => l.file_id === fileId);
  }
  async getLoop(id: string) {
    return this.loops.find((l) => l.id === id) ?? null;
  }
  async insertLoop(row: { file_id: string; start_s: number; end_s: number; name: string | null; bars: number | null }) {
    const loop: LoopRow = { id: fakeId(), user_id: "user-1", origin: "chat", score: null, components: null, render_file_id: null, created_at: NOW, ...row };
    this.loops.push(loop);
    return loop;
  }
  async insertLayer(row: { name: string | null; tempo_bpm: number | null; key: LayerRow["key"] }) {
    const layer: LayerRow = { id: fakeId(), user_id: "user-1", render_file_id: null, created_at: NOW, updated_at: NOW, ...row };
    this.layers.push(layer);
    return layer;
  }
  async insertLayerItems(rows: Array<{ layer_id: string; file_id: string; gain_db: number; offset_s: number; position: number }>) {
    const items = rows.map<LayerItemRow>((r) => ({
      id: fakeId(),
      user_id: "user-1",
      stretch_ratio: 1,
      pitch_semitones: 0,
      muted: false,
      stretch_mode: "transient",
      filter: null,
      created_at: NOW,
      ...r,
    }));
    this.layerItems.push(...items);
    return items;
  }
  async latestBreakdown(fileId: string) {
    return [...this.breakdowns].filter((b) => b.file_id === fileId).sort((a, b) => b.version - a.version)[0] ?? null;
  }
  async latestComparison(a: string, b: string) {
    return this.comparisons.find((c) => c.file_a_id === a && c.file_b_id === b) ?? null;
  }
  async listStems(fileId: string) {
    return this.stems.filter((s) => s.file_id === fileId);
  }
}

export interface FakeWebOptions {
  results?: Record<string, SearchResult[]>;
  pages?: Record<string, FetchOutcome>;
  identify?: IdentifyResult;
}

export function fakeWeb(opts: FakeWebOptions = {}): WebInfo & { searched: string[]; fetched: string[] } {
  const searched: string[] = [];
  const fetched: string[] = [];
  return {
    provider: "brave",
    searched,
    fetched,
    async search(query) {
      searched.push(query);
      return { results: opts.results?.[query] ?? [], cached: false };
    },
    async fetchPage(url) {
      fetched.push(url);
      return opts.pages?.[url] ?? { ok: false, reason: "no such page in the fake", stage: "request" };
    },
    async identifyContext() {
      return opts.identify ?? { identified: false, artist: null, title: null, queries: [], findings: [], searches_run: 0 };
    },
  };
}

export function fakeSearch(result?: Partial<HybridSearchResult>): ToolContext["librarySearch"] {
  return async (query) => ({
    results: [],
    parsed: {
      text_query: query,
      bpm_min: null,
      bpm_max: null,
      tonic: null,
      mode: null,
      kind: null,
      tags: [],
      has_drums: null,
      is_loop_based: null,
      similar: false,
      similar_to_file_id: null,
      parser: "rules",
    },
    mode: "filters",
    note: null,
    ...result,
  });
}

export function fakeContext(db: ChatDb, partial: Partial<ToolContext> = {}): ToolContext {
  return {
    db,
    userId: "user-1",
    dispatch: async (jobId) => ({ ok: true, call_id: `call-${jobId}` }),
    web: fakeWeb(),
    librarySearch: fakeSearch(),
    usage: { webSearchesLeft: 20 },
    now: () => new Date(NOW),
    currentFileId: null,
    confirmedBatch: null,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// a scripted model
// ---------------------------------------------------------------------------

export type Scripted = { text?: string; tools?: Array<{ id: string; name: string; input: unknown }>; stop?: Anthropic.StopReason };

function toMessage(s: Scripted): Anthropic.Message {
  const content: Anthropic.ContentBlock[] = [];
  if (s.text) content.push({ type: "text", text: s.text, citations: null });
  for (const t of s.tools ?? []) content.push({ type: "tool_use", id: t.id, name: t.name, input: t.input, caller: { type: "direct" } });
  return {
    id: "msg_fake",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    content,
    container: null,
    stop_reason: s.stop ?? (s.tools && s.tools.length > 0 ? "tool_use" : "end_turn"),
    stop_details: null,
    stop_sequence: null,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
      inference_geo: null,
      iterations: null,
      speed: null,
      output_tokens_details: null,
    } as unknown as Anthropic.Usage,
  };
}

/** Plays the scripted turns in order; records every request's params. */
export function scriptedModel(turns: Scripted[]): ChatModel & { requests: Anthropic.MessageStreamParams[] } {
  const requests: Anthropic.MessageStreamParams[] = [];
  let i = 0;
  return {
    requests,
    stream(params) {
      requests.push(structuredClone(params));
      const turn = turns[i] ?? { text: "", stop: "end_turn" };
      i++;
      const listeners: Array<(delta: string) => void> = [];
      const stream: ModelStream = {
        on(event, listener) {
          if (event === "text") listeners.push(listener);
          return stream;
        },
        async finalMessage() {
          if (turn.text) for (const chunk of turn.text.match(/.{1,5}/gs) ?? []) for (const l of listeners) l(chunk);
          return toMessage(turn);
        },
      };
      return stream;
    },
  };
}
