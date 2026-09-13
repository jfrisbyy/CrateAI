// What the tool handlers need from the database, as a narrow interface so
// the grounding tests run against an in-memory implementation. The Supabase
// implementation uses the caller's session client, so RLS scopes every row
// to the user; jobs are inserted the same way the routes insert them.

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  BreakdownRow,
  ComparisonRow,
  CorrectionRow,
  Database,
  FileRow,
  JobKind,
  JobRow,
  Json,
  LayerItemRow,
  LayerRow,
  LoopRow,
  StemRow,
} from "@/lib/types/db";
import type { AnalysisReport } from "@/lib/types/report";

export interface ChatDb {
  getFile(id: string): Promise<FileRow | null>;
  getFiles(ids: string[]): Promise<FileRow[]>;
  updateFileReport(id: string, report: AnalysisReport): Promise<FileRow>;
  insertCorrection(row: { file_id: string; field: string; predicted: Json; corrected: Json }): Promise<CorrectionRow>;
  insertJob(row: { file_id: string | null; kind: JobKind; params: Json }): Promise<JobRow>;
  /** a queued or running job of this kind for the file whose params satisfy `match` */
  findActiveJob(kind: JobKind, fileId: string | null, match?: (params: Json) => boolean): Promise<JobRow | null>;
  listLoops(fileId: string): Promise<LoopRow[]>;
  getLoop(id: string): Promise<LoopRow | null>;
  insertLoop(row: { file_id: string; start_s: number; end_s: number; name: string | null; bars: number | null }): Promise<LoopRow>;
  insertLayer(row: { name: string | null; tempo_bpm: number | null; key: { tonic: string; mode: "major" | "minor" } | null }): Promise<LayerRow>;
  insertLayerItems(rows: Array<{ layer_id: string; file_id: string; gain_db: number; offset_s: number; position: number }>): Promise<LayerItemRow[]>;
  latestBreakdown(fileId: string): Promise<BreakdownRow | null>;
  latestComparison(fileAId: string, fileBId: string): Promise<ComparisonRow | null>;
  listStems(fileId: string): Promise<StemRow[]>;
}

function fail(context: string, error: { message: string }): never {
  throw new Error(`${context}: ${error.message}`);
}

export function supabaseChatDb(supabase: SupabaseClient<Database>, userId: string): ChatDb {
  return {
    async getFile(id) {
      const { data, error } = await supabase.from("files").select("*").eq("id", id).maybeSingle();
      if (error) fail("loading the file", error);
      return data;
    },
    async getFiles(ids) {
      if (ids.length === 0) return [];
      const { data, error } = await supabase.from("files").select("*").in("id", ids);
      if (error) fail("loading files", error);
      return data;
    },
    async updateFileReport(id, report) {
      const { data, error } = await supabase.from("files").update({ report }).eq("id", id).select("*").single();
      if (error) fail("saving the edit", error);
      return data;
    },
    async insertCorrection(row) {
      const { data, error } = await supabase.from("corrections").insert({ user_id: userId, ...row }).select("*").single();
      if (error) fail("logging the correction", error);
      return data;
    },
    async insertJob(row) {
      const { data, error } = await supabase
        .from("jobs")
        .insert({ user_id: userId, file_id: row.file_id, kind: row.kind, status: "queued", params: row.params })
        .select("*")
        .single();
      if (error) fail("queueing the job", error);
      return data;
    },
    async findActiveJob(kind, fileId, match) {
      let q = supabase.from("jobs").select("*").eq("kind", kind).in("status", ["queued", "running"]).order("created_at", { ascending: false }).limit(20);
      q = fileId === null ? q.is("file_id", null) : q.eq("file_id", fileId);
      const { data, error } = await q;
      if (error) fail("checking jobs", error);
      return data.find((j) => (match ? match(j.params) : true)) ?? null;
    },
    async listLoops(fileId) {
      const { data, error } = await supabase
        .from("loops")
        .select("*")
        .eq("file_id", fileId)
        .order("score", { ascending: false, nullsFirst: false })
        .order("start_s", { ascending: true })
        .limit(100);
      if (error) fail("listing loops", error);
      return data;
    },
    async getLoop(id) {
      const { data, error } = await supabase.from("loops").select("*").eq("id", id).maybeSingle();
      if (error) fail("loading the loop", error);
      return data;
    },
    async insertLoop(row) {
      const { data, error } = await supabase.from("loops").insert({ user_id: userId, origin: "chat", ...row }).select("*").single();
      if (error) fail("creating the loop", error);
      return data;
    },
    async insertLayer(row) {
      const { data, error } = await supabase.from("layers").insert({ user_id: userId, ...row }).select("*").single();
      if (error) fail("creating the layer", error);
      return data;
    },
    async insertLayerItems(rows) {
      const { data, error } = await supabase
        .from("layer_items")
        .insert(rows.map((r) => ({ user_id: userId, ...r })))
        .select("*");
      if (error) fail("adding layer items", error);
      return data;
    },
    async latestBreakdown(fileId) {
      const { data, error } = await supabase.from("breakdowns").select("*").eq("file_id", fileId).order("version", { ascending: false }).limit(1).maybeSingle();
      if (error) fail("loading the breakdown", error);
      return data;
    },
    async latestComparison(fileAId, fileBId) {
      const { data, error } = await supabase
        .from("comparisons")
        .select("*")
        .eq("file_a_id", fileAId)
        .eq("file_b_id", fileBId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("loading the comparison", error);
      return data;
    },
    async listStems(fileId) {
      const { data, error } = await supabase.from("stems").select("*").eq("file_id", fileId).limit(50);
      if (error) fail("listing stems", error);
      return data;
    },
  };
}
