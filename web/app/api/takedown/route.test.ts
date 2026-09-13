import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, seedFile, USER_B, type World } from "@/lib/testing";
import { GET, POST } from "./route";

let world: World;

const notice = (over: Record<string, unknown> = {}) => ({
  claimant_name: "Rights Holder",
  claimant_email: "legal@example.com",
  work_description: "The recording released in 1972 on the A side.",
  infringing_description: "The upload reproduces the whole recording.",
  good_faith: true,
  accuracy_sworn: true,
  signature: "R. Holder",
  ...over,
});

const fromIp = (ip: string) => ({ headers: { "x-forwarded-for": ip } });

beforeEach(() => {
  world = createWorld({ user: null });
});

describe("POST /api/takedown", () => {
  it("records a notice from the public, with no session", async () => {
    const { status, body } = await call<{ received: boolean; id: string }>(POST(post("/api/takedown", notice(), fromIp("203.0.113.7"))));
    expect(status).toBe(201);
    expect(body.received).toBe(true);
    const row = world.db.rows("takedowns")[0];
    expect(row).toMatchObject({ claimant_email: "legal@example.com", status: "received", source_ip: "203.0.113.7" });
  });

  it("attaches the named file's owner", async () => {
    const theirs = seedFile(world.db, USER_B);
    await POST(post("/api/takedown", notice({ file_id: theirs.id }), fromIp("203.0.113.8")));
    expect(world.db.rows("takedowns")[0]).toMatchObject({ file_id: theirs.id, user_id: USER_B });
  });

  it("drops a bot that fills the honeypot", async () => {
    const { status } = await call(POST(post("/api/takedown", notice({ website: "https://spam.example" }), fromIp("203.0.113.9"))));
    expect(status).toBe(400);
    expect(world.db.rows("takedowns")).toHaveLength(0);
  });

  it("rate limits a burst from one address but not from another", async () => {
    for (let i = 0; i < 3; i++) {
      expect((await POST(post("/api/takedown", notice(), fromIp("198.51.100.1")))).status).toBe(201);
    }
    const fourth = await call<{ error: string }>(POST(post("/api/takedown", notice(), fromIp("198.51.100.1"))));
    expect(fourth.status).toBe(429);
    expect(fourth.body.error).toContain("Too many notices");
    expect((await POST(post("/api/takedown", notice(), fromIp("198.51.100.2")))).status).toBe(201);
    expect(world.db.rows("takedowns")).toHaveLength(4);
  });

  it("400s a notice without the sworn statements, with a short description, or malformed", async () => {
    expect((await POST(post("/api/takedown", notice({ good_faith: false }), fromIp("203.0.113.10")))).status).toBe(400);
    expect((await POST(post("/api/takedown", notice({ work_description: "mine" }), fromIp("203.0.113.11")))).status).toBe(400);
    expect((await POST(post("/api/takedown", notice({ claimant_email: "not-an-email" }), fromIp("203.0.113.12")))).status).toBe(400);
    expect((await POST(rawPost("/api/takedown", "{", fromIp("203.0.113.13")))).status).toBe(400);
    expect(world.db.rows("takedowns")).toHaveLength(0);
  });
});

describe("GET /api/takedown", () => {
  it("405s and points at the notice page", async () => {
    const res = GET();
    expect(res.status).toBe(405);
  });
});
