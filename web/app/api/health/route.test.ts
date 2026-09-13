import { beforeEach, describe, expect, it } from "vitest";
import { call, COMPUTE_URL, createWorld, jsonResponse, type World } from "@/lib/testing";
import { GET } from "./route";

let world: World;

type Health = { ok: boolean; db: { ok: boolean; detail?: string }; compute: { ok: boolean; runner?: string; detail?: string }; anthropic: boolean };

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/health", () => {
  it("reports the database and compute", async () => {
    const { status, body } = await call<Health>(GET());
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.db.ok).toBe(true);
    expect(body.compute).toEqual({ ok: true, runner: "test" });
    expect(body.anthropic).toBe(false);
  });

  it("503s when the database cannot be reached", async () => {
    world.setServiceRole(false);
    const { status, body } = await call<Health>(GET());
    expect(status).toBe(503);
    expect(body.db).toEqual({ ok: false, detail: "service role not configured" });
  });

  it("stays up when only compute is down", async () => {
    world.onFetch((url) => (url === `${COMPUTE_URL}/health` ? jsonResponse({ error: "down" }, 500) : null));
    const { status, body } = await call<Health>(GET());
    expect(status).toBe(200);
    expect(body.compute.ok).toBe(false);
    expect(body.compute.detail).toContain("500");
  });

  it("needs no session (it is the uptime probe)", async () => {
    world.signOut();
    expect((await GET()).status).toBe(200);
  });
});
