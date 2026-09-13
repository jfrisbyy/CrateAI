import { beforeEach, describe, expect, it } from "vitest";
import { createWorld, ndjson, params, post, rawPost, seedBreakdown, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import { NARRATION_CONTENT_TYPE } from "@/lib/narration/stream";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

type Event = { type: string; text?: string; source?: string; saved?: boolean; version?: number };

describe("POST /api/breakdowns/[fileId]/narrate", () => {
  it("streams the measured document when no model is configured, and saves nothing", async () => {
    const file = seedFile(world.db, USER_A);
    const breakdown = seedBreakdown(world.db, USER_A, file.id);
    const res = await POST(post(`/api/breakdowns/${file.id}/narrate`, {}), params({ fileId: file.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(NARRATION_CONTENT_TYPE);
    expect(res.headers.get("x-breakdown-id")).toBe(breakdown.id);

    const events = await ndjson<Event>(res);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    expect(done?.source).toBe("deterministic");
    expect(done?.saved).toBe(false);
    expect(events.some((e) => e.type === "note" && (e.text ?? "").includes("ANTHROPIC_API_KEY"))).toBe(true);
    expect(events.some((e) => e.type === "paragraph")).toBe(true);
    expect(world.db.find("breakdowns", breakdown.id)?.narration).toBeNull();
  });

  it("404s when there is no breakdown yet, and for another user's", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await POST(post(`/api/breakdowns/${file.id}/narrate`, {}), params({ fileId: file.id }))).status).toBe(404);

    const theirs = seedFile(world.db, USER_B);
    seedBreakdown(world.db, USER_B, theirs.id);
    expect((await POST(post(`/api/breakdowns/${theirs.id}/narrate`, {}), params({ fileId: theirs.id }))).status).toBe(404);
  });

  it("404s a version that does not exist", async () => {
    const file = seedFile(world.db, USER_A);
    seedBreakdown(world.db, USER_A, file.id, { version: 1 });
    const res = await POST(post(`/api/breakdowns/${file.id}/narrate`, { version: 7 }), params({ fileId: file.id }));
    expect(res.status).toBe(404);
  });

  it("400s a malformed body and a bad version", async () => {
    const file = seedFile(world.db, USER_A);
    seedBreakdown(world.db, USER_A, file.id);
    expect((await POST(rawPost(`/api/breakdowns/${file.id}/narrate`, "{"), params({ fileId: file.id }))).status).toBe(400);
    expect((await POST(post(`/api/breakdowns/${file.id}/narrate`, { version: -2 }), params({ fileId: file.id }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    seedBreakdown(world.db, USER_A, file.id);
    world.signOut();
    expect((await POST(post(`/api/breakdowns/${file.id}/narrate`, {}), params({ fileId: file.id }))).status).toBe(401);
  });
});
