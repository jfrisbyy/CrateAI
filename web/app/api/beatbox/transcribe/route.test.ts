import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, seedBeatboxProfile, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import type { JobResponse } from "@/lib/api/types";
import { POST } from "./route";

let world: World;

const recording = `library/${USER_A}/beatbox/pattern-1.wav`;

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/beatbox/transcribe", () => {
  it("queues beatbox_transcribe against a free tempo", async () => {
    seedBeatboxProfile(world.db, USER_A);
    const { status, body } = await call<JobResponse>(POST(post("/api/beatbox/transcribe", { recording_path: recording, bpm: 92 })));
    expect(status).toBe(201);
    expect(body.job.kind).toBe("beatbox_transcribe");
    expect(body.job.params).toEqual({ recording_path: recording, bpm: 92 });
    expect(world.dispatched).toEqual([body.job.id]);
  });

  it("queues against a file's grid", async () => {
    seedBeatboxProfile(world.db, USER_A);
    const file = seedFile(world.db, USER_A);
    const { body } = await call<JobResponse>(POST(post("/api/beatbox/transcribe", { recording_path: recording, grid_file_id: file.id })));
    expect(body.job.params).toEqual({ recording_path: recording, grid_file_id: file.id });
  });

  it("409s without a profile and with a profile under the accuracy gate", async () => {
    const none = await POST(post("/api/beatbox/transcribe", { recording_path: recording, bpm: 92 }));
    expect(none.status).toBe(409);
    seedBeatboxProfile(world.db, USER_A, { enabled: false, cv_accuracy: 0.5 });
    const weak = await POST(post("/api/beatbox/transcribe", { recording_path: recording, bpm: 92 }));
    expect(weak.status).toBe(409);
  });

  it("does not accept another user's profile or another user's recording", async () => {
    seedBeatboxProfile(world.db, USER_B);
    const noProfile = await POST(post("/api/beatbox/transcribe", { recording_path: recording, bpm: 92 }));
    expect(noProfile.status).toBe(409);

    seedBeatboxProfile(world.db, USER_A);
    const theirRecording = await POST(post("/api/beatbox/transcribe", { recording_path: `library/${USER_B}/beatbox/pattern.wav`, bpm: 92 }));
    expect(theirRecording.status).toBe(400);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("404s another user's grid file and 409s one with no grid yet", async () => {
    seedBeatboxProfile(world.db, USER_A);
    const theirs = seedFile(world.db, USER_B);
    const cross = await POST(post("/api/beatbox/transcribe", { recording_path: recording, grid_file_id: theirs.id }));
    expect(cross.status).toBe(404);

    const unanalyzed = seedFile(world.db, USER_A, { report: null, status: "queued" });
    const notReady = await POST(post("/api/beatbox/transcribe", { recording_path: recording, grid_file_id: unanalyzed.id }));
    expect(notReady.status).toBe(409);
  });

  it("400s without a tempo or a grid, and on a malformed body", async () => {
    seedBeatboxProfile(world.db, USER_A);
    expect((await POST(post("/api/beatbox/transcribe", { recording_path: recording }))).status).toBe(400);
    expect((await POST(rawPost("/api/beatbox/transcribe", "{"))).status).toBe(400);
  });

  it("401s with no session", async () => {
    world.signOut();
    expect((await POST(post("/api/beatbox/transcribe", { recording_path: recording, bpm: 92 }))).status).toBe(401);
  });
});
