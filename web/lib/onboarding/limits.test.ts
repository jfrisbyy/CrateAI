import { describe, expect, it } from "vitest";
import { GPU_JOB_KINDS } from "@/lib/billing/quota";
import { PLAN_LIMITS } from "@/lib/billing/limits";
import type { Usage, UsageReport } from "@/lib/billing/usage";
import { fractions } from "@/lib/billing/usage";
import type { Plan } from "@/lib/types/db";
import { ANALYSIS_IS_UNMETERED, capWarnings, planSentence, planShape, UNMETERED_NOTE, usageShape } from "./limits";

const NOTHING: Usage = {
  storage_bytes: 0,
  gpu_seconds_month: 0,
  cpu_seconds_month: 0,
  stem_jobs_month: 0,
  chat_turns_today: 0,
  chat_turns_month: 0,
  web_searches_today: 0,
  web_searches_month: 0,
};

function report(usage: Partial<Usage> = {}, plan: Plan = "free"): UsageReport {
  const u = { ...NOTHING, ...usage };
  const limits = PLAN_LIMITS[plan];
  return {
    plan,
    plan_status: "active",
    limits,
    usage: u,
    fractions: fractions(limits, u),
    cost: { chat_usd: 0, web_search_usd: 0, compute_usd: 0, storage_usd: 0, total_usd: 0 },
    chat_turn_usd: 0.0333,
  };
}

describe("the shape of the plan, before anything is spent", () => {
  it("states the caps that are in lib/billing/limits.ts and no others", () => {
    const shape = planShape("free");
    expect(shape.map((c) => c.id)).toEqual(["storage", "chat", "search", "stems"]);
    expect(shape[0]?.value).toBe("2.00 GB");
    expect(shape[1]?.value).toBe(`${PLAN_LIMITS.free.chat_turns_per_day} a day, ${PLAN_LIMITS.free.chat_turns_per_month} a month`);
    expect(shape[3]?.value).toBe(`${PLAN_LIMITS.free.stem_jobs_per_month} a month`);
    expect(shape.every((c) => c.fraction === null)).toBe(true);
  });

  it("says the whole plan in one sentence, built from the caps", () => {
    const l = PLAN_LIMITS.free;
    expect(planSentence("free")).toBe(
      `Free: 2.00 GB of storage, ${l.stem_jobs_per_month} separations a month, ` +
        `${l.chat_turns_per_day} chat turns a day and ${l.chat_turns_per_month} a month.`,
    );
    expect(planSentence("pro")).toContain("Pro:");
  });

  it("moves with the caps rather than restating them", () => {
    expect(planShape("pro")[1]?.value).toBe(
      `${PLAN_LIMITS.pro.chat_turns_per_day} a day, ${PLAN_LIMITS.pro.chat_turns_per_month} a month`,
    );
  });

  it("only claims analysis is free while the quota check agrees", () => {
    // checkJobQuota refuses `stems` and the GPU kinds. `analyze` — the first
    // analysis and the loop finder — is not among them, which is what the
    // first screen tells the producer.
    expect(GPU_JOB_KINDS).not.toContain("analyze");
    expect(ANALYSIS_IS_UNMETERED).toBe(true);
    expect(UNMETERED_NOTE).toContain("Analysis and the loop finder spend none of this");
  });
});

describe("the counts, once something is spent", () => {
  it("shows what is left against the tighter of the two chat caps", () => {
    const shape = usageShape(report({ chat_turns_today: 6, chat_turns_month: 10 }));
    const chat = shape.find((c) => c.id === "chat");
    expect(chat?.detail).toBe("2 left");
    expect(chat?.fraction).toBeCloseTo(6 / PLAN_LIMITS.free.chat_turns_per_day, 6);
  });

  it("says how much storage is gone, in bytes the producer can check", () => {
    const shape = usageShape(report({ storage_bytes: 1024 * 1024 * 1024 }));
    expect(shape.find((c) => c.id === "storage")?.detail).toBe("1.00 GB used");
  });
});

describe("warning before the wall, not after it", () => {
  it("says nothing to a producer who has used nothing", () => {
    expect(capWarnings(report())).toEqual([]);
  });

  it("warns at four fifths of a cap", () => {
    expect(capWarnings(report({ chat_turns_today: 5, chat_turns_month: 5 }))).toEqual([]);
    expect(capWarnings(report({ chat_turns_today: 7, chat_turns_month: 7 }))[0]).toBe(
      "1 chat turn left. The day resets at midnight UTC, the month on the first.",
    );
  });

  it("names the cap that actually bit, and what still works without it", () => {
    const daily = capWarnings(report({ chat_turns_today: 8, chat_turns_month: 8 }))[0];
    expect(daily).toContain("No chat turns left today");
    expect(daily).toContain("the analysis, the loops and the library still work");

    const monthly = capWarnings(report({ chat_turns_today: 1, chat_turns_month: 40 }))[0];
    expect(monthly).toContain("No chat turns left this month");
    expect(monthly).toContain("resets on the first");
  });

  it("warns on storage and separations, and stays quiet on the rest", () => {
    const full = capWarnings(report({ storage_bytes: 1.9 * 1024 * 1024 * 1024, stem_jobs_month: 5 }));
    expect(full.some((w) => w.includes("of storage left"))).toBe(true);
    expect(full.some((w) => w.includes("No separations left this month"))).toBe(true);
  });

  it("tells a producer out of web lookups that the measurements do not need them", () => {
    expect(capWarnings(report({ web_searches_today: 5, web_searches_month: 5 })).at(-1)).toContain(
      "Musical facts still come from the analysis",
    );
  });
});
