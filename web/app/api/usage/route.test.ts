import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, seedFile, seedProfile, seedUsageEvent, USER_A, USER_B, type World } from "@/lib/testing";
import type { UsageReport } from "@/lib/billing/usage";
import { GB } from "@/lib/billing/limits";
import { GET } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/usage", () => {
  it("reports this period's usage against the plan's limits", async () => {
    seedProfile(world.db, USER_A);
    seedFile(world.db, USER_A, { size_bytes: 100 * 1024 * 1024 });
    seedUsageEvent(world.db, USER_A, { kind: "stem_job", amount: 2 });
    seedUsageEvent(world.db, USER_A, { kind: "gpu_seconds", amount: 120 });
    const { status, body } = await call<UsageReport>(GET());
    expect(status).toBe(200);
    expect(body.plan).toBe("free");
    expect(body.limits.storage_bytes).toBe(2 * GB);
    expect(body.usage.stem_jobs_month).toBe(2);
    expect(body.usage.gpu_seconds_month).toBe(120);
    expect(body.usage.storage_bytes).toBe(100 * 1024 * 1024);
    expect(body.fractions.stem_jobs_per_month).toBeCloseTo(0.4);
  });

  it("counts nothing from another user", async () => {
    seedFile(world.db, USER_B, { size_bytes: 500 });
    seedUsageEvent(world.db, USER_B, { kind: "stem_job", amount: 4 });
    const { body } = await call<UsageReport>(GET());
    expect(body.usage.storage_bytes).toBe(0);
    expect(body.usage.stem_jobs_month).toBe(0);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await GET()).status).toBe(401);
  });
});
