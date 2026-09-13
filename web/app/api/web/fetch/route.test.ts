import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, textResponse, type World } from "@/lib/testing";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
  // robots.txt, then the page itself.
  world.onFetch((url) => {
    if (url.endsWith("/robots.txt")) return textResponse("User-agent: *\nAllow: /", 200, { "content-type": "text/plain" });
    if (url.startsWith("https://example.com/")) {
      return textResponse("<html><head><title>How it was made</title></head><body><p>Interview text.</p></body></html>");
    }
    return null;
  });
});

describe("POST /api/web/fetch", () => {
  it("reads a page and returns its text", async () => {
    const { status, body } = await call<{ page: { title: string; text: string } }>(POST(post("/api/web/fetch", { url: "https://example.com/interview" })));
    expect(status).toBe(200);
    expect(body.page.title).toBe("How it was made");
    expect(body.page.text).toContain("Interview text.");
  });

  it("422s a media host before making any request (principle 3)", async () => {
    const before = world.fetchCalls.length;
    const { status, body } = await call<{ error: string; stage: string }>(POST(post("/api/web/fetch", { url: "https://www.youtube.com/watch?v=abc" })));
    expect(status).toBe(422);
    expect(body.stage).toBe("url");
    expect(world.fetchCalls).toHaveLength(before);
  });

  it("422s a media file, a download path and a private address", async () => {
    const media = await call<{ stage: string }>(POST(post("/api/web/fetch", { url: "https://example.com/track.mp3" })));
    expect(media.status).toBe(422);
    const download = await call<{ stage: string }>(POST(post("/api/web/fetch", { url: "https://example.com/download/track" })));
    expect(download.status).toBe(422);
    const priv = await call<{ stage: string }>(POST(post("/api/web/fetch", { url: "http://192.168.0.10/page" })));
    expect(priv.status).toBe(422);
  });

  it("400s a malformed body", async () => {
    expect((await POST(rawPost("/api/web/fetch", "{"))).status).toBe(400);
    expect((await POST(post("/api/web/fetch", { url: "" }))).status).toBe(400);
  });

  it("401s with no session, before the URL is even looked at", async () => {
    world.signOut();
    const before = world.fetchCalls.length;
    expect((await POST(post("/api/web/fetch", { url: "https://example.com/x" }))).status).toBe(401);
    expect(world.fetchCalls).toHaveLength(before);
  });
});
