import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, USER_A, USER_B, type World } from "@/lib/testing";
import type { UploadUrlResponse } from "@/lib/api/beatbox";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/beatbox/upload-url", () => {
  it("signs an upload under the caller's own beatbox prefix", async () => {
    const { status, body } = await call<UploadUrlResponse>(POST(post("/api/beatbox/upload-url", { name: "Kick 01.wav" })));
    expect(status).toBe(201);
    expect(body.storage_path).toBe(`library/${USER_A}/beatbox/kick-01.wav`);
    expect(body.signed_url).toContain(body.storage_path);
    expect(body.token).toBeTruthy();
  });

  it("ignores any path the caller puts in the name", async () => {
    const { body } = await call<UploadUrlResponse>(POST(post("/api/beatbox/upload-url", { name: "../../22222222-2222-4222-8222-222222222222/steal.wav" })));
    expect(body.storage_path.startsWith(`library/${USER_A}/beatbox/`)).toBe(true);
    expect(body.storage_path).not.toContain("..");
  });

  it("puts each caller's recording under their own prefix", async () => {
    world.signIn(USER_B);
    const { body } = await call<UploadUrlResponse>(POST(post("/api/beatbox/upload-url", { name: "kick.wav" })));
    expect(body.storage_path).toBe(`library/${USER_B}/beatbox/kick.wav`);
    expect(body.storage_path).not.toContain(USER_A);
  });

  it("works without a service-role key (the user's own storage policy allows it)", async () => {
    world.setServiceRole(false);
    const { status, body } = await call<UploadUrlResponse>(POST(post("/api/beatbox/upload-url", { name: "snare.webm" })));
    expect(status).toBe(201);
    expect(body.storage_path).toBe(`library/${USER_A}/beatbox/snare.webm`);
  });

  it("400s a name that is not a .wav or .webm, and a malformed body", async () => {
    expect((await POST(post("/api/beatbox/upload-url", { name: "kick.mp3" }))).status).toBe(400);
    expect((await POST(post("/api/beatbox/upload-url", { name: "" }))).status).toBe(400);
    expect((await POST(rawPost("/api/beatbox/upload-url", "{"))).status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await POST(post("/api/beatbox/upload-url", { name: "kick.wav" }))).status).toBe(401);
  });
});
