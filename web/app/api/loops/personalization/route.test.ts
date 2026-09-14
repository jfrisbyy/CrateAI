import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, patch, rawPost, seedProfile, USER_A, USER_B, type World } from "@/lib/testing";
import type { LoopPersonalizationResponse } from "@/lib/api/types";
import { GET, PATCH } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/loops/personalization", () => {
  it("is on for an account that has not said otherwise", async () => {
    seedProfile(world.db, USER_A);
    const { status, body } = await call<LoopPersonalizationResponse>(GET());
    expect(status).toBe(200);
    expect(body).toEqual({ enabled: true, available: true });
  });

  it("reads the caller's switch and nobody else's", async () => {
    seedProfile(world.db, USER_A, { loop_personalization: false });
    seedProfile(world.db, USER_B, { loop_personalization: true });
    expect((await call<LoopPersonalizationResponse>(GET())).body.enabled).toBe(false);
  });

  it("says on, and says the column is not there, when the migration has not been applied", async () => {
    seedProfile(world.db, USER_A);
    const row = world.db.find("profiles", USER_A);
    if (row) delete row.loop_personalization;
    expect((await call<LoopPersonalizationResponse>(GET())).body).toEqual({ enabled: true, available: false });
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await GET()).status).toBe(401);
  });
});

describe("PATCH /api/loops/personalization", () => {
  it("turns it off and back on for the caller", async () => {
    seedProfile(world.db, USER_A);
    const off = await call<LoopPersonalizationResponse>(PATCH(patch("/api/loops/personalization", { enabled: false })));
    expect(off.status).toBe(200);
    expect(off.body).toEqual({ enabled: false, available: true });
    expect(world.db.find("profiles", USER_A)?.loop_personalization).toBe(false);

    const on = await call<LoopPersonalizationResponse>(PATCH(patch("/api/loops/personalization", { enabled: true })));
    expect(on.body.enabled).toBe(true);
  });

  it("never touches another account's switch", async () => {
    seedProfile(world.db, USER_A);
    seedProfile(world.db, USER_B, { loop_personalization: true });
    await PATCH(patch("/api/loops/personalization", { enabled: false }));
    expect(world.db.find("profiles", USER_B)?.loop_personalization).toBe(true);
  });

  it("400s a malformed body and 404s an account with no profile row", async () => {
    seedProfile(world.db, USER_A);
    expect((await PATCH(patch("/api/loops/personalization", {}))).status).toBe(400);
    expect((await PATCH(patch("/api/loops/personalization", { enabled: "no" }))).status).toBe(400);
    expect((await PATCH(rawPost("/api/loops/personalization", "{"))).status).toBe(400);

    world.db.rows("profiles").length = 0;
    expect((await PATCH(patch("/api/loops/personalization", { enabled: false }))).status).toBe(404);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await PATCH(patch("/api/loops/personalization", { enabled: false }))).status).toBe(401);
  });
});
