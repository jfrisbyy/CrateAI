// The tool handlers (BUILD_PACKET section 14). Every handler validates its
// input again with zod, works through the ChatDb interface (the caller's
// session client under RLS in production, memory in tests), queues jobs the
// way the routes do, and returns a ToolOutcome: text for the model, a summary
// and a card for the pane, and the citations any world fact rests on.

import { createHash } from "node:crypto";
import { z } from "zod";
import { buildExportRequest, estimateExport, exportZipName, heldBackTracks, referencedFileIds } from "@/lib/export/song";
import { EXPORT_FORMATS } from "@/lib/export/types";
import { displayKey, PITCH_CLASSES } from "@/lib/music/keys";
import { applyEdit, editRequestSchema, predictedFor, type EditRequest } from "@/lib/report/edits";
import { effective } from "@/lib/report/effective";
import { barsInRange, gridFromReport } from "@/lib/report/grid";
import type { HybridSearchResult } from "@/lib/search/hybrid";
import type { FileRow, JobKind, JobRow, Json, LoopRow } from "@/lib/types/db";
import { REPORT_SECTIONS } from "@/lib/types/report";
import type { WebInfo } from "@/lib/webinfo/types";
import { WebInfoError } from "@/lib/webinfo/types";
import { errorOutcome, outcome, type BatchOperation, type Card, type Citation, type LoopSummary, type ToolCallRecord, type ToolOutcome } from "./cards";
import type { ChatDb } from "./db";
import { WEB_QUOTA_MESSAGE } from "./limits";
import { compactReport, explainReport, fileName, notAnalyzed, vitalsOf, type CompactSection } from "./report";
import { grammarLines, noSessionText, planSteps, readSession, type SessionSnapshot } from "./surfaces";
import { LINK_REFUSAL } from "./system";
import { BATCH_GPU_CONFIRM, BATCH_MAX_OPERATIONS, CHOP_MODES, EDIT_FIELDS, GPU_TOOLS, MIDI_KINDS, REVOICE_PATHS, STEM_MODELS, TOOL_NAMES } from "./tools";

export type DispatchInfo = { ok: true; call_id: string } | { ok: false; reason: string };

export interface ToolContext {
  db: ChatDb;
  userId: string;
  /** lib/compute/dispatch.ts in production; injected so tests stay offline */
  dispatch: (jobId: string) => Promise<DispatchInfo>;
  web: WebInfo;
  librarySearch: (query: string, limit?: number) => Promise<HybridSearchResult>;
  /** mutable for the turn: web searches left today */
  usage: { webSearchesLeft: number };
  now: () => Date;
  currentFileId: string | null;
  /** fingerprint of a batch the producer already confirmed on the pane */
  confirmedBatch?: string | null;
  /**
   * The session open in the producer's browser, as it travelled with this
   * turn. It is here and not in the prompt: only the compact block
   * `lib/chat/surfaces.ts` renders is ever put in front of the model, while
   * the handlers get the real arrangement so the export renders the song the
   * producer is looking at. Null when no session is open.
   */
  session?: SessionSnapshot | null;
  /** the library rows the session's lanes point at, for measured values (bandwidth, key) */
  sessionFiles?: readonly FileRow[];
}

const UUID = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "must be a UUID");
const keySchema = z.object({ tonic: z.enum(PITCH_CLASSES), mode: z.enum(["major", "minor"]) });

export const INPUT_SCHEMAS = {
  get_report: z.object({ file_id: UUID, sections: z.array(z.enum([...REPORT_SECTIONS, "tags", "user_edits"])).max(20).optional() }),
  explain: z.object({ file_id: UUID }),
  find_loops: z.object({
    file_id: UUID,
    bars: z.array(z.number().int().min(1).max(64)).min(1).max(8).optional(),
    top_k: z.number().int().min(1).max(50).optional(),
    refresh: z.boolean().optional(),
  }),
  create_loop: z.object({ file_id: UUID, start_s: z.number().min(0), end_s: z.number().min(0), name: z.string().trim().max(120).optional() }),
  render_loop: z.object({ loop_id: UUID }),
  separate_stems: z.object({ file_id: UUID, model: z.enum(STEM_MODELS).optional() }),
  chop: z.object({
    file_id: UUID,
    mode: z.enum(CHOP_MODES),
    params: z
      .object({
        count: z.number().int().min(1).max(128).optional(),
        min_gap_ms: z.number().min(5).max(2000).optional(),
        start_bar: z.number().int().min(0).optional(),
        end_bar: z.number().int().min(0).optional(),
        divisions: z.number().int().min(1).max(64).optional(),
        markers_s: z.array(z.number().min(0)).max(256).optional(),
      })
      .optional(),
  }),
  extract_midi: z.object({ file_id: UUID, kind: z.enum(MIDI_KINDS) }),
  layer: z.object({
    items: z.array(z.object({ file_id: UUID, gain_db: z.number().min(-60).max(12).optional(), offset_s: z.number().min(-600).max(600).optional() })).min(1).max(8),
    target_tempo: z.number().min(20).max(400).optional(),
    target_key: keySchema.optional(),
    name: z.string().trim().max(120).optional(),
  }),
  revoice: z.object({ file_id: UUID, instrument: z.string().trim().min(1).max(64), path: z.enum(REVOICE_PATHS).optional() }),
  breakdown: z.object({ file_id: UUID, refresh: z.boolean().optional() }),
  compare: z.object({ file_a_id: UUID, file_b_id: UUID }),
  search: z.object({ query: z.string().trim().min(1).max(500), limit: z.number().int().min(1).max(50).optional() }),
  web_search: z.object({ query: z.string().trim().min(1).max(400) }),
  fetch_page: z.object({ url: z.string().trim().min(1).max(2000) }),
  identify_context: z.object({ file_id: UUID }),
  set_edit: z.object({
    file_id: UUID,
    field: z.enum(EDIT_FIELDS),
    value: z.object({
      number: z.number().optional(),
      text: z.string().optional(),
      key: keySchema.optional(),
      section_labels: z.array(z.object({ index: z.number().int().min(0), label: z.string().trim().min(1).max(64) })).max(64).optional(),
    }),
  }),
  embed: z.object({ file_id: UUID }),
  session_control: z.object({ steps: z.array(z.string().trim().min(1).max(200)).min(1).max(8) }),
  read_session: z.object({ bar: z.number().int().min(1).max(9999).optional(), track: z.string().trim().min(1).max(80).optional() }),
  export_song: z.object({ format: z.enum(EXPORT_FORMATS).optional(), include_muted: z.boolean().optional() }),
  batch: z.object({
    operations: z.array(z.object({ tool: z.string(), input_json: z.string() })).min(1).max(BATCH_MAX_OPERATIONS),
    confirmed: z.boolean().optional(),
  }),
} as const;

