// The in-memory database behind the Supabase double: rows, storage objects,
// RPCs, and the rules Postgres would apply (RLS by owner column, unique
// constraints, storage prefix policies).
//
// It is deliberately not a SQL engine. It models exactly what the route
// handlers do: equality and membership filters, ordering, limits, column
// projection, single/maybeSingle, counts, and the ownership boundary.

import { tableMeta, NOW } from "./schema";
import type { FileRow, Json } from "@/lib/types/db";

export type Row = Record<string, unknown>;

export interface DbError {
  message: string;
  details: string;
  hint: string;
  code: string;
}

export function dbErr(code: string, message: string, details = ""): DbError {
  return { code, message, details, hint: "" };
}

export const RLS_DENIED = () => dbErr("42501", 'new row violates row-level security policy');
export const NOT_ONE_ROW = (n: number) =>
  dbErr(
    "PGRST116",
    n === 0 ? "JSON object requested, multiple (or no) rows returned" : "JSON object requested, multiple (or no) rows returned",
    `The result contains ${n} rows`,
  );
export const UNIQUE_VIOLATION = (table: string, cols: string[]) =>
  dbErr("23505", `duplicate key value violates unique constraint "${table}_${cols.join("_")}_key"`);

let seq = 0;

/** Deterministic uuids so a failing assertion reads the same on every run. */
export function testUuid(prefix = 0): string {
  seq += 1;
  return `00000000-0000-4000-8${prefix % 10}00-${String(seq).padStart(12, "0")}`;
}

export function resetUuids(): void {
  seq = 0;
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

export interface StorageObject {
  path: string;
  bytes: Uint8Array;
  contentType: string;
  created_at: string;
}

/** The bucket policies from the init migration, as predicates. */
export const storagePolicy = {
  /** select and delete: the second path segment is the caller */
  read(path: string, userId: string | null): boolean {
    return userId !== null && path.split("/")[1] === userId;
  },
  /** insert and update: only under library/{uid}/ */
  write(path: string, userId: string | null): boolean {
    return userId !== null && path.startsWith(`library/${userId}/`);
  },
};

// ---------------------------------------------------------------------------
// the database
// ---------------------------------------------------------------------------

export type RpcHandler = (args: Record<string, unknown>, actor: string | null, db: TestDb) => { data: unknown; error: DbError | null };

export class TestDb {
  readonly tables = new Map<string, Row[]>();
  readonly objects = new Map<string, StorageObject>();
  readonly rpcs = new Map<string, RpcHandler>();

  constructor() {
    for (const name of ["files", "jobs", "loops", "stems", "chops", "midi", "corrections", "conversations", "messages", "tags",
      "layers", "layer_items", "revoices", "breakdowns", "comparisons", "embeddings", "beatbox_profiles", "profiles",
      "usage_events", "takedowns", "web_cache"]) {
      this.tables.set(name, []);
    }
    installDefaultRpcs(this);
  }

  rows(table: string): Row[] {
    tableMeta(table);
    const rows = this.tables.get(table);
    if (!rows) {
      const fresh: Row[] = [];
      this.tables.set(table, fresh);
      return fresh;
    }
    return rows;
  }

  /** Insert rows straight into a table, bypassing every policy: the fixture door. */
  seed<T extends Row>(table: string, ...rows: T[]): T[] {
    const meta = tableMeta(table);
    const out: T[] = [];
    for (const row of rows) {
      const full = { ...applyDefaults(meta.defaults, row) } as T;
      this.rows(table).push(full);
      out.push(full);
    }
    return out;
  }

  find(table: string, id: string): Row | undefined {
    return this.rows(table).find((r) => r.id === id);
  }

  /** A stored object, seeded without a policy check. */
  putObject(path: string, bytes: Uint8Array | string, contentType = "application/octet-stream"): StorageObject {
    const object: StorageObject = {
      path,
      bytes: typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes,
      contentType,
      created_at: NOW,
    };
    this.objects.set(path, object);
    return object;
  }

  setRpc(name: string, handler: RpcHandler): void {
    this.rpcs.set(name, handler);
  }
}

export function applyDefaults(defaults: Record<string, unknown | (() => unknown)>, row: Row): Row {
  const out: Row = { id: testUuid(), ...row };
  for (const [key, value] of Object.entries(defaults)) {
    if (out[key] === undefined) out[key] = typeof value === "function" ? (value as () => unknown)() : clone(value);
  }
  return out;
}

export function clone<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return structuredClone(value);
}

