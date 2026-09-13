// Usage against the plan limits. Storage comes from files.size_bytes; job
// seconds and stem jobs from usage_events (written by compute); chat turns
// from the user's messages today; web searches from usage_events.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Plan, ProfileRow } from "@/lib/types/db";
import { PLAN_LIMITS, type PlanLimits } from "./limits";

export interface Usage {
  storage_bytes: number;
  gpu_seconds_month: number;
  cpu_seconds_month: number;
  stem_jobs_month: number;
  chat_turns_today: number;
  web_searches_today: number;
}

export interface UsageReport {
  plan: Plan;
  plan_status: ProfileRow["plan_status"];
  limits: PlanLimits;
  usage: Usage;
  /** fraction used per limit, 0..1+ */
  fractions: Record<keyof PlanLimits, number>;
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
    web_searches_per_day: usage.web_searches_today / limits.web_searches_per_day,
  };
}

export async function getProfile(supabase: SupabaseClient<Database>, userId: string): Promise<ProfileRow> {
  const { data } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (data) return data;
  // Profiles are created by trigger; a user created before the migration gets defaults.
  return {
    id: userId, email: null, plan: "free", plan_status: "active", stripe_customer_id: null,
    stripe_subscription_id: null, corrections_opt_in: false, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function getUsage(supabase: SupabaseClient<Database>, userId: string, now = new Date()): Promise<UsageReport> {
  const profile = await getProfile(supabase, userId);
  const monthStart = startOfMonthIso(now);
  const dayStart = startOfDayIso(now);
  const [summary, chatToday, searchesToday] = await Promise.all([
    supabase.rpc("usage_summary", { p_since: monthStart }),
    supabase.from("messages").select("id", { count: "exact", head: true }).eq("role", "user").gte("created_at", dayStart),
    supabase.from("usage_events").select("id", { count: "exact", head: true }).eq("kind", "web_search").gte("created_at", dayStart),
  ]);
  const totals = new Map<string, number>();
  for (const row of summary.data ?? []) totals.set(row.kind, Number(row.total));
  const usage: Usage = {
    storage_bytes: totals.get("storage_bytes") ?? 0,
    gpu_seconds_month: totals.get("gpu_seconds") ?? 0,
    cpu_seconds_month: totals.get("cpu_seconds") ?? 0,
    stem_jobs_month: totals.get("stem_job") ?? 0,
    chat_turns_today: chatToday.count ?? 0,
    web_searches_today: searchesToday.count ?? 0,
  };
  const limits = PLAN_LIMITS[profile.plan];
  return { plan: profile.plan, plan_status: profile.plan_status, limits, usage, fractions: fractions(limits, usage) };
}