export type ToolName = keyof typeof INPUT_SCHEMAS;

export const MAX_PAGE_TEXT_FOR_MODEL = 12_000;
const CROSSFADE_MS = 12;

/** Strict tool use never sends nulls for optional fields, but a batch's JSON might. */
function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (v !== null && v !== undefined) out[k] = stripNulls(v);
    return out;
  }
  return value;
}

function issuesText(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
    .join("; ");
}

function loopSummary(loop: LoopRow): LoopSummary {
  return {
    id: loop.id,
    file_id: loop.file_id,
    start_s: loop.start_s,
    end_s: loop.end_s,
    bars: loop.bars,
    name: loop.name,
    score: loop.score,
    origin: loop.origin,
    render_file_id: loop.render_file_id,
  };
}

function jobCard(job: JobRow, label: string, dispatch: DispatchInfo): Card {
  return { type: "job", job_id: job.id, kind: job.kind, file_id: job.file_id, status: job.status, label, dispatch: dispatch.ok ? null : dispatch.reason };
}

function queuedText(what: string, job: JobRow, dispatch: DispatchInfo): string {
  const base = `Queued ${what} (job ${job.id}, kind ${job.kind}). The result lands on the surface and in the library when the job finishes; the card shows its progress.`;
  return dispatch.ok ? base : `${base} Compute is not reachable right now (${dispatch.reason}); the job stays queued and Retry on the library row re-dispatches it.`;
}

async function queue(ctx: ToolContext, kind: JobKind, fileId: string | null, params: Json, label: string, what: string): Promise<ToolOutcome> {
  const job = await ctx.db.insertJob({ file_id: fileId, kind, params });
  const dispatch = await ctx.dispatch(job.id);
  return outcome({
    text: JSON.stringify({ queued: true, job_id: job.id, kind, file_id: fileId, params, dispatch, note: queuedText(what, job, dispatch) }),
    summary: dispatch.ok ? `queued ${label}` : `queued ${label} (compute not reachable)`,
    card: jobCard(job, label, dispatch),
  });
}

async function needFile(ctx: ToolContext, id: string): Promise<FileRow | ToolOutcome> {
  const file = await ctx.db.getFile(id);
  return file ?? errorOutcome(`File ${id} isn't in your library (or the id is wrong). Ask the producer which file they mean, or search the library.`);
}

function isOutcome(v: unknown): v is ToolOutcome {
  return typeof v === "object" && v !== null && "summary" in v && "text" in v && "is_error" in v;
}

