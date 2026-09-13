// Metering: one `usage_events` row per billable thing the web app does, so
// that table answers "what has this account cost me" on its own.
//
// Compute already meters every finished job (`analysis/lockedgroove/jobs/
// runner.py` writes gpu_seconds, cpu_seconds and stem_job). This closes the
// other half: chat turns and web searches, which were only ever counted by
// re-reading `messages` and the tool calls recorded on them, so a direct call
// to `/api/web/search` was free and nothing outside a conversation was seen.
//
// `usage_events` has a select policy for the owner and no insert policy, so
// writes go through the service role, exactly like compute's. Metering is
// best effort and never fails the request it is attached to: a producer's turn
// must not 500 because a counter could not be written. When it cannot write it
// says so once in the server log, and the quota read falls back to the
// `messages` floor (lib/chat/limits.ts), so a missing service role loosens the
// accounting but never removes the cap.

import "server-only";

import { tryAdminClient } from "@/lib/supabase/admin";
import type { UsageKind } from "@/lib/types/db";

export interface MeterEvent {
  kind: UsageKind;
  /** how much of that kind (a web_search tool that ran four searches is 4) */
  amount?: number;
  job_id?: string | null;
}

/**
 * Write usage events for one user. Returns how many rows were written; 0 means
 * nothing was metered (no service role, or the insert failed), never a throw.
 */
export async function meterUsage(userId: string, events: MeterEvent[]): Promise<number> {
  const rows = events
    .filter((e) => (e.amount ?? 1) > 0)
    .map((e) => ({
      id: crypto.randomUUID(),
      user_id: userId,
      kind: e.kind,
      amount: e.amount ?? 1,
      job_id: e.job_id ?? null,
    }));
  if (rows.length === 0) return 0;

  const admin = tryAdminClient();
  if (!admin) {
    warnOnce("SUPABASE_SERVICE_ROLE_KEY is not set; chat turns and web searches are not being metered into usage_events.");
    return 0;
  }
  try {
    const { error } = await admin.from("usage_events").insert(rows);
    if (error) {
      warnOnce(`usage_events insert failed: ${error.message}`);
      return 0;
    }
    return rows.length;
  } catch (err) {
    warnOnce(`usage_events insert threw: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}

const warned = new Set<string>();

/** One line per distinct problem per process: a broken meter must not flood the log. */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`[usage] ${message}`);
}

/** Tests only: forget which warnings have been printed. */
export function resetMeterWarnings(): void {
  warned.clear();
}
