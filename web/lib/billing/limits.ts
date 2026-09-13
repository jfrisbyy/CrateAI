// Plan limits: the one place every cap in the product is written down.
//
// Nothing else may hard-code a quota. `lib/chat/limits.ts` re-exports the free
// tier for the chat seam, `lib/billing/quota.ts` decides against these, and
// `/api/usage` shows usage against them.
//
// ---------------------------------------------------------------------------
// Why these numbers (the arithmetic is in lib/billing/cost.ts; prose in
// docs/HANDOFF_launch_readiness.md)
// ---------------------------------------------------------------------------
//
// Conversation is the expensive thing here, not the GPU. One metered chat turn
// on the routing in lib/anthropic/models.ts, with the system prompt cached,
// costs about $0.033 — against about $0.113 for the same turn on Opus 5 with
// no caching, which is what the packet's free tier was priced against.
//
// The old free tier was 50 chat turns a day and nothing monthly. A daily cap
// alone cannot bound a monthly bill: 50/day x 30 days x $0.113 is about $169 a
// month from one free account that pays nothing. So every chat-shaped limit
// now has BOTH a daily cap (which bounds a burst) and a monthly cap (which is
// the actual financial ceiling), and the monthly one is the binding number.
//
//   free, fully used:  40 turns x $0.0333     = $1.33
//                      25 searches x $0.005   = $0.13
//                      30 GPU minutes         = $0.55   (5 stem jobs sit inside this)
//                      2 GB storage           = $0.04
//                                             ~ $2.05 a month, worst case
//
//   pro, fully used:  400 turns x $0.0333     = $13.34
//                     600 searches x $0.005   =  $3.00
//                     5 GPU hours             =  $5.51  (100 stem jobs sit inside this)
//                     50 GB storage           =  $1.05
//                                             ~ $22.90 a month, worst case
//
// So Pro has to be priced above ~$23 to be safe at 100% utilisation, or around
// $19 with the usual 40-50% utilisation. The price itself is still
// TODO(owner) (OPEN_QUESTIONS J.31); these caps are what it has to clear.
//
// The storage and stem-job numbers are the packet's, kept: the arithmetic says
// they were never the problem.

import type { Plan } from "@/lib/types/db";
import { GIB, UNIT_COSTS_USD } from "./cost";

export interface PlanLimits {
  storage_bytes: number;
  stem_jobs_per_month: number;
  gpu_seconds_per_month: number;
  /** burst cap: how much one day can cost */
  chat_turns_per_day: number;
  /** the binding cap: how much a month can cost */
  chat_turns_per_month: number;
  web_searches_per_day: number;
  web_searches_per_month: number;
}

export const GB = 1024 * 1024 * 1024;

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    storage_bytes: 2 * GB,
    stem_jobs_per_month: 5,
    gpu_seconds_per_month: 30 * 60,
    chat_turns_per_day: 8,
    chat_turns_per_month: 40,
    web_searches_per_day: 5,
    web_searches_per_month: 25,
  },
  pro: {
    storage_bytes: 50 * GB,
    stem_jobs_per_month: 100,
    gpu_seconds_per_month: 5 * 60 * 60,
    chat_turns_per_day: 50,
    chat_turns_per_month: 400,
    web_searches_per_day: 100,
    web_searches_per_month: 600,
  },
};

export const PLAN_LABELS: Record<Plan, string> = { free: "Free", pro: "Pro" };

/** Every limit, in the order the account page shows them. */
export const LIMIT_KEYS: readonly (keyof PlanLimits)[] = [
  "storage_bytes",
  "stem_jobs_per_month",
  "gpu_seconds_per_month",
  "chat_turns_per_day",
  "chat_turns_per_month",
  "web_searches_per_day",
  "web_searches_per_month",
];

/**
 * The worst case a plan can cost us in a month, from the caps and the unit
 * costs. Used by the handoff arithmetic and by the plan-limits test, so the
 * numbers in the comment above can never quietly drift from the constants.
 */
export function planCeilingUsd(plan: Plan, chatTurnUsd: number): number {
  const l = PLAN_LIMITS[plan];
  return (
    l.chat_turns_per_month * chatTurnUsd +
    l.web_searches_per_month * UNIT_COSTS_USD.web_search +
    l.gpu_seconds_per_month * UNIT_COSTS_USD.gpu_second +
    (l.storage_bytes / GIB) * UNIT_COSTS_USD.storage_gib_month
  );
}

export function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function formatMinutes(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}