function reportCard(file: FileRow): Card {
  const eff = file.report ? effective(file.report) : null;
  return { type: "report", file_id: file.id, file_name: fileName(file), vitals: vitalsOf(file, eff), not_analyzed: eff ? notAnalyzed(eff) : [...REPORT_SECTIONS] };
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

async function getReport(input: z.infer<typeof INPUT_SCHEMAS.get_report>, ctx: ToolContext): Promise<ToolOutcome> {
  const file = await needFile(ctx, input.file_id);
  if (isOutcome(file)) return file;
  if (!file.report) {
    return outcome({
      text: `${fileName(file)} (${file.id}) has no report yet; its status is ${file.status}. Nothing about its audio can be stated until the analysis runs. Every section is not analyzed yet.`,
      summary: `${fileName(file)}: no report yet (${file.status})`,
      card: reportCard(file),
    });
  }
  const eff = effective(file.report);
  const compact = compactReport(file, eff, input.sections as CompactSection[] | undefined);
  const v = vitalsOf(file, eff);
  const missing = notAnalyzed(eff);
  return outcome({
    text: JSON.stringify(compact),
    summary: `${fileName(file)}: ${v.bpm !== null ? `${v.bpm} BPM` : "tempo not analyzed"}, ${v.key ?? "key not analyzed"}${missing.length > 0 ? `; not analyzed: ${missing.join(", ")}` : ""}`,
    card: reportCard(file),
  });
}

async function explain(input: z.infer<typeof INPUT_SCHEMAS.explain>, ctx: ToolContext): Promise<ToolOutcome> {
  const file = await needFile(ctx, input.file_id);
  if (isOutcome(file)) return file;
  if (!file.report) {
    return outcome({
      text: `${fileName(file)} has not been analyzed yet (status ${file.status}); there is nothing to explain until the analysis runs.`,
      summary: `${fileName(file)}: not analyzed yet`,
      card: reportCard(file),
    });
  }
  const eff = effective(file.report);
  return outcome({ text: explainReport(file, eff), summary: `explained ${fileName(file)}`, card: reportCard(file) });
}

async function findLoops(input: z.infer<typeof INPUT_SCHEMAS.find_loops>, ctx: ToolContext): Promise<ToolOutcome> {
  const file = await needFile(ctx, input.file_id);
  if (isOutcome(file)) return file;
  if (!file.report || file.status !== "ready") {
    return errorOutcome(`Finding loops needs the analysis first; ${fileName(file)} is ${file.status}.`);
  }
  const loops = await ctx.db.listLoops(file.id);
  const finder = loops.filter((l) => l.origin === "finder");
  if (finder.length > 0 && !input.refresh) {
    return outcome({
      text: JSON.stringify({ file_id: file.id, loops: finder.map(loopSummary), note: "These are the finder's ranked candidates (score 0-1 from seam, stability, novelty and onset lock). Call again with refresh=true to run the finder again." }),
      summary: `${finder.length} loops on ${fileName(file)}`,
      card: { type: "loops", file_id: file.id, file_name: fileName(file), loops: finder.map(loopSummary), job_id: null },
    });
  }
  const active = await ctx.db.findActiveJob("analyze", file.id, (p) => typeof p === "object" && p !== null && !Array.isArray(p) && p.task === "find_loops");
  if (active) {
    return outcome({
      text: JSON.stringify({ queued: true, job_id: active.id, status: active.status, note: "The loop finder is already running for this file." }),
      summary: `loop finder already ${active.status}`,
      card: jobCard(active, "find loops", { ok: true, call_id: active.modal_call_id ?? "" }),
    });
  }
  return queue(ctx, "analyze", file.id, { task: "find_loops", bars: input.bars ?? [1, 2, 4, 8], top_k: input.top_k ?? 12 }, "find loops", `the loop finder on ${fileName(file)}`);
}

async function createLoop(input: z.infer<typeof INPUT_SCHEMAS.create_loop>, ctx: ToolContext): Promise<ToolOutcome> {
  const file = await needFile(ctx, input.file_id);
  if (isOutcome(file)) return file;
  if (input.end_s <= input.start_s) return errorOutcome("The loop's end must come after its start.");
  if (file.duration_s !== null && input.start_s > file.duration_s) return errorOutcome(`The loop starts after the end of the file (${file.duration_s.toFixed(2)} s).`);
  const grid = gridFromReport(file.report ? effective(file.report) : null);
  const bars = barsInRange(input.start_s, input.end_s, grid);
  const loop = await ctx.db.insertLoop({ file_id: file.id, start_s: input.start_s, end_s: input.end_s, name: input.name ?? null, bars });
  return outcome({
    text: JSON.stringify({ loop: loopSummary(loop), note: "The loop is on the surface with draggable edges; render_loop makes the WAV." }),
    summary: `loop ${input.start_s.toFixed(3)}–${input.end_s.toFixed(3)} s${bars ? ` (${bars} bars)` : ""} on ${fileName(file)}`,
    card: { type: "loop", loop: loopSummary(loop), file_name: fileName(file) },
  });
}

async function renderLoop(input: z.infer<typeof INPUT_SCHEMAS.render_loop>, ctx: ToolContext): Promise<ToolOutcome> {
  const loop = await ctx.db.getLoop(input.loop_id);
  if (!loop) return errorOutcome(`Loop ${input.loop_id} isn't in your library.`);
  return queue(ctx, "render_loop", loop.file_id, { loop_id: loop.id, crossfade_ms: CROSSFADE_MS, snap_zero_crossing: true }, "render loop", `the render of loop ${loop.name ?? loop.id}`);
}

async function separateStems(input: z.infer<typeof INPUT_SCHEMAS.separate_stems>, ctx: ToolContext): Promise<ToolOutcome> {
  const file = await needFile(ctx, input.file_id);
  if (isOutcome(file)) return file;
  const model = input.model ?? "htdemucs_ft";
  const stems = (await ctx.db.listStems(file.id)).filter((s) => s.model === model);
  if (stems.length > 0) {
    const files = await ctx.db.getFiles(stems.map((s) => s.stem_file_id));
    return outcome({
      text: JSON.stringify({ already_separated: true, model, stems: stems.map((s) => ({ stem: s.stem, file_id: s.stem_file_id })) }),
      summary: `${fileName(file)} already has ${stems.length} ${model} stems`,
      card: {
        type: "search",
        query: `stems of ${fileName(file)}`,
        mode: "filters",
        note: null,
        results: files.map((f) => ({ file_id: f.id, name: fileName(f), kind: f.kind, matched: { kind: f.kind } })),
      },
    });
  }
  const active = await ctx.db.findActiveJob("stems", file.id);
  if (active) {
    return outcome({
      text: JSON.stringify({ queued: true, job_id: active.id, status: active.status, note: "Separation is already in flight for this file." }),
      summary: `stems already ${active.status}`,
      card: jobCard(active, "separate stems", { ok: true, call_id: active.modal_call_id ?? "" }),
    });
  }
  return queue(ctx, "stems", file.id, { model }, `stems (${model})`, `stem separation of ${fileName(file)} with ${model}`);
}

async function chop(input: z.infer<typeof INPUT_SCHEMAS.chop>, ctx: ToolContext): Promise<ToolOutcome> {
  const file = await needFile(ctx, input.file_id);
  if (isOutcome(file)) return file;
  if (input.mode === "manual" && !(input.params?.markers_s && input.params.markers_s.length > 0)) return errorOutcome("Manual chops need params.markers_s (seconds).");
  const params: Json = { mode: input.mode, ...(input.params ?? {}) };
  return queue(ctx, "chop", file.id, params, `chop (${input.mode})`, `${input.mode} chops of ${fileName(file)}`);
}

async function extractMidi(input: z.infer<typeof INPUT_SCHEMAS.extract_midi>, ctx: ToolContext): Promise<ToolOutcome> {
  const file = await needFile(ctx, input.file_id);
  if (isOutcome(file)) return file;
  return queue(ctx, "midi", file.id, { kind: input.kind }, `${input.kind} MIDI`, `${input.kind} MIDI extraction from ${fileName(file)}`);
}

async function layer(input: z.infer<typeof INPUT_SCHEMAS.layer>, ctx: ToolContext): Promise<ToolOutcome> {
  const ids = input.items.map((i) => i.file_id);
  const files = await ctx.db.getFiles(ids);
  const missing = ids.filter((id) => !files.some((f) => f.id === id));
  if (missing.length > 0) return errorOutcome(`These files aren't in your library: ${missing.join(", ")}.`);
  const first = files.find((f) => f.id === ids[0]) as FileRow;
  const firstReport = first.report ? effective(first.report) : null;
  const tempo = input.target_tempo ?? firstReport?.tempo?.bpm ?? null;
  const key = input.target_key ?? (firstReport?.key ? { tonic: firstReport.key.tonic, mode: firstReport.key.mode } : null);
  const name = input.name ?? files.map((f) => fileName(f).replace(/\.[a-z0-9]+$/i, "")).slice(0, 2).join(" + ");
  const row = await ctx.db.insertLayer({ name, tempo_bpm: tempo, key });
  const items = await ctx.db.insertLayerItems(input.items.map((it, i) => ({ layer_id: row.id, file_id: it.file_id, gain_db: it.gain_db ?? 0, offset_s: it.offset_s ?? 0, position: i })));
  const job = await ctx.db.insertJob({ file_id: null, kind: "layer", params: { layer_id: row.id } });
  const dispatch = await ctx.dispatch(job.id);
  const card: Card = {
    type: "layer",
    layer_id: row.id,
    name: row.name,
    tempo_bpm: tempo,
    key: key ? displayKey(key.tonic, key.mode) : null,
    items: items.map((it) => ({ file_id: it.file_id, name: fileName(files.find((f) => f.id === it.file_id) as FileRow), gain_db: it.gain_db, offset_s: it.offset_s })),
    job_id: job.id,
  };
  return outcome({
    text: JSON.stringify({ layer_id: row.id, name: row.name, tempo_bpm: tempo, key, items: card.items, job_id: job.id, dispatch, note: queuedText(`the layer render "${row.name}"`, job, dispatch) }),
    summary: `layer "${row.name}" with ${items.length} lanes${tempo ? ` at ${Math.round(tempo)} BPM` : ""}${dispatch.ok ? "" : " (compute not reachable)"}`,
    card,
  });
}

async function revoice(input: z.infer<typeof INPUT_SCHEMAS.revoice>, ctx: ToolContext): Promise<ToolOutcome> {
  const file = await needFile(ctx, input.file_id);
  if (isOutcome(file)) return file;
  const path = input.path ?? "symbolic";
  return queue(ctx, "revoice", file.id, { instrument: input.instrument, path }, `re-voice as ${input.instrument}`, `re-voicing ${fileName(file)} as ${input.instrument} (${path})`);
}

async function breakdown(input: z.infer<typeof INPUT_SCHEMAS.breakdown>, ctx: ToolContext): Promise<ToolOutcome> {
  const file = await needFile(ctx, input.file_id);
  if (isOutcome(file)) return file;
  if (!file.report) return errorOutcome(`${fileName(file)} has no analysis yet (status ${file.status}); the breakdown needs it first.`);
  const latest = await ctx.db.latestBreakdown(file.id);
  const editedAt = file.report.user_edits.edited_at;
  const fresh = latest !== null && !input.refresh && (!editedAt || latest.created_at >= editedAt);
  if (latest && fresh) {
    const sections = latest.content.sections.map((s) => ({
      title: s.title,
      facts: s.facts.map((f) => ({ text: f.text, source: f.source, confidence: f.confidence, hedge: f.hedge, citation: f.citation })),
      not_measured: s.missing.map((m) => m.text),
    }));
    const citations: Citation[] = latest.content.sections.flatMap((s) => s.facts.flatMap((f) => (f.citation ? [{ url: f.citation.url, title: typeof f.citation.title === "string" ? f.citation.title : f.citation.url }] : [])));
    return outcome({
      text: JSON.stringify({ breakdown_id: latest.id, version: latest.version, identified: latest.content.identified, requires: latest.content.requires, sections }),
      summary: `breakdown v${latest.version} of ${fileName(file)}${latest.content.requires.length > 0 ? ` (still needs ${latest.content.requires.join(", ")})` : ""}`,
      card: { type: "breakdown", file_id: file.id, file_name: fileName(file), status: "ready", breakdown_id: latest.id, version: latest.version, job_id: null, requires: latest.content.requires },
      citations,
    });
  }
  const active = await ctx.db.findActiveJob("breakdown", file.id);
  const job = active ?? (await ctx.db.insertJob({ file_id: file.id, kind: "breakdown", params: {} }));
  const dispatch: DispatchInfo = active ? { ok: true, call_id: active.modal_call_id ?? "" } : await ctx.dispatch(job.id);
  return outcome({
    text: JSON.stringify({ queued: true, job_id: job.id, status: job.status, note: `${active ? "The breakdown is already in flight." : queuedText(`the breakdown of ${fileName(file)}`, job, dispatch)} It queues stems and per-stem analysis when they are missing; the document appears in the Breakdown tab.` }),
    summary: active ? `breakdown already ${active.status}` : `queued breakdown of ${fileName(file)}${dispatch.ok ? "" : " (compute not reachable)"}`,
    card: { type: "breakdown", file_id: file.id, file_name: fileName(file), status: "queued", breakdown_id: null, version: null, job_id: job.id, requires: [] },
  });
}

async function compare(input: z.infer<typeof INPUT_SCHEMAS.compare>, ctx: ToolContext): Promise<ToolOutcome> {
  const files = await ctx.db.getFiles([input.file_a_id, input.file_b_id]);
  const a = files.find((f) => f.id === input.file_a_id);
  const b = files.find((f) => f.id === input.file_b_id);
  if (!a || !b) return errorOutcome("One of the files isn't in your library.");
  if (!a.report || !b.report) return errorOutcome("Both files need to be analyzed before comparing.");
  const latest = await ctx.db.latestComparison(a.id, b.id);
  if (latest) {
    return outcome({
      text: JSON.stringify({ comparison_id: latest.id, a: latest.content.a_name, b: latest.content.b_name, deltas: latest.content.deltas, missing: latest.content.missing }),
      summary: `comparison of ${fileName(a)} vs ${fileName(b)}: ${latest.content.deltas.length} deltas`,
      card: {
        type: "compare",
        file_a_id: a.id,
        file_b_id: b.id,
        a_name: fileName(a),
        b_name: fileName(b),
        status: "ready",
        comparison_id: latest.id,
        job_id: null,
        deltas: latest.content.deltas.map((d) => ({ metric: d.metric, text: d.text })),
      },
    });
  }
  const active = await ctx.db.findActiveJob("compare", a.id, (p) => typeof p === "object" && p !== null && !Array.isArray(p) && p.file_b_id === b.id);
  const job = active ?? (await ctx.db.insertJob({ file_id: a.id, kind: "compare", params: { file_a_id: a.id, file_b_id: b.id, a_name: fileName(a), b_name: fileName(b) } }));
  const dispatch: DispatchInfo = active ? { ok: true, call_id: active.modal_call_id ?? "" } : await ctx.dispatch(job.id);
  return outcome({
    text: JSON.stringify({ queued: true, job_id: job.id, status: job.status, note: active ? "The comparison is already in flight." : queuedText(`the comparison of ${fileName(a)} and ${fileName(b)}`, job, dispatch) }),
    summary: active ? `comparison already ${active.status}` : `queued comparison${dispatch.ok ? "" : " (compute not reachable)"}`,
    card: { type: "compare", file_a_id: a.id, file_b_id: b.id, a_name: fileName(a), b_name: fileName(b), status: "queued", comparison_id: null, job_id: job.id, deltas: [] },
  });
}

async function search(input: z.infer<typeof INPUT_SCHEMAS.search>, ctx: ToolContext): Promise<ToolOutcome> {
  const res = await ctx.librarySearch(input.query, input.limit ?? 20);
  const results = res.results.map((r) => ({ file_id: r.file.id, name: fileName(r.file), kind: r.file.kind, matched: r.matched, similarity: r.similarity }));
  return outcome({
    text: JSON.stringify({ query: input.query, parsed: res.parsed, mode: res.mode, note: res.note, results }),
    summary: `${results.length} result${results.length === 1 ? "" : "s"} for "${input.query}"${res.mode === "filters" && res.note ? " (filters only)" : ""}`,
    card: { type: "search", query: input.query, mode: res.mode, note: res.note, results },
  });
}

async function webSearch(input: z.infer<typeof INPUT_SCHEMAS.web_search>, ctx: ToolContext): Promise<ToolOutcome> {
  if (ctx.usage.webSearchesLeft <= 0) return errorOutcome(WEB_QUOTA_MESSAGE);
  ctx.usage.webSearchesLeft -= 1;
  try {
    const { results, cached } = await ctx.web.search(input.query);
    const citations: Citation[] = results.map((r) => ({ url: r.url, title: r.title }));
    if (results.length === 0) {
      return outcome({
        text: `I couldn't find that: no web results for "${input.query}". Say so; do not answer from memory.`,
        summary: `no web results for "${input.query}"`,
        card: { type: "web", kind: "search", query: input.query, items: [], citations: [] },
        searches: 1,
      });
    }
    return outcome({
      text: JSON.stringify({ query: input.query, cached, results, rule: "State world facts only from these results and cite the URL of the one each fact comes from." }),
      summary: `${results.length} web results for "${input.query}"`,
      card: { type: "web", kind: "search", query: input.query, items: results, citations },
      citations,
      searches: 1,
    });
  } catch (err) {
    if (err instanceof WebInfoError) return errorOutcome(`I couldn't search the web: ${err.message}`);
    throw err;
  }
}

async function fetchPage(input: z.infer<typeof INPUT_SCHEMAS.fetch_page>, ctx: ToolContext): Promise<ToolOutcome> {
  const out = await ctx.web.fetchPage(input.url);
  if (!out.ok) {
    const media = out.stage === "url" || out.stage === "content_type" || (out.stage === "redirect" && /won't fetch/.test(out.reason));
    return errorOutcome(media ? `${LINK_REFUSAL} (${out.reason})` : `I couldn't read that page: ${out.reason}.`);
  }
  const text = out.page.text.length > MAX_PAGE_TEXT_FOR_MODEL ? `${out.page.text.slice(0, MAX_PAGE_TEXT_FOR_MODEL)}…` : out.page.text;
  const citation: Citation = { url: out.page.url, title: out.page.title };
  return outcome({
    text: JSON.stringify({ url: out.page.url, title: out.page.title, fetched_at: out.page.fetched_at, cached: out.cached, text, rule: "Cite this page's URL for any fact taken from it." }),
    summary: `read ${out.page.title}`,
    card: { type: "web", kind: "page", query: null, items: [{ title: out.page.title, url: out.page.url, snippet: text.slice(0, 200) }], citations: [citation] },
    citations: [citation],
  });
}

async function identifyContext(input: z.infer<typeof INPUT_SCHEMAS.identify_context>, ctx: ToolContext): Promise<ToolOutcome> {
  const file = await needFile(ctx, input.file_id);
  if (isOutcome(file)) return file;
  if (ctx.usage.webSearchesLeft <= 0) return errorOutcome(WEB_QUOTA_MESSAGE);
  const res = await ctx.web.identifyContext({ original_filename: file.original_filename, title: file.title, artist: file.artist });
  ctx.usage.webSearchesLeft = Math.max(0, ctx.usage.webSearchesLeft - res.searches_run);
  if (!res.identified) {
    return outcome({
      text: `${fileName(file)} isn't identified: it has no title and artist and the filename doesn't read "Artist - Title", so there is nothing to look up. Ask the producer for the title and artist (they can set them on the file), then call identify_context again.`,
      summary: "not identified: no title or artist",
      card: null,
      searches: res.searches_run,
    });
  }
  const citations: Citation[] = [];
  for (const f of res.findings) if (!citations.some((c) => c.url === f.citation.url)) citations.push(f.citation);
  if (res.findings.length === 0) {
    return outcome({
      text: `I couldn't find anything documented about ${res.artist ? `${res.artist} - ` : ""}${res.title} in ${res.searches_run} searches (${res.queries.join("; ")}). Say so rather than guessing.`,
      summary: `nothing found for ${res.title}`,
      card: { type: "web", kind: "context", query: res.queries.join(" | "), items: [], citations: [] },
      searches: res.searches_run,
    });
  }
  return outcome({
    text: JSON.stringify({
      identified: { artist: res.artist, title: res.title },
      queries: res.queries,
      findings: res.findings,
      rule: "Each finding is one sentence from a search snippet; state it as what that source says, with its URL. Nothing here was measured from the audio.",
    }),
    summary: `${res.findings.length} findings for ${res.artist ? `${res.artist} - ` : ""}${res.title}`,
    card: { type: "web", kind: "context", query: res.queries.join(" | "), items: res.findings.map((f) => ({ title: f.citation.title, url: f.citation.url, snippet: f.text, kind: f.kind })), citations },
    citations,
    searches: res.searches_run,
  });
}

function editRequestFrom(input: z.infer<typeof INPUT_SCHEMAS.set_edit>): EditRequest | string {
  const v = input.value;
  let candidate: unknown;
  switch (input.field) {
    case "tempo_bpm":
    case "downbeat_phase":
    case "first_downbeat_s":
      candidate = { field: input.field, value: v.number };
      break;
    case "meter":
      candidate = { field: input.field, value: v.text };
      break;
    case "key":
      candidate = { field: input.field, value: v.key };
      break;
    case "section_labels":
      candidate = { field: input.field, value: Object.fromEntries((v.section_labels ?? []).map((s) => [String(s.index), s.label])) };
      break;
  }
  const parsed = editRequestSchema.safeParse(candidate);
  return parsed.success ? parsed.data : `set_edit ${input.field}: ${issuesText(parsed.error)} (use value.number for tempo_bpm, downbeat_phase and first_downbeat_s; value.text for meter; value.key for key; value.section_labels for section_labels)`;
}

async function setEdit(input: z.infer<typeof INPUT_SCHEMAS.set_edit>, ctx: ToolContext): Promise<ToolOutcome> {
  const file = await needFile(ctx, input.file_id);
  if (isOutcome(file)) return file;
  if (!file.report) return errorOutcome(`${fileName(file)} has not been analyzed yet; edits need a report to attach to.`);
  const edit = editRequestFrom(input);
  if (typeof edit === "string") return errorOutcome(edit);
  const now = ctx.now().toISOString();
  const next = applyEdit(file.report, edit, now);
  const predicted = predictedFor(file.report, edit);
  const updated = await ctx.db.updateFileReport(file.id, next);
  await ctx.db.insertCorrection({ file_id: file.id, field: edit.field, predicted, corrected: edit.value as Json });
  const eff = effective(updated.report ?? next);
  return outcome({
    text: JSON.stringify({ file_id: file.id, field: edit.field, predicted, corrected: edit.value, effective_vitals: vitalsOf(updated, eff), note: "Applied and logged as a correction; from now on the effective report carries this value." }),
    summary: `${edit.field}: ${JSON.stringify(predicted)} → ${JSON.stringify(edit.value)}`,
    card: { type: "edit", file_id: file.id, file_name: fileName(file), field: edit.field, predicted, corrected: edit.value as Json },
  });
}

async function embed(input: z.infer<typeof INPUT_SCHEMAS.embed>, ctx: ToolContext): Promise<ToolOutcome> {
  const file = await needFile(ctx, input.file_id);
  if (isOutcome(file)) return file;
  const active = await ctx.db.findActiveJob("embed", file.id);
  if (active) {
    return outcome({
      text: JSON.stringify({ queued: true, job_id: active.id, status: active.status, note: "An embed job is already in flight for this file." }),
      summary: `embed already ${active.status}`,
      card: jobCard(active, "embed", { ok: true, call_id: active.modal_call_id ?? "" }),
    });
  }
  return queue(ctx, "embed", file.id, {}, "embed", `the CLAP embedding of ${fileName(file)}`);
}

// ---------------------------------------------------------------------------
// the surfaces that live in the producer's browser
// ---------------------------------------------------------------------------
//
// The chat runs here; the session runs there. Rather than grow a second set of
// session mutations on the server, these three tools go through what already
// exists: `lib/session/commands.ts` parses the step, the snapshot the turn
// carried says whether it can be carried out, and the client puts the parsed
// command on the same bus the composer's own command line uses. See the header
// of lib/chat/surfaces.ts for the shape and why.

/** The one tool whose effect needs the client; a batch could not carry it out. */
export const CLIENT_TOOL = "session_control";

async function sessionControl(input: z.infer<typeof INPUT_SCHEMAS.session_control>, ctx: ToolContext): Promise<ToolOutcome> {
  const snapshot = ctx.session ?? null;
  if (!snapshot) return errorOutcome(noSessionText());
  const plan = planSteps(input.steps, snapshot);
  const refusals = plan.refused.map((r) => `"${r.said}" — ${r.note}`);
  if (plan.steps.length === 0) {
    return errorOutcome([`Nothing moved.`, ...refusals, "", "The steps this takes right now:", ...grammarLines(snapshot)].join("\n"));
  }
  return outcome({
    text: JSON.stringify({
      moved: plan.steps.map((s) => ({ said: s.said, line: s.line, bus: s.bus })),
      refused: plan.refused,
      note: "The producer's screen carries these out on the controls themselves while this turn streams, and echoes the same lines under the composer. Say the lines back as they read; do not add a number a line does not have. A step listed under refused did not happen.",
    }),
    summary: [...plan.steps.map((s) => s.line), ...refusals].join("; "),
    card: { type: "directive", steps: plan.steps, refused: plan.refused },
  });
}

async function readSessionTool(input: z.infer<typeof INPUT_SCHEMAS.read_session>, ctx: ToolContext): Promise<ToolOutcome> {
  const snapshot = ctx.session ?? null;
  if (!snapshot) return errorOutcome(noSessionText());
  const reading = readSession(snapshot, input);
  return outcome({
    text: reading.text,
    summary: reading.summary,
    card: {
      type: "session",
      lanes: snapshot.arrangement.tracks.length,
      regions: snapshot.arrangement.regions.length,
      bpm: snapshot.tempo?.bpm ?? null,
      lines: reading.text.split("\n").slice(0, 60),
    },
  });
}

async function exportSong(input: z.infer<typeof INPUT_SCHEMAS.export_song>, ctx: ToolContext): Promise<ToolOutcome> {
  const snapshot = ctx.session ?? null;
  if (!snapshot) return errorOutcome(noSessionText());
  const files = ctx.sessionFiles ?? [];
  const fileOf = (id: string) => files.find((f) => f.id === id);
  const request = buildExportRequest(snapshot.arrangement, {
    name: snapshot.songName ?? "Untitled song",
    bpm: snapshot.tempo?.bpm ?? null,
    beatsPerBar: snapshot.tempo?.beatsPerBar ?? 4,
    masterGain: snapshot.masterGain,
    format: input.format,
    includeMuted: input.include_muted === true,
    // The key is attributed to the record it was measured on, never guessed.
    keyOf: (fileId) => {
      const report = fileOf(fileId)?.report;
      const key = report ? effective(report).key : null;
      return key && key.tonic && key.mode ? { tonic: key.tonic, mode: key.mode } : null;
    },
    nameOf: (fileId) => {
      const file = fileOf(fileId);
      return file ? fileName(file) : null;
    },
  });
  // The same arithmetic the panel and the job use, so a song that cannot be
  // rendered is refused before any compute is spent.
  const estimate = estimateExport(request);
  if (estimate.blocked) return errorOutcome(estimate.blocked);

  // Ownership, under RLS: a record the caller cannot select does not come back.
  const fileIds = referencedFileIds(request.song);
  const found = await ctx.db.getFiles(fileIds);
  const missing = fileIds.filter((id) => !found.some((f) => f.id === id));
  if (missing.length > 0) {
    return errorOutcome(`The song references ${missing.length} record${missing.length === 1 ? "" : "s"} that is not in this library, so nothing was exported.`);
  }

  const held = heldBackTracks(request.song.tracks, request.include_muted === true);
  const job = await ctx.db.insertJob({ file_id: null, kind: "export", params: request as unknown as Json });
  const dispatch = await ctx.dispatch(job.id);
  const label = `export the song (${request.format})`;
  return outcome({
    text: JSON.stringify({
      queued: true,
      job_id: job.id,
      zip: exportZipName(request.song),
      lanes: estimate.tracks,
      regions: estimate.regions,
      length_s: Math.round(estimate.length_s * 100) / 100,
      estimated_bytes: estimate.bytes,
      tempo_map: request.song.bpm !== null,
      not_exported: held.map((h) => ({ name: h.track.name, reason: h.reason })),
      dispatch,
      note: queuedText("the song export", job, dispatch),
    }),
    summary: dispatch.ok ? `queued ${label}: ${estimate.tracks} ${estimate.tracks === 1 ? "lane" : "lanes"}` : `queued ${label} (compute not reachable)`,
    card: jobCard(job, label, dispatch),
  });
}

export function batchFingerprint(operations: BatchOperation[]): string {
  return createHash("sha256").update(JSON.stringify(operations.map((o) => [o.tool, o.input_json]))).digest("hex").slice(0, 16);
}

export function gpuOperationCount(operations: BatchOperation[]): number {
  return operations.filter((o) => GPU_TOOLS.has(o.tool)).length;
}

async function batch(input: z.infer<typeof INPUT_SCHEMAS.batch>, ctx: ToolContext): Promise<ToolOutcome> {
  const operations = input.operations;
  if (operations.some((o) => o.tool === "batch")) return errorOutcome("A batch cannot contain a batch.");
  // A directive is carried out by the producer's screen, and only a top-level
  // tool result reaches it. Inside a batch it would be stored and never
  // applied, which is the one failure worse than a refusal: silence.
  if (operations.some((o) => o.tool === CLIENT_TOOL)) return errorOutcome(`A batch cannot contain ${CLIENT_TOOL}; call it on its own, with its steps in order.`);
  const unknown = operations.filter((o) => !TOOL_NAMES.includes(o.tool)).map((o) => o.tool);
  if (unknown.length > 0) return errorOutcome(`Unknown tools in the batch: ${[...new Set(unknown)].join(", ")}.`);
  const gpu = gpuOperationCount(operations);
  const fingerprint = batchFingerprint(operations);
  const confirmed = input.confirmed === true || ctx.confirmedBatch === fingerprint;
  if (gpu > BATCH_GPU_CONFIRM && !confirmed) {
    const estimate = `${gpu} GPU jobs: stems and re-voicing run on a GPU for seconds each, on the order of a few cents per file (exact metering arrives in Phase 10)`;
    const message = `This batch queues ${gpu} GPU operations across ${operations.length} operations. Confirm before I run it.`;
    return outcome({
      text: JSON.stringify({ needs_confirmation: true, batch_id: fingerprint, gpu_operations: gpu, operations: operations.length, estimate, note: "Tell the producer the count and the estimate; the pane shows a Run button that re-sends the batch confirmed. Do not run the operations one by one to get around this." }),
      summary: `needs confirmation: ${gpu} GPU operations`,
      card: { type: "confirm", batch_id: fingerprint, operations, gpu_count: gpu, estimate, message },
    });
  }
  const items: Array<{ tool: string; summary: string; card: Card | null; is_error: boolean }> = [];
  const nested: ToolCallRecord[] = [];
  const citations: Citation[] = [];
  let searches = 0;
  for (const [i, op] of operations.entries()) {
    let parsedInput: unknown;
    try {
      parsedInput = JSON.parse(op.input_json);
    } catch {
      items.push({ tool: op.tool, summary: "input_json is not valid JSON", card: null, is_error: true });
      continue;
    }
    const out = await runTool(op.tool, parsedInput, ctx);
    items.push({ tool: op.tool, summary: out.summary, card: out.card, is_error: out.is_error });
    nested.push({ id: `${fingerprint}-${i}`, name: op.tool, input: parsedInput as Json, summary: out.summary, card: out.card, is_error: out.is_error, searches: out.searches });
    for (const c of out.citations) if (!citations.some((x) => x.url === c.url)) citations.push(c);
    searches += out.searches ?? 0;
  }
  const failed = items.filter((i) => i.is_error).length;
  return outcome({
    text: JSON.stringify({ ran: items.length, failed, results: items.map((i) => ({ tool: i.tool, ok: !i.is_error, summary: i.summary })) }),
    summary: `batch: ${items.length - failed} of ${items.length} operations ran${failed > 0 ? `, ${failed} failed` : ""}`,
    card: { type: "batch", items },
    citations,
    searches,
    nested,
  });
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

type Handler<N extends ToolName> = (input: z.infer<(typeof INPUT_SCHEMAS)[N]>, ctx: ToolContext) => Promise<ToolOutcome>;

const HANDLERS: { [N in ToolName]: Handler<N> } = {
  get_report: getReport,
  explain,
  find_loops: findLoops,
  create_loop: createLoop,
  render_loop: renderLoop,
  separate_stems: separateStems,
  chop,
  extract_midi: extractMidi,
  layer,
  revoice,
  breakdown,
  compare,
  search,
  web_search: webSearch,
  fetch_page: fetchPage,
  identify_context: identifyContext,
  set_edit: setEdit,
  embed,
  session_control: sessionControl,
  read_session: readSessionTool,
  export_song: exportSong,
  batch,
};

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(INPUT_SCHEMAS, name);
}

/** Validate and run one tool call. Never throws for a bad input or a missing row; those come back as error outcomes the model can read. */
export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  if (!isToolName(name)) return errorOutcome(`There is no tool named ${name}.`);
  const parsed = INPUT_SCHEMAS[name].safeParse(stripNulls(rawInput ?? {}));
  if (!parsed.success) return errorOutcome(`${name}: ${issuesText(parsed.error)}`);
  try {
    const handler = HANDLERS[name] as (input: unknown, ctx: ToolContext) => Promise<ToolOutcome>;
    return await handler(parsed.data, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorOutcome(`${name} failed: ${message}`);
  }
}
