#!/usr/bin/env node
// Launch preflight: everything that has to be true before signups open, checked
// against the real services, reported in plain language.
//
//   node scripts/preflight.mjs              # the full check
//   node scripts/preflight.mjs --offline    # shapes and files only, no network
//   node scripts/preflight.mjs --json       # the same result as JSON
//
// Rules this script keeps:
//   * It never prints a secret. It says whether a variable is set and whether
//     its shape is right, never its value, not even a prefix.
//   * It only reads. Run it as often as you like, against production, mid-
//     deploy, at three in the morning. Nothing here writes, charges, spends a
//     token or changes a row.
//   * A FAIL is something that will break a real user's first session. A WARN
//     is something you can launch with but should know about. Only a FAIL sets
//     the exit code.
//
// Wired into docs/RUNBOOK.md as the step before opening signups.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WEB = join(ROOT, "web");

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log("usage: node scripts/preflight.mjs [--offline] [--json]");
  process.exit(0);
}
const OFFLINE = args.has("--offline");
const AS_JSON = args.has("--json");
const TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------

const results = [];
const pass = (group, name, detail = "") => results.push({ group, name, status: "PASS", detail });
const warn = (group, name, detail) => results.push({ group, name, status: "WARN", detail });
const fail = (group, name, detail) => results.push({ group, name, status: "FAIL", detail });
const skip = (group, name, detail) => results.push({ group, name, status: "SKIP", detail });

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

/** A .env file, parsed without a dependency. Values are never logged. */
function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const envFiles = [join(WEB, ".env.local"), join(WEB, ".env.production.local"), join(WEB, ".env")];
const fromFiles = {};
for (const file of envFiles) Object.assign(fromFiles, readEnvFile(file));
const env = { ...fromFiles, ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v)) };
const envSources = envFiles.filter((f) => existsSync(f)).map((f) => f.replace(`${ROOT}/`, ""));

const isUrl = (v, protocols) => {
  try {
    return protocols.includes(new URL(v).protocol);
  } catch {
    return false;
  }
};

/**
 * Supabase issues two key formats: the legacy JWTs (`eyJ...`) and the newer
 * `sb_publishable_` / `sb_secret_` keys. Accept both, and refuse a service
 * role key that is the same string as the anon key — a paste error that
 * silently disables every server route that needs to bypass RLS.
 */
const looksLikeSupabaseKey = (v) => /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v) || /^sb_(publishable|secret)_[\w-]{10,}$/.test(v);

const VARS = [
  {
    name: "NEXT_PUBLIC_SUPABASE_URL",
    required: true,
    check: (v) => (isUrl(v, ["https:"]) ? null : "must be an https URL, for example https://<project-ref>.supabase.co"),
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    required: true,
    check: (v) => (looksLikeSupabaseKey(v) ? null : "does not look like a Supabase publishable/anon key (eyJ... or sb_publishable_...)"),
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    required: true,
    check: (v) => {
      if (!looksLikeSupabaseKey(v)) return "does not look like a Supabase service-role key (eyJ... or sb_secret_...)";
      if (v === env.NEXT_PUBLIC_SUPABASE_ANON_KEY) return "is the same value as the anon key; the service role is a different key";
      return null;
    },
    note: "without it nothing meters into usage_events and the quotas fall back to the message count",
  },
  {
    name: "ANTHROPIC_API_KEY",
    required: true,
    check: (v) => (v.startsWith("sk-ant-") ? null : "does not look like an Anthropic key (expected it to start with sk-ant-)"),
  },
  {
    name: "COMPUTE_DISPATCH_URL",
    required: true,
    check: (v) => (isUrl(v, ["https:", "http:"]) ? null : "must be a URL"),
    warnIf: (v) => (v.startsWith("http://127.0.0.1") || v.startsWith("http://localhost") ? "points at the local runner, not a deployed dispatcher" : null),
  },
  {
    name: "COMPUTE_DISPATCH_SECRET",
    required: true,
    check: (v) => {
      if (/change-me/i.test(v)) return "is still the example value from .env.example";
      if (v.length < 16) return "is shorter than 16 characters; it is the only thing standing between the internet and the job runner";
      return null;
    },
    note: "must be the same value in the Modal secret",
  },
  {
    name: "NEXT_PUBLIC_APP_URL",
    required: true,
    check: (v) => (isUrl(v, ["https:", "http:"]) ? null : "must be a URL"),
    warnIf: (v) => (/localhost|127\.0\.0\.1/.test(v) ? "is a localhost URL; Stripe redirects and the webhook will point at your laptop" : null),
  },
  {
    name: "WEB_SEARCH_PROVIDER",
    required: true,
    check: (v) => (["brave", "tavily"].includes(v) ? null : 'must be "brave" or "tavily"'),
  },
  {
    name: "STRIPE_SECRET_KEY",
    required: true,
    check: (v) => (/^sk_(live|test)_/.test(v) ? null : "does not look like a Stripe secret key (sk_live_... or sk_test_...)"),
    warnIf: (v) => (v.startsWith("sk_test_") ? "is a test-mode key; real cards will not work" : null),
  },
  {
    name: "STRIPE_PRICE_ID",
    required: true,
    check: (v) => (v.startsWith("price_") ? null : "must be a Stripe price id (price_...), not a product id"),
  },
  {
    name: "STRIPE_WEBHOOK_SECRET",
    required: true,
    check: (v) => (v.startsWith("whsec_") ? null : "must be the webhook signing secret (whsec_...)"),
  },
];

