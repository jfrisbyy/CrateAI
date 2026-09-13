// GET /api/health — the app, the database, and compute, in one place.

import { NextResponse } from "next/server";
import { hasPublicEnv, serverEnv } from "@/lib/env";
import { tryAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function checkDb(): Promise<{ ok: boolean; detail?: string }> {
  const admin = tryAdminClient();
  if (!admin) return { ok: false, detail: "service role not configured" };
  const { error } = await admin.from("files").select("id", { count: "exact", head: true }).limit(1);
  return error ? { ok: false, detail: error.message } : { ok: true };
}

async function checkCompute(): Promise<{ ok: boolean; detail?: string; runner?: string }> {
  const base = serverEnv("COMPUTE_DISPATCH_URL");
  if (!base) return { ok: false, detail: "compute not configured" };
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/health`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
    if (!res.ok) return { ok: false, detail: `compute returned ${res.status}` };
    const body = (await res.json()) as { runner?: string };
    return { ok: true, runner: body.runner };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function GET() {
  const [db, compute] = await Promise.all([hasPublicEnv() ? checkDb() : { ok: false, detail: "public env missing" }, checkCompute()]);
  const ok = db.ok;
  return NextResponse.json({ ok, db, compute, anthropic: Boolean(serverEnv("ANTHROPIC_API_KEY")), time: new Date().toISOString() },
    { status: ok ? 200 : 503 });
}
