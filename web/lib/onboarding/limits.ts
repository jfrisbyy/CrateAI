// The free tier, legible before it bites.
//
// A producer who hits a wall mid-session with no warning leaves angry, so the
// shape of the plan is stated on the first screen, before anything has been
// spent, and the counts appear again when one of them gets close.
//
// Two facts make this honest rather than nagging:
//
//   The caps are not all alike. `checkJobQuota` refuses only separation and
//   the GPU kinds; `analyze` — which is both the first analysis and the loop
//   finder — is never refused for quota. So the expensive-feeling part of this
//   product is the free part, and the scarce one is conversation. Saying that
//   plainly is more useful than a progress bar.
//
//   Nothing here invents a number. Every cap comes from `lib/billing/limits.ts`
//   and every count from `/api/usage`, which reads the same `usage_events`
//   table the enforcement reads.

import { chatTurnsLeft, GPU_JOB_KINDS, webSearchesLeft } from "@/lib/billing/quota";
import { formatBytes, formatMinutes, PLAN_LABELS, PLAN_LIMITS, type PlanLimits } from "@/lib/billing/limits";
import type { UsageReport } from "@/lib/billing/usage";
import type { Plan } from "@/lib/types/db";

export interface CapLine {
  id: string;
  label: string;
  /** the cap itself */
  value: string;
  /** how much of it is gone, 0..1+, or null when nothing has been read yet */
  fraction: number | null;
  /** what is left, in the producer's terms */
  detail: string | null;
}

/** True while a first analysis and the loop finder cost nothing from the caps. */
export const ANALYSIS_IS_UNMETERED = !GPU_JOB_KINDS.includes("analyze");

/**
 * The one sentence that decides whether the caps matter to this producer
 * today. Guarded by the constant above so it cannot outlive its truth.
 */
export const UNMETERED_NOTE = ANALYSIS_IS_UNMETERED
  ? "Analysis and the loop finder spend none of this: only conversation, web lookups, separation and the bytes you store."
  : "Every job here counts against the caps above.";

/**
 * The whole plan in one sentence, for the first screen, which has no room for
 * a table and every reason to say what "free" means before a record is dropped.
 */
export function planSentence(plan: Plan = "free"): string {
  const l = PLAN_LIMITS[plan];
  return (
    `${PLAN_LABELS[plan]}: ${formatBytes(l.storage_bytes)} of storage, ${l.stem_jobs_per_month} separations a month, ` +
    `${l.chat_turns_per_day} chat turns a day and ${l.chat_turns_per_month} a month.`
  );
}

/** What a plan is, before anything has been used. */
export function planShape(plan: Plan = "free"): CapLine[] {
  const limits: PlanLimits = PLAN_LIMITS[plan];
  return [
    { id: "storage", label: "Storage", value: formatBytes(limits.storage_bytes), fraction: null, detail: null },
    {
      id: "chat",
      label: "Chat turns",
      value: `${limits.chat_turns_per_day} a day, ${limits.chat_turns_per_month} a month`,
      fraction: null,
      detail: null,
    },
    {
      id: "search",
      label: "Web lookups",
      value: `${limits.web_searches_per_day} a day, ${limits.web_searches_per_month} a month`,
      fraction: null,
      detail: null,
    },
    {
      id: "stems",
      label: "Separations",
      value: `${limits.stem_jobs_per_month} a month`,
      fraction: null,
      detail: formatMinutes(limits.gpu_seconds_per_month) + " of GPU, which they sit inside",
    },
  ];
}

/** The same shape with the counts filled in, for a producer who has spent some. */
export function usageShape(report: UsageReport): CapLine[] {
  const { limits, usage, fractions } = report;
  return [
    {
      id: "storage",
      label: "Storage",
      value: formatBytes(limits.storage_bytes),
      fraction: fractions.storage_bytes,
      detail: `${formatBytes(usage.storage_bytes)} used`,
    },
    {
      id: "chat",
      label: "Chat turns",
      value: `${limits.chat_turns_per_day} a day, ${limits.chat_turns_per_month} a month`,
      fraction: Math.max(fractions.chat_turns_per_day, fractions.chat_turns_per_month),
      detail: `${chatTurnsLeft(report)} left`,
    },
    {
      id: "search",
      label: "Web lookups",
      value: `${limits.web_searches_per_day} a day, ${limits.web_searches_per_month} a month`,
      fraction: Math.max(fractions.web_searches_per_day, fractions.web_searches_per_month),
      detail: `${webSearchesLeft(report)} left`,
    },
    {
      id: "stems",
      label: "Separations",
      value: `${limits.stem_jobs_per_month} a month`,
      fraction: fractions.stem_jobs_per_month,
      detail: `${Math.max(0, limits.stem_jobs_per_month - usage.stem_jobs_month)} left`,
    },
  ];
}

/** Warn at four fifths of a cap: late enough not to nag, early enough to plan. */
export const WARN_AT = 0.8;

/**
 * What to say before a wall is hit, most urgent first. Empty when every cap
 * has room, which is the answer most of the time.
 */
export function capWarnings(report: UsageReport): string[] {
  const { limits, usage, fractions, plan } = report;
  const out: string[] = [];
  const turns = chatTurnsLeft(report);
  if (turns === 0) {
    out.push(
      usage.chat_turns_month >= limits.chat_turns_per_month
        ? `No chat turns left this month on ${plan}. The count resets on the first; the analysis, the loops and the library still work.`
        : `No chat turns left today on ${plan}. The count resets at midnight UTC; the analysis, the loops and the library still work.`,
    );
  } else if (Math.max(fractions.chat_turns_per_day, fractions.chat_turns_per_month) >= WARN_AT) {
    out.push(`${turns} chat turn${turns === 1 ? "" : "s"} left. The day resets at midnight UTC, the month on the first.`);
  }

  if (fractions.storage_bytes >= WARN_AT) {
    const left = Math.max(0, limits.storage_bytes - usage.storage_bytes);
    out.push(`${formatBytes(left)} of storage left of ${formatBytes(limits.storage_bytes)}.`);
  }

  const stemsLeft = Math.max(0, limits.stem_jobs_per_month - usage.stem_jobs_month);
  if (fractions.stem_jobs_per_month >= WARN_AT) {
    out.push(
      stemsLeft === 0
        ? `No separations left this month on ${plan}; the count resets on the first.`
        : `${stemsLeft} separation${stemsLeft === 1 ? "" : "s"} left this month.`,
    );
  }

  const searchesLeft = webSearchesLeft(report);
  if (searchesLeft === 0) {
    out.push("No web lookups left. Musical facts still come from the analysis, which does not need them.");
  }
  return out;
}
