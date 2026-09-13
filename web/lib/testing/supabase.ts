// A Supabase client double: the PostgREST query builder, the auth surface,
// storage, and RPC dispatch, over the in-memory TestDb.
//
// Two clients come out of the same database, and the difference between them
// is the whole point: `sessionClient(db, userId)` behaves like the anon client
// under RLS (it sees and writes only that user's rows and only that user's
// storage prefix), `serviceClient(db)` behaves like the service role (it sees
// everything). A route that reaches for the wrong one fails a test.
//
// Shapes come from @supabase/supabase-js: `{ data, error }` everywhere,
// `PGRST116` when single() does not get exactly one row, `23505` on a unique
// violation, `42501` when a policy refuses a write.

import type { SupabaseClient, User } from "@supabase/supabase-js";
import type { ServerSupabase } from "@/lib/supabase/server";
import type { Database } from "@/lib/types/db";
import {
  applyDefaults,
  clone,
  dbErr,
  NOT_ONE_ROW,
  RLS_DENIED,
  storagePolicy,
  TestDb,
  UNIQUE_VIOLATION,
  type DbError,
  type Row,
} from "./db";
import { NOW, tableMeta } from "./schema";

export interface ClientOptions {
  /** the signed-in user, or null for no session */
  userId: string | null;
  email?: string | null;
  /** true for the service-role client: no RLS, no storage policy */
  serviceRole?: boolean;
}

export interface Result<T> {
  data: T;
  error: DbError | null;
  count: number | null;
  status: number;
  statusText: string;
}

type Comparator = (row: Row) => boolean;

interface Order {
  column: string;
  ascending: boolean;
  nullsFirst: boolean;
}

function ok<T>(data: T, count: number | null = null): Result<T> {
  return { data, error: null, count, status: 200, statusText: "OK" };
}

function fail(error: DbError): Result<null> {
  const status = error.code === "42501" ? 403 : error.code === "23505" ? 409 : error.code === "PGRST116" ? 406 : 400;
  return { data: null, error, count: null, status, statusText: error.message };
}

/** `select("id, kind, status")` really does drop every other column. */
export function projection(columns: string | null): string[] | null {
  if (!columns || columns.trim() === "*") return null;
  const parts = columns
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (parts.some((p) => p === "*" || p.includes("("))) return null;
  return parts;
}

function project(row: Row, columns: string[] | null): Row {
  if (!columns) return clone(row);
  const out: Row = {};
  for (const col of columns) out[col] = clone(row[col]);
  return out;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : 1;
}

