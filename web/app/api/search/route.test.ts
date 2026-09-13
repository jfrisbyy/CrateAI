import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { SearchResponse } from "@/lib/api/types";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

// lib/search/server.ts memoizes per (user, query, window) for 30 s, so each
// test asks something different.
describe("POST /api/search", () => {
  it("falls back to filters and a name match, and says why", async () => {
    seedFile(world.db, USER_A, { original_filename: "dusty soul loop.wav" });
    seedFile(world.db, USER_A, { original_filename: "hard techno.wav" });
    const { status, body } = await call<SearchResponse>(POST(post("/api/search", { query: "dusty soul" })));
    expect(status).toBe(200);
    expect(body.mode).toBe("filters");
    expect(body.note).toContain("text search needs the embed job");
    expect(body.files.map((f) => f.original_filename)).toEqual(["dusty soul loop.wav"]);
    expect(body.results).toHaveLength(1);
  });

  it("parses BPM and key out of the query", async () => {
    seedFile(world.db, USER_A, { original_filename: "at ninety two.wav" });
    const { body } = await call<SearchResponse>(POST(post("/api/search", { query: "90-95 bpm in F minor" })));
    expect(body.parsed.bpm_min).toBe(90);
    expect(body.parsed.bpm_max).toBe(95);
    expect(body.parsed.tonic).toBe("F");
    expect(body.parsed.mode).toBe("minor");
    expect(body.files.map((f) => f.original_filename)).toEqual(["at ninety two.wav"]);
  });

  it("never returns another user's files", async () => {
    seedFile(world.db, USER_B, { original_filename: "their secret demo.wav" });
    const { body } = await call<SearchResponse>(POST(post("/api/search", { query: "secret demo" })));
    expect(body.files).toEqual([]);
    expect(body.results).toEqual([]);
  });

  it("400s a malformed body and an out-of-range limit", async () => {
    expect((await POST(rawPost("/api/search", "{"))).status).toBe(400);
    expect((await POST(post("/api/search", { query: "x", limit: 9999 }))).status).toBe(400);
    expect((await POST(post("/api/search", { query: "x", kind: "banana" }))).status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await POST(post("/api/search", { query: "anything at all" }))).status).toBe(401);
  });
});
