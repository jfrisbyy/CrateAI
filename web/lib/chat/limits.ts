// The chat seam's view of the plan caps: how many turns and web searches this
// account has left, the sentences the producer sees when they run out, and the
// metering that makes the counts true.
//
// The caps themselves are NOT here. Every number lives in
// `lib/billing/limits.ts` with the arithmetic that chose it; this file only
// reads them, so the chat and the account page can never disagree about what
// the free tier is.
//
// What changed in the launch pass: the counts used to be derived by re-reading
// `messages` and the tool calls recorded on assistant rows, which meant a
// direct `POST /api/web/search` cost nothing and a turn that spent four
// searches inside one tool call was invisible until it was written down. Now
// every turn and every search writes a `usage_events` row (lib/billing/
// meter.ts) and the counts come from `usage_summary`, the same table and the
// same function compute has always metered into. `messages` stays as a floor
// under the chat-turn count so the cap still bites if metering is unavailable.

import type { SupabaseClient } from "@supabase/supabase-js";
import { PLAN_LIMITS } from "@/lib/billing/limits";
import { meterUsage } from "@/lib/billing/meter";
import { chatTurnsLeft, webSearchesLeft } from "@/lib/billing/quota";
import { getUsage, type UsageReport } from "@/lib/billing/usage";
import type { Database, Json } from "@/lib/types/db";

/**
 * The free tier, for the places that describe it rather than enforce it.
 * An alias, not a second copy: `lib/billing/limits.ts` is the source.
 */
export const FREE_TIER = PLAN_LIMITS.free;

/** How many more a caller may take right now: the tighter of the day's and the month's cap. */
export { chatTurnsLeft, webSearchesLeft };

// ---------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------

/**
 * Everything a route needs to decide a chat quota: the caller's plan, its
 * caps, and today's and this month's metered usage. RLS scopes every read to
 * the caller.
 */
export async function readUsage(supabase: SupabaseClient<Database>, userId: string, now: Date = new Date()): Promise<UsageReport> {
  return getUsage(supabase, userId, now);
}

/** The 429 body when a turn is refused, in the producer's language, not SQL's. */
export function chatQuotaMessage(report: UsageReport): string {
  const { limits, usage } = report;
  if (usage.chat_turns_month >= limits.chat_turns_per_month) {
    return `You've used this month's ${limits.chat_turns_per_month} chat turns on the ${report.plan} plan. The count resets on the first of the month.`;
  }
  return `You've used today's ${limits.chat_turns_per_day} chat turns on the ${report.plan} plan. The count resets at midnight UTC.`;
}

/** The same for the search route. */
export function webQuotaMessage(report: UsageReport): string {
  const { limits, usage } = report;
  if (usage.web_searches_month >= limits.web_searches_per_month) {
    return `You've used this month's ${limits.web_searches_per_month} web searches on the ${report.plan} plan. The count resets on the first of the month.`;
  }
  return `You've used today's ${limits.web_searches_per_day} web searches on the ${report.plan} plan. The count resets at midnight UTC.`;
}

/**
 * What the chat says mid-turn when the search budget runs out. It is a tool
 * result, so it stays plan-neutral: the route already gave them the numbers.
 */
export const WEB_QUOTA_MESSAGE =
  "Your web searches for this period are used up; the daily count resets at midnight UTC and the monthly one on the first. I can still answer from the analysis.";

// ---------------------------------------------------------------------------
// counting what a turn spent
// ---------------------------------------------------------------------------

/** Web searches recorded in one assistant message's tool_calls. */
export function webSearchesIn(toolCalls: Json | null): number {
  if (!Array.isArray(toolCalls)) return 0;
  let n = 0;
  for (const call of toolCalls) {
    if (!call || typeof call !== "object" || Array.isArray(call)) continue;
    const name = call.name;
    if (name === "web_search") n += 1;
    else if (name === "identify_context") n += typeof call.searches === "number" ? call.searches : 1;
    else if (name === "batch" && Array.isArray(call.nested)) n += webSearchesIn(call.nested);
  }
  return n;
}

// ---------------------------------------------------------------------------
// metering
// ---------------------------------------------------------------------------

/**
 * One turn, metered the moment it is accepted — before the model is called, so
 * a turn that fails halfway still counts against the burst cap. Best effort:
 * `meterUsage` never throws.
 */
export async function meterChatTurn(userId: string): Promise<void> {
  await meterUsage(userId, [{ kind: "chat_turn" }]);
}

/** The searches one turn actually ran, metered once when the turn finishes. */
export async function meterWebSearches(userId: string, count: number): Promise<void> {
  if (count <= 0) return;
  await meterUsage(userId, [{ kind: "web_search", amount: count }]);
}