function sortRows(rows: Row[], orders: Order[]): Row[] {
  if (orders.length === 0) return rows;
  return [...rows].sort((x, y) => {
    for (const o of orders) {
      const a = x[o.column];
      const b = y[o.column];
      const aNull = a === null || a === undefined;
      const bNull = b === null || b === undefined;
      if (aNull || bNull) {
        if (aNull && bNull) continue;
        return (aNull ? 1 : -1) * (o.nullsFirst ? -1 : 1);
      }
      const c = compare(a, b);
      if (c !== 0) return o.ascending ? c : -c;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// the query builder
// ---------------------------------------------------------------------------

class QueryBuilder<T> implements PromiseLike<Result<T>> {
  private filters: Comparator[] = [];
  private orders: Order[] = [];
  private limitN: number | null = null;
  private columns: string | null = null;
  private returning = false;
  private countMode: "exact" | "planned" | "estimated" | null = null;
  private head = false;

  constructor(
    private readonly db: TestDb,
    private readonly opts: ClientOptions,
    private readonly table: string,
    private readonly op: "select" | "insert" | "update" | "delete" | "upsert",
    private readonly values: Row[] = [],
    private readonly onConflict: string | null = null,
  ) {
    if (op === "select") this.returning = true;
  }

  // -- filters --------------------------------------------------------------

  eq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] === value);
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push((row) => row[column] !== value);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }

  is(column: string, value: null | boolean): this {
    this.filters.push((row) => (value === null ? row[column] === null || row[column] === undefined : row[column] === value));
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    if (operator !== "is") throw new Error(`The double only implements .not(col, "is", value), not ${operator}.`);
    this.filters.push((row) => !(value === null ? row[column] === null || row[column] === undefined : row[column] === value));
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push((row) => compare(row[column], value) >= 0);
    return this;
  }

  gt(column: string, value: unknown): this {
    this.filters.push((row) => compare(row[column], value) > 0);
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push((row) => compare(row[column], value) <= 0);
    return this;
  }

  lt(column: string, value: unknown): this {
    this.filters.push((row) => compare(row[column], value) < 0);
    return this;
  }

  // -- modifiers ------------------------------------------------------------

  select(columns = "*", options: { count?: "exact" | "planned" | "estimated"; head?: boolean } = {}): this {
    this.columns = columns;
    this.returning = true;
    if (options.count) this.countMode = options.count;
    if (options.head) this.head = true;
    return this;
  }

  order(column: string, options: { ascending?: boolean; nullsFirst?: boolean } = {}): this {
    const ascending = options.ascending ?? true;
    this.orders.push({ column, ascending, nullsFirst: options.nullsFirst ?? !ascending });
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  range(from: number, to: number): this {
    this.limitN = to - from + 1;
    return this;
  }

  // -- terminators ----------------------------------------------------------

  single(): PromiseLike<Result<Row | null>> {
    return this.exactlyOne(true);
  }

  maybeSingle(): PromiseLike<Result<Row | null>> {
    return this.exactlyOne(false);
  }

  then<R1 = Result<T>, R2 = never>(
    onfulfilled?: ((value: Result<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run() as Result<T>).then(onfulfilled, onrejected);
  }

  private async exactlyOne(required: boolean): Promise<Result<Row | null>> {
    const result = this.run();
    if (result.error) return result as Result<Row | null>;
    const rows = (result.data ?? []) as Row[];
    if (rows.length === 1) return ok(rows[0] ?? null, result.count);
    if (rows.length === 0 && !required) return ok(null, result.count);
    return fail(NOT_ONE_ROW(rows.length)) as Result<Row | null>;
  }

  // -- execution ------------------------------------------------------------

  private visible(): Row[] {
    const meta = tableMeta(this.table);
    const rows = this.db.rows(this.table);
    if (this.opts.serviceRole) return rows;
    if (!meta.owner || !this.opts.userId) return [];
    return rows.filter((row) => row[meta.owner as string] === this.opts.userId);
  }

  private matching(): Row[] {
    return this.visible().filter((row) => this.filters.every((f) => f(row)));
  }

  private uniqueViolation(candidate: Row, ignore?: Row): DbError | null {
    const meta = tableMeta(this.table);
    for (const cols of meta.unique) {
      const clash = this.db
        .rows(this.table)
        .find((row) => row !== ignore && cols.every((c) => row[c] === candidate[c]));
      if (clash) return UNIQUE_VIOLATION(this.table, cols);
    }
    return null;
  }

  private run(): Result<T> {
    const meta = tableMeta(this.table);
    const columns = projection(this.columns);

    if (this.op === "select") {
      let rows = this.matching();
      const total = rows.length;
      rows = sortRows(rows, this.orders);
      if (this.limitN !== null) rows = rows.slice(0, this.limitN);
      const count = this.countMode ? total : null;
      if (this.head) return ok(null, count) as unknown as Result<T>;
      return ok(rows.map((r) => project(r, columns)), count) as unknown as Result<T>;
    }

    if (this.op === "insert" || this.op === "upsert") {
      const written: Row[] = [];
      for (const value of this.values) {
        const candidate = applyDefaults(meta.defaults, value);
        if (!this.opts.serviceRole) {
          const allowed = meta.insertable && meta.owner !== null && this.opts.userId !== null && candidate[meta.owner] === this.opts.userId;
          if (!allowed) return fail(RLS_DENIED()) as unknown as Result<T>;
        }
        const conflictCols = this.onConflict ? this.onConflict.split(",").map((c) => c.trim()) : null;
        const existing = conflictCols
          ? this.db.rows(this.table).find((row) => conflictCols.every((c) => row[c] === candidate[c]))
          : undefined;
        if (existing && this.op === "upsert") {
          Object.assign(existing, value);
          written.push(existing);
          continue;
        }
        const violation = this.uniqueViolation(candidate);
        if (violation) return fail(violation) as unknown as Result<T>;
        this.db.rows(this.table).push(candidate);
        written.push(candidate);
      }
      if (!this.returning) return ok(null, null) as unknown as Result<T>;
      const rows = sortRows(written, this.orders).map((r) => project(r, columns));
      return ok(rows, null) as unknown as Result<T>;
    }

    if (this.op === "update") {
      const changes = this.values[0] ?? {};
      const targets = this.matching();
      const written: Row[] = [];
      for (const row of targets) {
        const next = { ...row, ...clone(changes) };
        if (!this.opts.serviceRole) {
          if (meta.owner && next[meta.owner] !== this.opts.userId) return fail(RLS_DENIED()) as unknown as Result<T>;
          for (const frozen of meta.frozen) {
            if (frozen in changes && next[frozen] !== row[frozen]) return fail(RLS_DENIED()) as unknown as Result<T>;
          }
        }
        const violation = this.uniqueViolation(next, row);
        if (violation) return fail(violation) as unknown as Result<T>;
        if (meta.touchUpdatedAt) next.updated_at = NOW;
        Object.assign(row, next);
        written.push(row);
      }
      if (!this.returning) return ok(null, written.length) as unknown as Result<T>;
      return ok(sortRows(written, this.orders).map((r) => project(r, columns)), written.length) as unknown as Result<T>;
    }

    // delete
    const targets = this.matching();
    const rows = this.db.rows(this.table);
    for (const row of targets) {
      const at = rows.indexOf(row);
      if (at >= 0) rows.splice(at, 1);
    }
    const count = this.countMode ? targets.length : null;
    if (!this.returning) return ok(null, count) as unknown as Result<T>;
    return ok(targets.map((r) => project(r, columns)), count) as unknown as Result<T>;
  }
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

interface StorageResult<T> {
  data: T | null;
  error: { message: string; statusCode?: string } | null;
}

function storageError(message: string, statusCode = "400"): StorageResult<never> {
  return { data: null, error: { message, statusCode } };
}

export interface StorageCall {
  method: string;
  path: string | string[];
  serviceRole: boolean;
}

class StorageBucket {
  constructor(
    private readonly db: TestDb,
    private readonly opts: ClientOptions,
    private readonly bucket: string,
    private readonly calls: StorageCall[],
  ) {}

  private record(method: string, path: string | string[]): void {
    this.calls.push({ method, path, serviceRole: this.opts.serviceRole === true });
  }

  private mayRead(path: string): boolean {
    return this.opts.serviceRole === true || storagePolicy.read(path, this.opts.userId);
  }

  private mayWrite(path: string): boolean {
    return this.opts.serviceRole === true || storagePolicy.write(path, this.opts.userId);
  }

  private sign(path: string, expiresIn: number, options?: { download?: string | boolean }): string {
    const download = options?.download;
    const suffix = download === undefined || download === false ? "" : `&download=${download === true ? "" : encodeURIComponent(download)}`;
    return `https://storage.test/object/sign/${this.bucket}/${path}?token=signed&expires_in=${expiresIn}${suffix}`;
  }

  async createSignedUrl(path: string, expiresIn: number, options?: { download?: string | boolean }) {
    this.record("createSignedUrl", path);
    if (!this.mayRead(path) || !this.db.objects.has(path)) return storageError("Object not found", "404");
    return { data: { signedUrl: this.sign(path, expiresIn, options), path }, error: null };
  }

  async createSignedUrls(paths: string[], expiresIn: number, options?: { download?: string | boolean }) {
    this.record("createSignedUrls", paths);
    const data = paths.map((path) =>
      this.mayRead(path) && this.db.objects.has(path)
        ? { path, signedUrl: this.sign(path, expiresIn, options), error: null }
        : { path, signedUrl: "", error: "Object not found" },
    );
    return { data, error: null };
  }

  async createSignedUploadUrl(path: string) {
    this.record("createSignedUploadUrl", path);
    if (!this.mayWrite(path)) return storageError("new row violates row-level security policy", "403");
    return { data: { signedUrl: `https://storage.test/object/upload/sign/${this.bucket}/${path}`, token: "upload-token", path }, error: null };
  }

  async uploadToSignedUrl(path: string, token: string, body: ArrayBuffer | Uint8Array | Blob | string) {
    this.record("uploadToSignedUrl", path);
    if (token !== "upload-token") return storageError("Invalid token", "403");
    this.db.putObject(path, toBytes(body));
    return { data: { path }, error: null };
  }

  async upload(path: string, body: ArrayBuffer | Uint8Array | Blob | string, options?: { contentType?: string; upsert?: boolean }) {
    this.record("upload", path);
    if (!this.mayWrite(path)) return storageError("new row violates row-level security policy", "403");
    if (this.db.objects.has(path) && options?.upsert !== true) return storageError("The resource already exists", "409");
    this.db.putObject(path, toBytes(body), options?.contentType ?? "application/octet-stream");
    return { data: { path, id: path, fullPath: `${this.bucket}/${path}` }, error: null };
  }

  async download(path: string) {
    this.record("download", path);
    if (!this.mayRead(path)) return storageError("Object not found", "404");
    const object = this.db.objects.get(path);
    if (!object) return storageError("Object not found", "404");
    return { data: new Blob([object.bytes as unknown as BlobPart], { type: object.contentType }), error: null };
  }

  async remove(paths: string[]) {
    this.record("remove", paths);
    const removed: Array<{ name: string }> = [];
    for (const path of paths) {
      if (!this.mayRead(path)) continue;
      if (this.db.objects.delete(path)) removed.push({ name: path });
    }
    return { data: removed, error: null };
  }

  async list(prefix: string, _options?: { limit?: number; offset?: number }) {
    this.record("list", prefix);
    const base = prefix.endsWith("/") ? prefix : `${prefix}/`;
    const entries = new Map<string, { name: string; id: string | null }>();
    for (const path of this.db.objects.keys()) {
      if (!path.startsWith(base)) continue;
      if (!this.mayRead(path)) continue;
      const rest = path.slice(base.length);
      const slash = rest.indexOf("/");
      if (slash === -1) entries.set(rest, { name: rest, id: `object-${rest}` });
      else {
        const folder = rest.slice(0, slash);
        entries.set(folder, { name: folder, id: null });
      }
    }
    return { data: [...entries.values()], error: null };
  }
}

function toBytes(body: ArrayBuffer | Uint8Array | Blob | string): Uint8Array {
  if (typeof body === "string") return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array();
}

// ---------------------------------------------------------------------------
// the client
// ---------------------------------------------------------------------------

export interface TestSupabase {
  db: TestDb;
  options: ClientOptions;
  /** every storage call this client made, in order */
  storageCalls: StorageCall[];
  asServerClient(): ServerSupabase;
}

export function testUser(id: string, email: string | null = `${id}@example.test`): User {
  return {
    id,
    aud: "authenticated",
    role: "authenticated",
    email: email ?? undefined,
    app_metadata: { provider: "email" },
    user_metadata: {},
    created_at: NOW,
  } as User;
}

export function createTestClient(db: TestDb, opts: ClientOptions): TestSupabase {
  const storageCalls: StorageCall[] = [];
  const client = {
    db,
    options: opts,
    storageCalls,
    from(table: string) {
      return {
        select: (columns = "*", options: { count?: "exact"; head?: boolean } = {}) =>
          new QueryBuilder(db, opts, table, "select").select(columns, options),
        insert: (values: Row | Row[]) => new QueryBuilder(db, opts, table, "insert", Array.isArray(values) ? values : [values]),
        upsert: (values: Row | Row[], options?: { onConflict?: string }) =>
          new QueryBuilder(db, opts, table, "upsert", Array.isArray(values) ? values : [values], options?.onConflict ?? null),
        update: (values: Row) => new QueryBuilder(db, opts, table, "update", [values]),
        delete: (options?: { count?: "exact" }) => {
          const q = new QueryBuilder(db, opts, table, "delete");
          if (options?.count) q.select("*", { count: options.count });
          return q;
        },
      };
    },
    rpc(name: string, args: Record<string, unknown> = {}) {
      const handler = db.rpcs.get(name);
      const result = handler
        ? handler(args, opts.serviceRole ? null : opts.userId, db)
        : { data: null, error: dbErr("42883", `function public.${name} does not exist`) };
      return Promise.resolve({ ...result, count: null, status: result.error ? 400 : 200, statusText: "OK" });
    },
    auth: {
      async getUser() {
        if (!opts.userId) {
          return { data: { user: null }, error: { name: "AuthSessionMissingError", message: "Auth session missing!", status: 400 } };
        }
        return { data: { user: testUser(opts.userId, opts.email ?? null) }, error: null };
      },
      async getSession() {
        if (!opts.userId) return { data: { session: null }, error: null };
        return { data: { session: { user: testUser(opts.userId, opts.email ?? null), access_token: "test-token" } }, error: null };
      },
    },
    storage: {
      from: (bucket: string) => new StorageBucket(db, opts, bucket, storageCalls),
    },
    asServerClient(): ServerSupabase {
      return client as unknown as ServerSupabase;
    },
  };
  return client as unknown as TestSupabase;
}

/** The anon client with a session: RLS scopes every read and write to `userId`. */
export function sessionClient(db: TestDb, userId: string, email?: string | null): TestSupabase {
  return createTestClient(db, { userId, email: email ?? `${userId}@example.test` });
}

/** The anon client with no session. */
export function anonClient(db: TestDb): TestSupabase {
  return createTestClient(db, { userId: null });
}

/** The service-role client: no RLS, no storage policy. */
export function serviceClient(db: TestDb): TestSupabase {
  return createTestClient(db, { userId: null, serviceRole: true });
}

export type TypedTestClient = SupabaseClient<Database>;