// ---------------------------------------------------------------------------
// the RPCs the routes call
// ---------------------------------------------------------------------------

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function reportValue(row: Row, path: string[]): unknown {
  let cursor: unknown = row.report;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor ?? null;
}

const DRUM_TAGS = new Set(["drums", "drum break", "drum machine", "kick", "snare", "hi-hat", "percussion loop"]);

function hasDrumTag(db: TestDb, fileId: string): boolean {
  return db.rows("tags").some((t) => t.file_id === fileId && DRUM_TAGS.has(String(t.tag)));
}

/** user_edits.tempo_bpm wins over the analyzed tempo, as the SQL's coalesce does. */
function effectiveBpm(row: Row): number | null {
  const edited = reportValue(row, ["user_edits", "tempo_bpm"]);
  if (typeof edited === "number") return edited;
  const analyzed = reportValue(row, ["tempo", "bpm"]);
  return typeof analyzed === "number" ? analyzed : null;
}

function effectiveKey(row: Row, field: "tonic" | "mode"): unknown {
  return reportValue(row, ["user_edits", "key", field]) ?? reportValue(row, ["key", field]);
}

function installDefaultRpcs(db: TestDb): void {
  // usage_summary: security invoker, so it sees only the caller's rows.
  db.setRpc("usage_summary", (args, actor) => {
    if (!actor) return { data: [], error: null };
    const since = typeof args.p_since === "string" ? args.p_since : "";
    const totals = new Map<string, number>();
    for (const event of db.rows("usage_events")) {
      if (event.user_id !== actor) continue;
      if (since && String(event.created_at) < since) continue;
      const kind = String(event.kind);
      totals.set(kind, (totals.get(kind) ?? 0) + num(event.amount));
    }
    const storage = db.rows("files").filter((f) => f.user_id === actor).reduce((sum, f) => sum + num(f.size_bytes), 0);
    const rows = [...totals].map(([kind, total]) => ({ kind, total }));
    rows.push({ kind: "storage_bytes", total: storage });
    return { data: rows, error: null };
  });

  // library_filter: a faithful port of the SQL in
  // supabase/migrations/20260913000200_search.sql, including the user_edits
  // fallbacks, the drum-tag existence test and the ilike name match.
  db.setRpc("library_filter", (args, actor) => {
    if (!actor) return { data: [], error: null };
    const text = typeof args.p_text === "string" ? args.p_text.toLowerCase() : null;
    const wantedTags = Array.isArray(args.p_tags) ? (args.p_tags as string[]) : null;
    const rows = db.rows("files").filter((f) => {
      if (f.user_id !== actor || f.status !== "ready") return false;
      if (args.p_kind && f.kind !== args.p_kind) return false;
      const bpm = effectiveBpm(f);
      if (typeof args.p_bpm_min === "number" && (bpm === null || bpm < args.p_bpm_min)) return false;
      if (typeof args.p_bpm_max === "number" && (bpm === null || bpm > args.p_bpm_max)) return false;
      if (args.p_tonic && effectiveKey(f, "tonic") !== args.p_tonic) return false;
      if (args.p_mode && effectiveKey(f, "mode") !== args.p_mode) return false;
      if (typeof args.p_is_loop_based === "boolean" && reportValue(f, ["sample_use", "is_loop_based"]) !== args.p_is_loop_based) return false;
      if (typeof args.p_has_drums === "boolean" && hasDrumTag(db, String(f.id)) !== args.p_has_drums) return false;
      if (wantedTags && !db.rows("tags").some((t) => t.file_id === f.id && wantedTags.includes(String(t.tag)))) return false;
      if (text) {
        const haystack = [f.original_filename, f.title, f.artist].filter((v) => typeof v === "string").join(" ").toLowerCase();
        if (!haystack.includes(text)) return false;
      }
      return true;
    });
    const ordered = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const limit = Math.min(typeof args.p_limit === "number" ? args.p_limit : 50, 200);
    return { data: clone(ordered.slice(0, limit)) as unknown as FileRow[], error: null };
  });

  // No embeddings in the double unless a test seeds them; both vector RPCs
  // answer empty, which is the "filters" fallback the route documents.
  db.setRpc("search_embeddings", () => ({ data: [], error: null }));
  db.setRpc("similar_files", () => ({ data: [], error: null }));
}

export type { Json };
