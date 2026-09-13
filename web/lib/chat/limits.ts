// Free-tier caps (BUILD_PACKET section 19, OPEN_QUESTIONS J.31) as constants,
// and the per-user daily counts they are checked against. Kept deliberately
// simple: chat turns are the caller's `messages` rows with role user today;
// web searches are counted from the tool calls recorded on today's assistant
// messages (each web_search is one, identify_context records how many it
// ran). Phase 10 replaces the counting with metering and billing; the
// constants stay here.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/types/db";

export const FREE_TIER = {
  chat_turns_per_day: 50,
  web_searches_per_day: 20,
  storage_bytes: 2 * 1024 * 1024 * 1024,
  stem_jobs_per_month: 5,
} as const;

export interface UsageCounts {
  chat_turns_today: number;
  web_searches_today: number;
  /** ISO start of the UTC day the counts cover */
  day_start: string;
}

export interface UsageSource {
  countUserMessagesSince(iso: string): Promise<number>;
  /** the tool_calls column of the caller's assistant messages since `iso` */
  listToolCallsSince(iso: string): Promise<Array<Json | null>>;
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

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

export async function readUsage(source: UsageSource, now: Date = new Date()): Promise<UsageCounts> {
  const dayStart = startOfUtcDay(now).toISOString();
  const [turns, toolCalls] = await Promise.all([source.countUserMessagesSince(dayStart), source.listToolCallsSince(dayStart)]);
  return {
    chat_turns_today: turns,
    web_searches_today: toolCalls.reduce<number>((sum, tc) => sum + webSearchesIn(tc), 0),
    day_start: dayStart,
  };
}

export function chatTurnsLeft(usage: UsageCounts): number {
  return Math.max(0, FREE_TIER.chat_turns_per_day - usage.chat_turns_today);
}

export function webSearchesLeft(usage: UsageCounts): number {
  return Math.max(0, FREE_TIER.web_searches_per_day - usage.web_searches_today);
}

export const CHAT_QUOTA_MESSAGE = `You've used today's ${FREE_TIER.chat_turns_per_day} chat turns on the free tier. The count resets at midnight UTC.`;
export const WEB_QUOTA_MESSAGE = `Today's ${FREE_TIER.web_searches_per_day} web searches on the free tier are used up; the count resets at midnight UTC. I can still answer from the analysis.`;

/** The counts from the caller's own rows (RLS scopes both queries to the user). */
export function supabaseUsageSource(supabase: SupabaseClient<Database>): UsageSource {
  return {
    async countUserMessagesSince(iso) {
      const { count, error } = await supabase.from("messages").select("id", { count: "exact", head: true }).eq("role", "user").gte("created_at", iso);
      if (error) throw new Error(`counting chat turns: ${error.message}`);
      return count ?? 0;
    },
    async listToolCallsSince(iso) {
      const { data, error } = await supabase.from("messages").select("tool_calls").eq("role", "assistant").gte("created_at", iso).limit(500);
      if (error) throw new Error(`counting web searches: ${error.message}`);
      return (data ?? []).map((r) => r.tool_calls);
    },
  };
}
