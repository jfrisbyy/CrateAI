import { beforeEach, describe, expect, it } from "vitest";
import { call, createWorld, get, params, seedJob, USER_A, USER_B, type World } from "@/lib/testing";
import type { ExportJobResult } from "@/lib/export/types";
import { GET } from "./route";

let world: World;

beforeEach(() => {
  world = createWorld();
});

function finishedResult(userId: string, jobId: string, over: Partial<ExportJobResult> = {}): ExportJobResult {
  return {
    storage_path: `derived/${userId}/bundles/${jobId}.zip`,
    filename: "Midnight-Flip_92bpm_Fm_stems.zip",
    folder: "Midnight-Flip_92bpm_Fm",
    size_bytes: 9,
    size_human: "9 B",
    estimated_bytes: 9,
    cap_bytes: 1024 ** 3,
    format: "flac",
    bit_depth: 24,
    sample_rate: 44100,
    channels: 2,
    length_s: 8,
    length_samples: 352800,
    bpm: 92,
    beats_per_bar: 4,
    key: { tonic: "F", mode: "minor" },
    tempo_map: true,
    stems: [],
    not_exported: [],
    midi: [],
    notes: [],
    ...over,
  };
}

function seedFinishedExport(userId: string, over: Partial<ExportJobResult> = {}) {
  const jobId = "55555555-5555-4555-8555-555555555555";
  const result = finishedResult(userId, jobId, over);
  const job = seedJob(world.db, userId, {
    id: jobId,
    kind: "export",
    status: "done",
    result: result as unknown as Record<string, never>,
  });
  world.db.putObject(result.storage_path, "zip-bytes", "application/zip");
  return { job, result };
}

describe("GET /api/export/[id]/download", () => {
  it("streams the zip to the user who made it", async () => {
    const { job } = seedFinishedExport(USER_A);
    const res = await GET(get(`/api/export/${job.id}/download`), params({ id: job.id }));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="Midnight-Flip_92bpm_Fm_stems.zip"');
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe("zip-bytes");
  });

  it("404s another user's export", async () => {
    const { job } = seedFinishedExport(USER_B);
    const { status } = await call(GET(get(`/api/export/${job.id}/download`), params({ id: job.id })));
    expect(status).toBe(404);
  });

  it("never serves bytes from another user's storage prefix", async () => {
    // The job row is the caller's; its result points at user B's bucket
    // prefix. Only the storage policy stops this, which is why the fetch is
    // made with the caller's client and not the service role.
    world.db.putObject(`derived/${USER_B}/bundles/secret.zip`, "user-b-audio", "application/zip");
    const { job } = seedFinishedExport(USER_A, { storage_path: `derived/${USER_B}/bundles/secret.zip` });
    const res = await GET(get(`/api/export/${job.id}/download`), params({ id: job.id }));
    expect(res.status).not.toBe(200);
    expect(await res.text()).not.toContain("user-b-audio");
  });

  it("409s while the render is still running", async () => {
    const job = seedJob(world.db, USER_A, { id: "66666666-6666-4666-8666-666666666666", kind: "export", status: "running" });
    const { status, body } = await call<{ error: string }>(GET(get(`/api/export/${job.id}/download`), params({ id: job.id })));
    expect(status).toBe(409);
    expect(body.error).toContain("still rendering");
  });

  it("409s a failed export with the reason compute gave", async () => {
    const job = seedJob(world.db, USER_A, {
      id: "77777777-7777-4777-8777-777777777777",
      kind: "export",
      status: "failed",
      error: "this export would be about 5.70 GB; the cap is 1.00 GB.",
    });
    const { status, body } = await call<{ error: string }>(GET(get(`/api/export/${job.id}/download`), params({ id: job.id })));
    expect(status).toBe(409);
    expect(body.error).toContain("5.70 GB");
  });

  it("404s a job of another kind", async () => {
    const job = seedJob(world.db, USER_A, { id: "88888888-8888-4888-8888-888888888888", kind: "analyze", status: "done" });
    const { status } = await call(GET(get(`/api/export/${job.id}/download`), params({ id: job.id })));
    expect(status).toBe(404);
  });

  it("400s a malformed id and 401s with no session", async () => {
    expect((await call(GET(get("/api/export/x/download"), params({ id: "x" })))).status).toBe(400);
    const { job } = seedFinishedExport(USER_A);
    world.signOut();
    expect((await GET(get(`/api/export/${job.id}/download`), params({ id: job.id }))).status).toBe(401);
  });
});
