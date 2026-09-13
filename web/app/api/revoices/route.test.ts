import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, post, rawPost, seedFile, USER_A, USER_B, type World } from "@/lib/testing";
import { NEURAL_REASON } from "@/lib/api/revoice";
import type { JobResponse } from "@/lib/api/types";
import { POST } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

describe("POST /api/revoices", () => {
  it("queues a symbolic re-voice", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<JobResponse>(
      POST(post("/api/revoices", { file_id: file.id, instrument: "acoustic_guitar", path: "symbolic", keep_groove: true })),
    );
    expect(status).toBe(201);
    expect(body.job.kind).toBe("revoice");
    expect(body.job.params).toEqual({ instrument: "acoustic_guitar", path: "symbolic", keep_groove: true });
    expect(world.dispatched).toEqual([body.job.id]);
  });

  it("passes edited notes through so compute renders without re-transcribing", async () => {
    const file = seedFile(world.db, USER_A);
    const notes = [{ pitch: 60, start_s: 0, end_s: 0.5 }];
    const { body } = await call<JobResponse>(
      POST(post("/api/revoices", { file_id: file.id, instrument: "acoustic_guitar", path: "symbolic", notes })),
    );
    expect(body.job.params).toMatchObject({ notes: [{ pitch: 60, start_s: 0, end_s: 0.5, velocity: 100 }] });
  });

  it("400s the neural path with the compute's own reason", async () => {
    const file = seedFile(world.db, USER_A);
    const { status, body } = await call<{ error: string }>(
      POST(post("/api/revoices", { file_id: file.id, instrument: "acoustic_guitar", path: "neural" })),
    );
    expect(status).toBe(400);
    expect(body.error).toBe(NEURAL_REASON);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("409s a file that is not ready", async () => {
    const file = seedFile(world.db, USER_A, { status: "queued" });
    const res = await POST(post("/api/revoices", { file_id: file.id, instrument: "acoustic_guitar", path: "symbolic" }));
    expect(res.status).toBe(409);
  });

  it("404s another user's file and queues nothing", async () => {
    const theirs = seedFile(world.db, USER_B);
    const res = await POST(post("/api/revoices", { file_id: theirs.id, instrument: "acoustic_guitar", path: "symbolic" }));
    expect(res.status).toBe(404);
    expect(world.db.rows("jobs")).toHaveLength(0);
  });

  it("400s an unknown instrument and a malformed body", async () => {
    const file = seedFile(world.db, USER_A);
    expect((await POST(post("/api/revoices", { file_id: file.id, instrument: "kazoo", path: "symbolic" }))).status).toBe(400);
    expect((await POST(rawPost("/api/revoices", "{"))).status).toBe(400);
  });

  it("401s with no session", async () => {
    const file = seedFile(world.db, USER_A);
    world.signOut();
    expect((await POST(post("/api/revoices", { file_id: file.id, instrument: "acoustic_guitar", path: "symbolic" }))).status).toBe(401);
  });
});
