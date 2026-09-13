// Plan limits (BUILD_PACKET section 19). Constants until pricing is set; the
// pro numbers are placeholders marked TODO(owner) in OPEN_QUESTIONS J.31.

import type { Plan } from "@/lib/types/db";

export interface PlanLimits {
  storage_bytes: number;
  stem_jobs_per_month: number;
  gpu_seconds_per_month: number;
  chat_turns_per_day: number;
  web_searches_per_day: number;
}

export const GB = 1024 * 1024 * 1024;

export const PLAN_LIMITS: Record<Plan, PlanLimits> = {
  free: {
    storage_bytes: 2 * GB,
    stem_jobs_per_month: 5,
    gpu_seconds_per_month: 30 * 60,
    chat_turns_per_day: 50,
    web_searches_per_day: 20,
  },
  pro: {
    storage_bytes: 50 * GB,
    stem_jobs_per_month: 200,
    gpu_seconds_per_month: 10 * 60 * 60,
    chat_turns_per_day: 1000,
    web_searches_per_day: 300,
  },
};

export const PLAN_LABELS: Record<Plan, string> = { free: "Free", pro: "Pro" };

export function formatBytes(n: number): string {
  if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

export function formatMinutes(seconds: number): string {
  return `${Math.round(seconds / 60)} min`;
}
