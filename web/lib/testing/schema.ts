// What the double needs to know about the schema to behave like Postgres +
// PostgREST + RLS: which column owns a row, which policies exist, which
// combinations are unique, and what the column defaults are.
//
// Mirrors supabase/migrations/*.sql. When a migration changes, this changes
// with it; the route tests read every table through here.

export interface TableMeta {
  /** the column RLS compares with auth.uid(); null when the table has no policy for `authenticated` */
  owner: string | null;
  /** false when the table has a select/update policy but no insert policy (profiles) */
  insertable: boolean;
  /** unique constraints, as column lists */
  unique: string[][];
  /** column defaults applied on insert (a function is called per row) */
  defaults: Record<string, unknown | (() => unknown)>;
  /** columns the owner's own UPDATE policy refuses to change (profiles.plan) */
  frozen: string[];
  /** trigger-maintained updated_at */
  touchUpdatedAt: boolean;
}

const NEVER: string[][] = [];

function table(owner: string | null, extra: Partial<TableMeta> = {}): TableMeta {
  return {
    owner,
    insertable: true,
    unique: NEVER,
    defaults: {},
    frozen: [],
    touchUpdatedAt: false,
    ...extra,
  };
}

/** `now()` in the double: every row written in one test shares it unless a test moves it. */
export let NOW = "2026-09-13T12:00:00.000Z";

export function setNow(iso: string): void {
  NOW = iso;
}

const now = () => NOW;

export const TABLES: Record<string, TableMeta> = {
  files: table("user_id", {
    unique: [["user_id", "sha256"]],
    touchUpdatedAt: true,
    defaults: {
      kind: "original",
      status: "uploading",
      analysis_version: 0,
      size_bytes: null,
      duration_s: null,
      sample_rate: null,
      channels: null,
      format: null,
      parent_file_id: null,
      report: null,
      peaks: null,
      title: null,
      artist: null,
      created_at: now,
      updated_at: now,
    },
  }),
  jobs: table("user_id", {
    defaults: {
      file_id: null,
      status: "queued",
      params: {},
      result: null,
      error: null,
      modal_call_id: null,
      progress: null,
      created_at: now,
      started_at: null,
      finished_at: null,
    },
  }),
  loops: table("user_id", {
    defaults: { bars: null, score: null, origin: "finder", components: null, name: null, render_file_id: null, created_at: now },
  }),
  stems: table("user_id", { unique: [["file_id", "model", "stem"]], defaults: { created_at: now } }),
  chops: table("user_id", { defaults: { name: null, chop_file_id: null, created_at: now } }),
  midi: table("user_id", { defaults: { notes: null, created_at: now } }),
  corrections: table("user_id", { defaults: { loop_id: null, created_at: now } }),
  conversations: table("user_id", { touchUpdatedAt: true, defaults: { title: null, file_ids: [], created_at: now, updated_at: now } }),
  messages: table("user_id", { defaults: { tool_calls: null, citations: null, created_at: now } }),
  tags: table("user_id", { unique: [["file_id", "tag", "source"]], defaults: { source: "model", confidence: null, created_at: now } }),
  layers: table("user_id", {
    touchUpdatedAt: true,
    defaults: { name: null, tempo_bpm: null, key: null, render_file_id: null, created_at: now, updated_at: now },
  }),
  layer_items: table("user_id", {
    defaults: {
      offset_s: 0,
      gain_db: 0,
      stretch_ratio: 1,
      pitch_semitones: 0,
      muted: false,
      stretch_mode: "transient",
      filter: null,
      position: 0,
      created_at: now,
    },
  }),
  revoices: table("user_id", { defaults: { midi_id: null, render_file_id: null, keep_groove: false, created_at: now } }),
  breakdowns: table("user_id", { unique: [["file_id", "version"]], defaults: { version: 1, narration: null, created_at: now } }),
  comparisons: table("user_id", { defaults: { created_at: now } }),
  embeddings: table("user_id", { unique: [["file_id", "model"]], defaults: { created_at: now } }),
  beatbox_profiles: table("user_id", {
    unique: [["user_id"]],
    defaults: { sample_count: 0, cv_accuracy: null, enabled: false, classes: [], trained_at: now },
  }),
  profiles: table("id", {
    insertable: false,
    frozen: ["plan"],
    touchUpdatedAt: true,
    defaults: {
      email: null,
      plan: "free",
      plan_status: "active",
      stripe_customer_id: null,
      stripe_subscription_id: null,
      corrections_opt_in: false,
      loop_personalization: true,
      created_at: now,
      updated_at: now,
    },
  }),
  // select-only for the owner; every write comes from the service role
  usage_events: table("user_id", { insertable: false, defaults: { amount: 1, job_id: null, created_at: now } }),
  // no policy at all: the service role is the only way in
  takedowns: table(null, {
    touchUpdatedAt: true,
    defaults: {
      claimant_address: null,
      file_id: null,
      user_id: null,
      status: "received",
      notes: null,
      source_ip: null,
      good_faith: false,
      accuracy_sworn: false,
      created_at: now,
      updated_at: now,
    },
  }),
  web_cache: table(null, { unique: [["key"]], defaults: { created_at: now } }),
};

export function tableMeta(name: string): TableMeta {
  const meta = TABLES[name];
  if (!meta) throw new Error(`The Supabase double has no table "${name}". Add it to lib/testing/schema.ts.`);
  return meta;
}
