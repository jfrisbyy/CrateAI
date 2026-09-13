import { describe, expect, it } from "vitest";
import { fakeFile } from "@/lib/chat/fakes";
import type { FileRow, JobRow } from "@/lib/types/db";
import { EMPTY_MEMORY, type OnboardingMemory } from "./memory";
import { analyzeJobFor, firstRunStep, firstRunSubject, wayBackIn, type UploadLike } from "./state";
import { summarizeCrate } from "./crate";

const NOW = new Date("2026-09-13T12:00:00Z");

function upload(patch: Partial<UploadLike> = {}): UploadLike {
  return {
    id: "u1",
    name: "moonlight.wav",
    size: 41_200_000,
    state: "uploading",
    progress: 0.42,
    error: null,
    dispatchNote: null,
    fileRow: null,
    ...patch,
  };
}

function job(patch: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    user_id: "u",
    file_id: "file-1",
    kind: "analyze",
    status: "running",
    params: {},
    result: null,
    error: null,
    modal_call_id: null,
    progress: 0.4,
    created_at: "2026-09-13T11:59:00Z",
    started_at: "2026-09-13T11:59:10Z",
    finished_at: null,
    ...patch,
  };
}

const step = (input: {
  files?: FileRow[];
  jobs?: JobRow[];
  uploads?: UploadLike[];
  memory?: OnboardingMemory;
  now?: Date;
}) =>
  firstRunStep({
    files: input.files ?? [],
    jobs: input.jobs ?? [],
    uploads: input.uploads ?? [],
    memory: input.memory ?? EMPTY_MEMORY,
    now: input.now ?? NOW,
  });

describe("the first run, step by step", () => {
  it("opens on the empty crate", () => {
    expect(step({})).toEqual({ kind: "empty" });
  });

  it("stays on the empty crate however long the account has existed, because it is still a dead end", () => {
    const veteran: OnboardingMemory = { ...EMPTY_MEMORY, dismissedAt: "2026-09-01T00:00:00Z", lastSeenAt: "2026-09-01T00:00:00Z" };
    expect(step({ memory: veteran }).kind).toBe("empty");
  });

  it("follows the upload while the bytes are still moving", () => {
    const s = step({ uploads: [upload({ state: "hashing", progress: 0.3 })] });
    expect(s.kind).toBe("uploading");
    if (s.kind === "uploading") {
      expect(s.upload.state).toBe("hashing");
      expect(s.others).toBe(0);
    }
  });

  it("shows the failed upload rather than the one behind it", () => {
    const s = step({ uploads: [upload({ id: "a" }), upload({ id: "b", state: "failed", error: "network" })] });
    expect(s.kind).toBe("uploading");
    if (s.kind === "uploading") {
      expect(s.upload.id).toBe("b");
      expect(s.others).toBe(1);
    }
  });

  it("hands over to the queue, then to the ladder, as compute picks the file up", () => {
    const queued = fakeFile({ id: "file-1", status: "queued" }, null);
    expect(step({ files: [queued], jobs: [job({ status: "queued", progress: null })] }).kind).toBe("queued");

    const analyzing = fakeFile({ id: "file-1", status: "analyzing" }, null);
    const s = step({ files: [analyzing], jobs: [job()] });
    expect(s.kind).toBe("analyzing");
    if (s.kind === "analyzing") expect(s.job?.progress).toBe(0.4);
  });

  it("prefers the row compute has taken over an upload still moving", () => {
    const analyzing = fakeFile({ id: "file-1", status: "analyzing" }, null);
    expect(step({ files: [analyzing], jobs: [job()], uploads: [upload({ id: "second" })] }).kind).toBe("analyzing");
  });

  it("says what failed instead of pretending the wait continues", () => {
    const failed = fakeFile({ id: "file-1", status: "failed" }, null);
    const s = step({ files: [failed], jobs: [job({ status: "failed", error: "the file decoded to no audio" })] });
    expect(s.kind).toBe("failed");
    if (s.kind === "failed") expect(s.job?.error).toContain("no audio");
  });

  it("lands on the measurements when the first record comes back", () => {
    const ready = fakeFile({ id: "file-1" });
    const s = step({ files: [ready] });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") expect(s.file.id).toBe("file-1");
  });

  it("teaches on the record it taught on, even once newer ones land", () => {
    const memory = { ...EMPTY_MEMORY, firstReadyFileId: "file-1", firstReadyAt: "2026-09-13T11:00:00Z", lastSeenAt: "2026-09-13T11:50:00Z" };
    const files = [fakeFile({ id: "file-1", created_at: "2026-09-13T11:00:00Z" }), fakeFile({ id: "file-2", created_at: "2026-09-13T11:30:00Z" })];
    const s = step({ files, memory });
    expect(s.kind).toBe("ready");
    if (s.kind === "ready") expect(s.file.id).toBe("file-1");
  });

  it("steps aside the moment the producer puts it away", () => {
    const files = [fakeFile({ id: "file-1" })];
    const dismissed = { ...EMPTY_MEMORY, dismissedAt: "2026-09-13T11:59:00Z", lastSeenAt: "2026-09-13T11:59:00Z" };
    expect(step({ files, memory: dismissed }).kind).toBe("silent");
  });

  it("teaches for one session, then reports instead", () => {
    const files = [fakeFile({ id: "file-1" })];
    const sameSession = { ...EMPTY_MEMORY, firstReadyFileId: "file-1", firstReadyAt: "2026-09-13T11:40:00Z", lastSeenAt: "2026-09-13T11:55:00Z" };
    expect(step({ files, memory: sameSession }).kind).toBe("ready");

    const nextSession = { ...sameSession, lastSeenAt: "2026-09-12T20:00:00Z" };
    const s = step({ files, memory: nextSession });
    expect(s.kind).toBe("returning");
    if (s.kind === "returning") expect(s.newSession).toBe(true);
  });

  it("is silent mid-session when the crate has nothing new to report", () => {
    const files = [fakeFile({ id: "file-1" }), fakeFile({ id: "file-2" })];
    const memory = { ...EMPTY_MEMORY, dismissedAt: "2026-09-13T11:00:00Z", lastSeenAt: "2026-09-13T11:58:00Z" };
    expect(step({ files, memory }).kind).toBe("silent");
  });

  it("speaks up mid-session when something broke", () => {
    const files = [fakeFile({ id: "file-1" }), fakeFile({ id: "file-2", status: "failed" }, null)];
    const memory = { ...EMPTY_MEMORY, dismissedAt: "2026-09-13T11:00:00Z", lastSeenAt: "2026-09-13T11:58:00Z" };
    const s = step({ files, memory });
    expect(s.kind).toBe("returning");
    if (s.kind === "returning") expect(s.summary.failed).toBe(1);
  });
});

