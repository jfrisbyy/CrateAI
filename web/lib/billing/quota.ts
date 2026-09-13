// Quota decisions. Pure functions over a UsageReport so they're testable; the
// dispatch step and the upload prepare route call them.

import type { JobKind } from "@/lib/types/db";
import { formatBytes, formatMinutes } from "./limits";
import type { UsageReport } from "./usage";

export type QuotaDecision = { ok: true } | { ok: false; reason: string };

/** Job kinds that spend GPU minutes (mirrors GPU_METERED_KINDS in the compute runner). */
export const GPU_JOB_KINDS: readonly JobKind[] = ["stems", "embed", "beatbox_train"];

export function checkJobQuota(report: UsageReport, kind: JobKind): QuotaDecision {
  const { limits, usage, plan } = report;
  if (report.plan_status === "past_due" && plan === "pro") {
    return { ok: false, reason: "quota: your subscription is past due; update the payment method in Account" };
  }
  if (kind === "stems" && usage.stem_jobs_month >= limits.stem_jobs_per_month) {
    return {
      ok: false,
      reason: `quota: ${limits.stem_jobs_per_month} stem separations a month on the ${plan} plan; used ${usage.stem_jobs_month}`,
    };
  }
  if (GPU_JOB_KINDS.includes(kind) && usage.gpu_seconds_month >= limits.gpu_seconds_per_month) {
    return {
      ok: false,
      reason: `quota: ${formatMinutes(limits.gpu_seconds_per_month)} of GPU time a month on the ${plan} plan; used ${formatMinutes(usage.gpu_seconds_month)}`,
    };
  }
  return { ok: true };
}

export function checkStorageQuota(report: UsageReport, addBytes: number): QuotaDecision {
  const after = report.usage.storage_bytes + Math.max(0, addBytes);
  if (after > report.limits.storage_bytes) {
    return {
      ok: false,
      reason: `quota: ${formatBytes(report.limits.storage_bytes)} of storage on the ${report.plan} plan; ` +
        `${formatBytes(report.usage.storage_bytes)} used, this file needs ${formatBytes(addBytes)}`,
    };
  }
  return { ok: true };
}

export function checkChatQuota(report: UsageReport): QuotaDecision {
  if (report.usage.chat_turns_today >= report.limits.chat_turns_per_day) {
    return { ok: false, reason: `quota: ${report.limits.chat_turns_per_day} chat turns a day on the ${report.plan} plan` };
  }
  return { ok: true };
}

export function checkWebSearchQuota(report: UsageReport): QuotaDecision {
  if (report.usage.web_searches_today >= report.limits.web_searches_per_day) {
    return { ok: false, reason: `quota: ${report.limits.web_searches_per_day} web searches a day on the ${report.plan} plan` };
  }
  return { ok: true };
}
