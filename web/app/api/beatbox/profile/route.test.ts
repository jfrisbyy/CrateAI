import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, seedBeatboxProfile, USER_A, USER_B, type World } from "@/lib/testing";
import type { ProfileResponse } from "@/lib/api/beatbox";
import { GET } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("GET /api/beatbox/profile", () => {
  it("returns the caller's profile", async () => {
    seedBeatboxProfile(world.db, USER_A, { classes: ["kick", "snare", "hat"], cv_accuracy: 0.9 });
    const { status, body } = await call<ProfileResponse>(GET());
    expect(status).toBe(200);
    expect(body.profile?.classes).toEqual(["kick", "snare", "hat"]);
  });

  it("returns null when there is none, and never another user's", async () => {
    seedBeatboxProfile(world.db, USER_B);
    const { status, body } = await call<ProfileResponse>(GET());
    expect(status).toBe(200);
    expect(body.profile).toBeNull();
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await GET()).status).toBe(401);
  });
});
