// Job dispatch, web -> compute (docs/CONTRACTS.md section 4).
//
//   POST {COMPUTE_DISPATCH_URL}/dispatch
//   authorization: Bearer {COMPUTE_DISPATCH_SECRET}
//   { "job_id": "<uuid>" }  ->  200 { "ok": true, "call_id": "..." }
//
// The call id is stored on jobs.modal_call_id. When the dispatcher is not
// configured the job stays queued and the caller gets `ok: false` with a
// reason the UI can show ("compute not configured").

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { checkJobQuota } from "@/lib/billing/quota";
import { getUsage } from "@/lib/billing/usage";
import { serverEnv } from "@/lib/env";
import { tryAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/types/db";

export type DispatchResult = { ok: true; call_id: string } | { ok: false; reason: string };

const TIMEOUT_MS = 15_000;

export async function dispatchJob(jobId: string, userClient: SupabaseClient<Database>): Promise<DispatchResult> {
  const base = serverEnv("COMPUTE_DISPATCH_URL");
  const secret = serverEnv("COMPUTE_DISPATCH_SECRET");
  if (!base) {
    return { ok: false, reason: "compute not configured" };
  }

  // The dispatch step may use the service role (CONTRACTS section 7); fall
  // back to the caller's client, which RLS also allows for the caller's jobs.
  const writer = tryAdminClient() ?? userClient;

  // Quotas (Phase 10): every job passes through here, so the plan limits are
  // enforced once. An over-quota job is marked failed with the reason.
  const { data: jobRow } = await userClient.from("jobs").select("kind, user_id").eq("id", jobId).maybeSingle();
  if (jobRow) {
    try {
      const usage = await getUsage(userClient, jobRow.user_id);
      const decision = checkJobQuota(usage, jobRow.kind);
      if (!decision.ok) {
        await writer.from("jobs").update({ status: "failed", error: decision.reason, finished_at: new Date().toISOString() }).eq("id", jobId);
        return { ok: false, reason: decision.reason };
      }
    } catch (err) {
      console.warn("[dispatch] quota check skipped:", err instanceof Error ? err.message : err);
    }
  }

  let result: DispatchResult;
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/dispatch`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret ?? ""}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ job_id: jobId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 200);
      result = { ok: false, reason: `compute returned ${res.status}${text ? `: ${text}` : ""}` };
    } else {
      const body = (await res.json().catch(() => null)) as { ok?: boolean; call_id?: string } | null;
      if (!body || body.ok !== true || typeof body.call_id !== "string") {
        result = { ok: false, reason: "compute returned an unexpected response" };
      } else {
        result = { ok: true, call_id: body.call_id };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result = { ok: false, reason: `compute unreachable: ${message}` };
  }

  if (result.ok) {
    await writer.from("jobs").update({ modal_call_id: result.call_id, error: null }).eq("id", jobId);
  } else {
    // Leave the job queued so retry can re-dispatch; keep the reason visible.
    await writer.from("jobs").update({ error: `dispatch: ${result.reason}` }).eq("id", jobId);
  }
  return result;
}
