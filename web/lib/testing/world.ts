// The route harness: one object per test holding the database, who is signed
// in, whether a service-role key exists, and what compute answers.
//
// `lib/testing/setup.ts` points `@/lib/supabase/server` and
// `@/lib/supabase/admin` at the active world, so a route handler imported
// normally gets the double through its own `requireUser()`.

import { resetRateLimits } from "@/lib/ratelimit";
import { resetUuids, TestDb } from "./db";
import { createTestClient, sessionClient, type TestSupabase } from "./supabase";

export const USER_A = "11111111-1111-4111-8111-111111111111";
export const USER_B = "22222222-2222-4222-8222-222222222222";

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

export type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | null;

export interface WorldOptions {
  /** sign this user in (default USER_A); null for a signed-out world */
  user?: string | null;
  /** is SUPABASE_SERVICE_ROLE_KEY set? (default true) */
  serviceRole?: boolean;
  /** is COMPUTE_DISPATCH_URL set? (default true) */
  compute?: boolean;
  env?: Record<string, string | undefined>;
}

export const COMPUTE_URL = "https://compute.test";

export class World {
  readonly db = new TestDb();
  readonly fetchCalls: FetchCall[] = [];
  /** job ids compute was asked to run, in order */
  readonly dispatched: string[] = [];
  private currentUser: string | null;
  private serviceRole: boolean;
  private handlers: FetchHandler[] = [];

  constructor(opts: WorldOptions = {}) {
    this.currentUser = opts.user === undefined ? USER_A : opts.user;
    this.serviceRole = opts.serviceRole !== false;
  }

  get userId(): string | null {
    return this.currentUser;
  }

  signIn(userId: string): void {
    this.currentUser = userId;
  }

  signOut(): void {
    this.currentUser = null;
  }

  setServiceRole(enabled: boolean): void {
    this.serviceRole = enabled;
    if (enabled) process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
    else delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }

  /** The client a route handler gets from `createClient()`. */
  client(): TestSupabase {
    return this.currentUser ? sessionClient(this.db, this.currentUser) : createTestClient(this.db, { userId: null });
  }

  /** The client `tryAdminClient()` returns, or null when no key is configured. */
  admin(): TestSupabase | null {
    return this.serviceRole ? createTestClient(this.db, { userId: null, serviceRole: true }) : null;
  }

  /** As a user, for arranging fixtures through the same policies a route meets. */
  as(userId: string): TestSupabase {
    return sessionClient(this.db, userId);
  }

  /** Answer one more shape of outbound request; handlers run newest first. */
  onFetch(handler: FetchHandler): void {
    this.handlers.unshift(handler);
  }

  async handleFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined)).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init?.body === "string" ? init.body : null;
    this.fetchCalls.push({ url, method: init?.method ?? "GET", headers, body });

    for (const handler of this.handlers) {
      const answer = await handler(url, init);
      if (answer) return answer;
    }
    if (url === `${COMPUTE_URL}/dispatch`) {
      const jobId = body ? (JSON.parse(body) as { job_id?: string }).job_id : undefined;
      if (jobId) this.dispatched.push(jobId);
      return jsonResponse({ ok: true, call_id: `call-${this.dispatched.length}` });
    }
    if (url === `${COMPUTE_URL}/health`) return jsonResponse({ ok: true, runner: "test" });
    if (url === `${COMPUTE_URL}/embed_text`) return jsonResponse({ error: "no embedder installed" }, 503);
    return jsonResponse({ error: `nothing in the test world answers ${url}` }, 599);
  }
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

export function textResponse(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

// ---------------------------------------------------------------------------
// the active world
// ---------------------------------------------------------------------------

let active: World | null = null;
let realFetch: typeof globalThis.fetch | null = null;
const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "COMPUTE_DISPATCH_URL",
  "COMPUTE_DISPATCH_SECRET",
  "ANTHROPIC_API_KEY",
  "WEB_SEARCH_PROVIDER",
  "BRAVE_SEARCH_API_KEY",
  "TAVILY_API_KEY",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_ID",
  "NEXT_PUBLIC_APP_URL",
] as const;
let savedEnv: Record<string, string | undefined> = {};

/** The world the mocked Supabase modules read. Throws when a route runs outside one. */
export function activeWorld(): World {
  if (!active) throw new Error("No test world: call createWorld() in the test (or a beforeEach) first.");
  return active;
}

export function createWorld(opts: WorldOptions = {}): World {
  resetWorld();
  const world = new World(opts);
  active = world;
  resetUuids();
  resetRateLimits();

  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://project.supabase.test";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  if (opts.serviceRole === false) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  else process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  if (opts.compute === false) delete process.env.COMPUTE_DISPATCH_URL;
  else process.env.COMPUTE_DISPATCH_URL = COMPUTE_URL;
  process.env.COMPUTE_DISPATCH_SECRET = "dispatch-test-secret";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.WEB_SEARCH_PROVIDER;
  delete process.env.BRAVE_SEARCH_API_KEY;
  delete process.env.TAVILY_API_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRICE_ID;
  process.env.NEXT_PUBLIC_APP_URL = "https://app.test";
  for (const [key, value] of Object.entries(opts.env ?? {})) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  realFetch ??= globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => world.handleFetch(input, init)) as typeof globalThis.fetch;
  return world;
}

/** Undo everything createWorld() changed. The shared setup calls it after each test. */
export function resetWorld(): void {
  if (realFetch) {
    globalThis.fetch = realFetch;
    realFetch = null;
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv = {};
  active = null;
}
