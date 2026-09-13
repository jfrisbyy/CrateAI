import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, patch, rawPost, seedProfile, USER_A, USER_B, type World } from "@/lib/testing";
import type { ProfileRow } from "@/lib/types/db";
import { GET, PATCH } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/profile", () => {
  it("returns the caller's profile", async () => {
    seedProfile(world.db, USER_A, { plan: "pro", plan_status: "active" });
    const { status, body } = await call<{ profile: ProfileRow }>(GET());
    expect(status).toBe(200);
    expect(body.profile).toMatchObject({ id: USER_A, plan: "pro" });
  });

  it("falls back to free defaults when the row is missing, and never reads another user's", async () => {
    seedProfile(world.db, USER_B, { plan: "pro" });
    const { body } = await call<{ profile: ProfileRow }>(GET());
    expect(body.profile).toMatchObject({ id: USER_A, plan: "free", plan_status: "active" });
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await GET()).status).toBe(401);
  });
});

describe("PATCH /api/profile", () => {
  it("sets the corrections opt-in", async () => {
    seedProfile(world.db, USER_A);
    const { status, body } = await call<{ profile: ProfileRow }>(PATCH(patch("/api/profile", { corrections_opt_in: true })));
    expect(status).toBe(200);
    expect(body.profile.corrections_opt_in).toBe(true);
  });

  it("cannot upgrade the plan through this route", async () => {
    seedProfile(world.db, USER_A, { plan: "free" });
    const { status, body } = await call<{ profile: ProfileRow }>(PATCH(patch("/api/profile", { corrections_opt_in: true, plan: "pro" })));
    expect(status).toBe(200);
    expect(body.profile.plan).toBe("free");
    expect(world.db.find("profiles", USER_A)?.plan).toBe("free");
  });

  it("400s a malformed body", async () => {
    seedProfile(world.db, USER_A);
    expect((await PATCH(patch("/api/profile", {}))).status).toBe(400);
    expect((await PATCH(patch("/api/profile", { corrections_opt_in: "yes" }))).status).toBe(400);
    expect((await PATCH(rawPost("/api/profile", "{"))).status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await PATCH(patch("/api/profile", { corrections_opt_in: true }))).status).toBe(401);
  });
});
