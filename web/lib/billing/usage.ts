// Usage against the plan limits, and what it has cost.
//
// One table answers it: `usage_events`, summed by `usage_summary(p_since)`.
// Compute writes gpu_seconds / cpu_seconds / stem_job; the web app writes
// chat_turn and web_search (lib/billing/meter.ts). Storage is the one derived
// number — `usage_summary` sums `files.size_bytes` rather than metering a
// delta per upload, because the total is what the cap is about.
//
// The RPC is called twice, once since the start of the month and once since
// the start of the day, so the daily burst caps and the monthly ceilings read
// from the same place.
//
// `messages` is still counted as a *floor* under the metered chat turns: if
// metering is off (no service role) the cap still bites, and the number shown
// can never be lower than the conversation itself proves.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Plan, ProfileRow } from "@/lib/types/db";
import { CHAT_MODEL } from "@/lib/anthropic/models";
import { chatTurnUsd, estimateSpendUsd, type SpendEstimate } from "./cost";
import { PLAN_LIMITS, type PlanLimits } from "./limits";

export interface Usage {
  storage_bytes: number;
  gpu_seconds_month: number;
  cpu_seconds_month: number;
  stem_jobs_month: number;
  chat_turns_today: number;
  chat_turns_month: number;
  web_searches_today: number;
  web_searches_month: number;
}

export interface UsageReport {
  plan: Plan;
  plan_status: ProfileRow["plan_status"];
  limits: PlanLimits;
  usage: Usage;
  /** fraction used per limit, 0..1+ */
  fractions: Record<keyof PlanLimits, number>;
  /** our estimated cost of this account this month, from lib/billing/cost.ts */
  cost: SpendEstimate;
  /** what one chat turn costs on the model chat is routed to, so the UI can say it */
  chat_turn_usd: number;
}

export function startOfMonthIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

export function startOfDayIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export function fractions(limits: PlanLimits, usage: Usage): Record<keyof PlanLimits, number> {
  return {
    storage_bytes: usage.storage_bytes / limits.storage_bytes,
    stem_jobs_per_month: usage.stem_jobs_month / limits.stem_jobs_per_month,
    gpu_seconds_per_month: usage.gpu_seconds_month / limits.gpu_seconds_per_month,
    chat_turns_per_day: usage.chat_turns_today / limits.chat_turns_per_day,
    chat_turns_per_month: usage.chat_turns_month / limits.chat_turns_per_month,
    web_searches_per_day: usage.web_searches_today / limits.web_searches_per_day,
    web_searches_per_month: usage.web_searches_month / limits.web_searches_per_month,
  };
}

export async function getProfile(supabase: SupabaseClient<Database>, userId: string): Promise<ProfileRow> {
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (data) return data;
  // Profiles are created by trigger; a user created before the migration gets defaults.
  return {
    id: userId, email: null, plan: "free", plan_status: "active", stripe_customer_id: null,
    stripe_subscription_id: null, corrections_opt_in: false, loop_personalization: true,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
}

/** The caller's plan caps. One query, so a route can check a quota without the whole report. */
export async function getPlanLimits(supabase: SupabaseClient<Database>, userId: string): Promise<{ plan: Plan; limits: PlanLimits }> {
  const profile = await getProfile(supabase, userId);
  return { plan: profile.plan, limits: PLAN_LIMITS[profile.plan] };
}

type Totals = Map<string, number>;

function totalsOf(rows: Array<{ kind: string; total: number | string }> | null): Totals {
  const totals: Totals = new Map();
  for (const row of rows ?? []) totals.set(row.kind, Number(row.total));
  return totals;
}

/** `usage_summary` is security invoker: it only ever sums the caller's own rows. */
export async function readTotals(supabase: SupabaseClient<Database>, since: string): Promise<Totals> {
  const { data } = await supabase.rpc("usage_summary", { p_since: since });
  return totalsOf(data);
}

export async function getUsage(supabase: SupabaseClient<Database>, userId: string, now = new Date()): Promise<UsageReport> {
  const profile = await getProfile(supabase, userId);
  const monthStart = startOfMonthIso(now);
  const dayStart = startOfDayIso(now);
  const [month, day, messagesMonth, messagesDay] = await Promise.all([
    readTotals(supabase, monthStart),
    readTotals(supabase, dayStart),
    countUserMessagesSince(supabase, monthStart),
    countUserMessagesSince(supabase, dayStart),
  ]);

  const usage: Usage = {
    storage_bytes: month.get("storage_bytes") ?? 0,
    gpu_seconds_month: month.get("gpu_seconds") ?? 0,
    cpu_seconds_month: month.get("cpu_seconds") ?? 0,
    stem_jobs_month: month.get("stem_job") ?? 0,
    // the metered count, never below what the conversation itself proves
    chat_turns_today: Math.max(day.get("chat_turn") ?? 0, messagesDay),
    chat_turns_month: Math.max(month.get("chat_turn") ?? 0, messagesMonth),
    web_searches_today: day.get("web_search") ?? 0,
    web_searches_month: month.get("web_search") ?? 0,
  };
  const limits = PLAN_LIMITS[profile.plan];
  return {
    plan: profile.plan,
    plan_status: profile.plan_status,
    limits,
    usage,
    fractions: fractions(limits, usage),
    cost: estimateSpendUsd(usage, CHAT_MODEL),
    chat_turn_usd: chatTurnUsd(CHAT_MODEL),
  };
}

/** RLS scopes this to the caller. The floor under the metered chat turns. */
async function countUserMessagesSince(supabase: SupabaseClient<Database>, iso: string): Promise<number> {
  const { count } = await supabase
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("role", "user")
    .gte("created_at", iso);
  return count ?? 0;
}