function checkEnv() {
  const group = "environment";
  if (envSources.length === 0 && Object.keys(fromFiles).length === 0) {
    warn(group, "env files", "no web/.env.local found; reading the process environment only");
  } else {
    pass(group, "env files", `read ${envSources.join(", ")}`);
  }

  for (const spec of VARS) {
    const value = env[spec.name];
    const note = spec.note ? ` — ${spec.note}` : "";
    if (!value) {
      if (spec.required) fail(group, spec.name, `not set${note}`);
      else warn(group, spec.name, `not set${note}`);
      continue;
    }
    const problem = spec.check?.(value);
    if (problem) {
      fail(group, spec.name, `${problem}${note}`);
      continue;
    }
    const warning = spec.warnIf?.(value);
    if (warning) warn(group, spec.name, warning);
    else pass(group, spec.name, "set, shape looks right");
  }

  // the search provider's own key
  const provider = env.WEB_SEARCH_PROVIDER;
  const keyName = provider === "tavily" ? "TAVILY_API_KEY" : "BRAVE_SEARCH_API_KEY";
  if (provider && !env[keyName]) fail(group, keyName, `not set, and WEB_SEARCH_PROVIDER selects ${provider}`);
  else if (provider) pass(group, keyName, "set");
}

// ---------------------------------------------------------------------------
// what the migrations say should exist
// ---------------------------------------------------------------------------

/**
 * Tables, added columns and callable functions the SQL in supabase/migrations
 * creates, read out of the files so this list maintains itself when a
 * migration is added. Trigger functions are skipped: PostgREST does not expose
 * them, so there is nothing to probe.
 *
 * Columns matter as much as tables. Half of the migrations written after the
 * first deploy add columns to tables that already exist — the separation
 * quality on `stems`, `processing` on `song_tracks`, the onboarding state and
 * the personalization switch on `profiles` — so a database that is missing one
 * of those files answers every table probe and still breaks the feature. The
 * probe is `select=<column>`: PostgREST answers 400 and names the column when
 * it is not there, and it is still a read.
 */
function expectedSchema() {
  const dir = join(ROOT, "supabase", "migrations");
  if (!existsSync(dir)) return { tables: [], functions: [], columns: {}, files: [] };
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const tables = new Set();
  const functions = new Set();
  const columns = {};
  for (const file of files) {
    const sql = readFileSync(join(dir, file), "utf8");
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.([a-z_][a-z0-9_]*)/gi)) tables.add(m[1]);
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+public\.([a-z_][a-z0-9_]*)\s*\(([\s\S]{0,600}?)\breturns\s+(\w+)/gi)) {
      if (m[3].toLowerCase() !== "trigger") functions.add(m[1]);
    }
    // `alter table [if exists] public.t add column [if not exists] c ...`, one
    // statement, however many columns it adds before the semicolon.
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?public\.([a-z_][a-z0-9_]*)([\s\S]*?);/gi)) {
      const table = m[1];
      for (const c of m[2].matchAll(/add\s+column\s+(?:if\s+not\s+exists\s+)?([a-z_][a-z0-9_]*)/gi)) {
        (columns[table] ??= new Set()).add(c[1]);
      }
    }
  }
  for (const table of Object.keys(columns)) columns[table] = [...columns[table]];
  return { tables: [...tables], functions: [...functions], columns, files };
}