describe("choosing what the first run is about", () => {
  it("takes the first analyzed original, not a stem or a later upload", () => {
    const files = [
      fakeFile({ id: "stem-1", kind: "stem", created_at: "2026-09-13T10:00:00Z" }),
      fakeFile({ id: "first", created_at: "2026-09-13T10:30:00Z" }),
      fakeFile({ id: "second", created_at: "2026-09-13T11:00:00Z" }),
    ];
    expect(firstRunSubject(files, EMPTY_MEMORY)?.id).toBe("first");
  });

  it("falls back to whichever is furthest along when none is ready", () => {
    const files = [
      fakeFile({ id: "queued", status: "queued", created_at: "2026-09-13T10:00:00Z" }, null),
      fakeFile({ id: "analyzing", status: "analyzing", created_at: "2026-09-13T11:00:00Z" }, null),
    ];
    expect(firstRunSubject(files, EMPTY_MEMORY)?.id).toBe("analyzing");
  });

  it("finds the job the file is waiting on, and prefers the one running", () => {
    const jobs = [job({ id: "old", status: "done" }), job({ id: "now", status: "running" })];
    expect(analyzeJobFor(jobs, "file-1")?.id).toBe("now");
    expect(analyzeJobFor(jobs, "other")).toBeNull();
    expect(analyzeJobFor([job({ id: "finder", params: { task: "find_loops" } })], "file-1")).toBeNull();
  });
});

describe("the way back in", () => {
  it("offers what landed while they were away first", () => {
    const files = [fakeFile({ id: "a" }), fakeFile({ id: "b" })];
    const jobs = [{ ...job({ id: "j" , status: "done", finished_at: "2026-09-13T11:00:00Z" }), file_id: "b" }];
    const summary = summarizeCrate(files, jobs, { since: "2026-09-13T10:00:00Z" });
    expect(wayBackIn(files, summary, EMPTY_MEMORY)?.id).toBe("b");
  });

  it("otherwise offers the record they had open when they left", () => {
    const files = [fakeFile({ id: "a" }), fakeFile({ id: "b" })];
    const summary = summarizeCrate(files, []);
    expect(wayBackIn(files, summary, { ...EMPTY_MEMORY, lastFileId: "b" })?.id).toBe("b");
    expect(wayBackIn(files, summary, { ...EMPTY_MEMORY, lastFileId: "gone" })).toBeNull();
    expect(wayBackIn(files, summary, EMPTY_MEMORY)).toBeNull();
  });
});