/**
 * Every `process.env.X` the web app reads, so the check below can say whether
 * `.env.example` still describes the app. A variable that only exists in the
 * code is one a deploy will be missing and nobody will think to set.
 */
function envVarsReadByWeb() {
  const found = new Set();
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !/\.test\./.test(entry.name)) {
        for (const m of readFileSync(path, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) found.add(m[1]);
      }
    }
  };
  for (const sub of ["app", "lib", "components"]) walk(join(WEB, sub));
  return [...found].sort();
}

/** Variables Next.js or the platform sets, which nobody puts in .env.example. */
const PLATFORM_ENV = new Set(["NODE_ENV", "VERCEL", "VERCEL_ENV", "VERCEL_URL", "CI", "NEXT_RUNTIME", "PORT"]);

function checkEnvExample() {
  const group = "environment";
  const path = join(WEB, ".env.example");
  if (!existsSync(path)) return fail(group, ".env.example", "web/.env.example is missing; there is nothing for a deploy to copy");
  const documented = new Set(Object.keys(readEnvFile(path)));
  // a commented-out variable still counts as documented
  for (const m of readFileSync(path, "utf8").matchAll(/^#\s*([A-Z][A-Z0-9_]*)=/gm)) documented.add(m[1]);
  const missing = envVarsReadByWeb().filter((v) => !documented.has(v) && !PLATFORM_ENV.has(v));
  if (missing.length > 0) warn(group, ".env.example", `read by the app but not documented: ${missing.join(", ")}`);
  else pass(group, ".env.example", `documents every variable the app reads (${documented.size})`);
}

// ---------------------------------------------------------------------------
// network checks
// ---------------------------------------------------------------------------

async function request(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

async function checkSupabase() {
  const group = "supabase";
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return skip(group, "reachable", "needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  const base = url.replace(/\/+$/, "");
  const headers = { apikey: key, authorization: `Bearer ${key}` };

  try {
    const res = await request(`${base}/rest/v1/`, { headers });
    if (!res.ok) return fail(group, "reachable", `the REST endpoint answered ${res.status}; check the URL and the service-role key`);
    pass(group, "reachable", "the REST endpoint answered");
  } catch (err) {
    return fail(group, "reachable", `could not reach the project: ${err.message}`);
  }

  const { tables, functions, columns, files } = expectedSchema();
  pass(group, "migration files", `${files.length} on disk, the newest is ${files.at(-1) ?? "none"}`);

  const missingTables = [];
  for (const table of tables) {
    const res = await request(`${base}/rest/v1/${table}?select=*&limit=1`, { headers });
    if (!res.ok) missingTables.push(`${table} (${res.status})`);
  }
  if (missingTables.length > 0) fail(group, "migrations applied", `these tables did not answer: ${missingTables.join(", ")} — run supabase db push`);
  else pass(group, "migrations applied", `all ${tables.length} tables the migrations create are present`);

  // Columns added to tables that already existed. A table probe cannot see
  // these, and a database missing one of them answers every other check while
  // the feature that needs the column fails for a real user.
  const missingColumns = [];
  let checked = 0;
  for (const [table, cols] of Object.entries(columns)) {
    if (missingTables.some((t) => t.startsWith(`${table} `))) continue;
    for (const column of cols) {
      checked += 1;
      const res = await request(`${base}/rest/v1/${table}?select=${column}&limit=1`, { headers });
      if (!res.ok) missingColumns.push(`${table}.${column}`);
    }
  }
  if (missingColumns.length > 0) {
    fail(group, "migration columns", `these columns the migrations add are not there: ${missingColumns.join(", ")} — a migration was skipped; run supabase db push`);
  } else if (checked > 0) {
    pass(group, "migration columns", `all ${checked} columns the migrations add to existing tables are present`);
  }

  const missingFns = [];
  for (const fn of functions) {
    // A function that exists but is called with the wrong arguments answers 404
    // with a PGRST202 hint; one that does not exist answers the same way, so
    // probe with no arguments and treat a 404 whose body names the function as
    // "present". Everything except a bare 404 means the function is there.
    const res = await request(`${base}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
    if (res.status === 404) {
      const body = await res.text().catch(() => "");
      if (!body.includes(fn)) missingFns.push(fn);
    }
  }
  if (missingFns.length > 0) fail(group, "database functions", `not found: ${missingFns.join(", ")}`);
  else pass(group, "database functions", `all ${functions.length} functions the migrations create respond`);

  try {
    const res = await request(`${base}/storage/v1/bucket/audio`, { headers });
    if (res.status === 404) fail(group, "storage bucket", 'the private bucket "audio" does not exist');
    else if (!res.ok) warn(group, "storage bucket", `the bucket endpoint answered ${res.status}`);
    else {
      const bucket = await res.json();
      if (bucket.public) fail(group, "storage bucket", 'the "audio" bucket is PUBLIC; user audio must never be public (principle 6)');
      else pass(group, "storage bucket", '"audio" exists and is private');
    }
  } catch (err) {
    warn(group, "storage bucket", `could not check: ${err.message}`);
  }
}

async function checkCompute() {
  const group = "compute";
  const base = env.COMPUTE_DISPATCH_URL;
  if (!base) return skip(group, "dispatcher", "needs COMPUTE_DISPATCH_URL");
  try {
    const res = await request(`${base.replace(/\/+$/, "")}/health`);
    if (!res.ok) return fail(group, "dispatcher", `/health answered ${res.status}`);
    const body = await res.json().catch(() => ({}));
    pass(group, "dispatcher", `answering${body.runner ? ` (runner: ${body.runner})` : ""}`);
    if (body.runner && /fake|local/i.test(String(body.runner))) {
      warn(group, "dispatcher", `the runner reports itself as "${body.runner}"; separations will not be real`);
    }
  } catch (err) {
    fail(group, "dispatcher", `did not answer: ${err.message}`);
  }
}

/** The model ids the app routes to, read out of the source rather than repeated here. */
function routedModels() {
  const found = new Set();
  for (const file of [join(WEB, "lib", "anthropic", "models.ts"), join(WEB, "lib", "anthropic", "narrate.ts")]) {
    if (!existsSync(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/^export const (?:CHAT_MODEL|QUERY_PARSER_MODEL|NARRATION_MODEL)[^=]*=\s*"([^"]+)"/gm)) found.add(m[1]);
  }
  return [...found];
}

async function checkAnthropic() {
  const group = "anthropic";
  const key = env.ANTHROPIC_API_KEY;
  if (!key) return skip(group, "key", "needs ANTHROPIC_API_KEY");
  let available = [];
  try {
    const res = await request("https://api.anthropic.com/v1/models?limit=100", {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (res.status === 401) return fail(group, "key", "rejected by the API (401); the key is wrong, revoked, or from another workspace");
    if (!res.ok) return fail(group, "key", `the models endpoint answered ${res.status}`);
    const body = await res.json();
    available = (body.data ?? []).map((m) => m.id);
    pass(group, "key", `accepted; ${available.length} models visible to this workspace`);
  } catch (err) {
    return fail(group, "key", `could not reach the API: ${err.message}`);
  }

  const routed = routedModels();
  if (routed.length === 0) return warn(group, "routed models", "could not read the model constants out of web/lib/anthropic");
  const missing = routed.filter((id) => !available.includes(id));
  if (missing.length > 0) fail(group, "routed models", `this workspace cannot see: ${missing.join(", ")} — every chat turn would fail`);
  else pass(group, "routed models", `all ${routed.length} models the app routes to are available`);
}

async function checkStripe() {
  const group = "stripe";
  const secret = env.STRIPE_SECRET_KEY;
  const price = env.STRIPE_PRICE_ID;
  if (!secret || !price) return skip(group, "price", "needs STRIPE_SECRET_KEY and STRIPE_PRICE_ID");
  try {
    const res = await request(`https://api.stripe.com/v1/prices/${encodeURIComponent(price)}`, {
      headers: { authorization: `Basic ${Buffer.from(`${secret}:`).toString("base64")}` },
    });
    if (res.status === 401) return fail(group, "key", "rejected by Stripe (401)");
    if (res.status === 404) return fail(group, "price", "STRIPE_PRICE_ID does not exist in this Stripe account (or is in the other mode)");
    if (!res.ok) return fail(group, "price", `Stripe answered ${res.status}`);
    const body = await res.json();
    pass(group, "key", "accepted");
    if (!body.active) fail(group, "price", "the price exists but is not active");
    else if (body.type !== "recurring") fail(group, "price", `the price is "${body.type}", not a recurring subscription price`);
    else pass(group, "price", `active recurring price, ${(body.unit_amount ?? 0) / 100} ${String(body.currency).toUpperCase()} per ${body.recurring?.interval}`);
  } catch (err) {
    fail(group, "price", `could not reach Stripe: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// files on disk
// ---------------------------------------------------------------------------

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

function checkLegal() {
  const group = "legal";
  const dir = join(WEB, "app", "legal");
  if (!existsSync(dir)) return fail(group, "pages", "web/app/legal does not exist");
  const pages = walk(dir).filter((p) => p.endsWith(".tsx") || p.endsWith(".mdx") || p.endsWith(".md"));
  if (pages.length === 0) return fail(group, "pages", "no legal pages found under web/app/legal");

  const outstanding = [];
  for (const page of pages) {
    const source = readFileSync(page, "utf8");
    const count = (source.match(/TODO\(owner\)/g) ?? []).length;
    if (count > 0) outstanding.push(`${page.replace(`${ROOT}/`, "")} (${count})`);
  }
  if (outstanding.length > 0) {
    fail(group, "placeholders", `still says TODO(owner): ${outstanding.join(", ")} — the entity name, the address and the DMCA agent have to be real before signups`);
  } else {
    pass(group, "placeholders", `${pages.length} legal pages, no TODO(owner) left`);
  }

  const required = ["terms", "privacy", "dmca"];
  const missing = required.filter((name) => !pages.some((p) => p.includes(`${name}/`) || p.endsWith(`${name}.tsx`)));
  if (missing.length > 0) fail(group, "required pages", `missing: ${missing.join(", ")}`);
  else pass(group, "required pages", "terms, privacy and dmca are all present");
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const MARK = { PASS: "ok  ", WARN: "warn", FAIL: "FAIL", SKIP: "skip" };

function report() {
  const failures = results.filter((r) => r.status === "FAIL");
  const warnings = results.filter((r) => r.status === "WARN");

  if (AS_JSON) {
    console.log(JSON.stringify({ ok: failures.length === 0, offline: OFFLINE, results }, null, 2));
    return failures.length === 0 ? 0 : 1;
  }

  console.log("");
  console.log(`Cratebox AI launch preflight${OFFLINE ? " (offline: shapes and files only)" : ""}`);
  console.log("");
  let group = null;
  for (const r of results) {
    if (r.group !== group) {
      group = r.group;
      console.log(`  ${group}`);
    }
    console.log(`    ${MARK[r.status]}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log("");
  if (failures.length === 0 && warnings.length === 0) {
    console.log("  Everything checked is ready. Open signups.");
  } else if (failures.length === 0) {
    console.log(`  Nothing blocking. ${warnings.length} warning${warnings.length === 1 ? "" : "s"} to read before you open signups.`);
  } else {
    console.log(`  ${failures.length} thing${failures.length === 1 ? "" : "s"} must be fixed before signups open:`);
    for (const f of failures) console.log(`    - ${f.group}/${f.name}: ${f.detail}`);
  }
  console.log("");
  return failures.length === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------

checkEnv();
checkEnvExample();
checkLegal();
if (OFFLINE) {
  for (const group of ["supabase", "compute", "anthropic", "stripe"]) skip(group, "all checks", "--offline");
} else {
  await checkSupabase();
  await checkCompute();
  await checkAnthropic();
  await checkStripe();
}
process.exit(report());
