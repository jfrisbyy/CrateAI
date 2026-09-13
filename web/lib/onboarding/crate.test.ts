import { describe, expect, it } from "vitest";
import { fakeFile } from "@/lib/chat/fakes";
import { emptyReport } from "@/lib/report/effective";
import type { FileRow, JobRow } from "@/lib/types/db";
import { crateLine, crateLines, summarizeCrate } from "./crate";

function analyzed(id: string, bpm: number, tonic: string, durationS = 120): FileRow {
  return fakeFile(
    { id, duration_s: durationS, status: "ready" },
    {
      tempo: { bpm, confidence: 0.9, method: "tempogram", alternates_bpm: [], notes: null },
      key: { tonic, mode: "minor", confidence: 0.8, method: "krumhansl", alternate: null, notes: null },
    },
  );
}

function analyzeJob(fileId: string, finishedAt: string | null, patch: Partial<JobRow> = {}): JobRow {
  return {
    id: `job-${fileId}`,
    user_id: "u",
    file_id: fileId,
    kind: "analyze",
    status: finishedAt ? "done" : "running",
    params: {},
    result: null,
    error: null,
    modal_call_id: null,
    progress: null,
    created_at: "2026-09-13T00:00:00Z",
    started_at: "2026-09-13T00:00:00Z",
    finished_at: finishedAt,
    ...patch,
  };
}

describe("what the crate is, on the way back in", () => {
  it("counts only analyzed originals as records, and measures the range from their reports", () => {
    const files = [
      analyzed("a", 92, "F", 180),
      analyzed("b", 71.5, "C", 240),
      fakeFile({ id: "c", status: "analyzing" }, null),
      fakeFile({ id: "d", status: "failed" }, null),
      fakeFile({ id: "e", kind: "stem", parent_file_id: "a" }, null),
    ];
    const summary = summarizeCrate(files, []);
    expect(summary.records).toBe(2);
    expect(summary.working).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.derived).toBe(1);
    expect(summary.totalDurationS).toBe(420);
    expect(summary.tempoRange).toEqual({ lo: 71.5, hi: 92 });
    expect(summary.keys).toBe(2);
    expect(crateLine(summary)).toBe("2 records, 7:00, 71.5–92.0 BPM, 2 keys, 1 derived");
  });

  it("says nothing about a crate with nothing analyzed in it", () => {
    expect(crateLine(summarizeCrate([fakeFile({ id: "a", status: "queued" }, null)], []))).toBeNull();
  });

  it("reports what finished while they were away from the analyze jobs, not from updated_at", () => {
    const files = [analyzed("a", 92, "F"), analyzed("b", 88, "G")];
    const jobs = [analyzeJob("a", "2026-09-13T08:00:00Z"), analyzeJob("b", "2026-09-13T11:00:00Z")];
    const summary = summarizeCrate(files, jobs, { since: "2026-09-13T10:00:00Z" });
    expect(summary.newSince.map((f) => f.id)).toEqual(["b"]);
    expect(crateLines(summary)[0]).toBe("1 record finished analyzing while you were away.");
  });

  it("does not count an edit or a partial re-run as new work", () => {
    const files = [analyzed("a", 92, "F")];
    const jobs = [
      analyzeJob("a", "2026-09-13T08:00:00Z"),
      analyzeJob("a", "2026-09-13T11:00:00Z", { id: "loops", params: { task: "find_loops" } }),
    ];
    expect(summarizeCrate(files, jobs, { since: "2026-09-13T10:00:00Z" }).newSince).toEqual([]);
  });

  it("has nothing to say when the crate is quiet", () => {
    const summary = summarizeCrate([analyzed("a", 92, "F")], [analyzeJob("a", "2026-09-13T08:00:00Z")], {
      since: "2026-09-13T10:00:00Z",
    });
    expect(crateLines(summary)).toEqual([]);
  });

  it("puts the queue and the failures in the producer's words", () => {
    const files = [
      analyzed("a", 92, "F"),
      fakeFile({ id: "b", status: "queued" }, null),
      fakeFile({ id: "c", status: "failed" }, null),
      fakeFile({ id: "d", status: "failed" }, null),
    ];
    expect(crateLines(summarizeCrate(files, []))).toEqual([
      "1 is still in the queue.",
      "2 did not analyze; open them to see why, or retry them in the library.",
    ]);
  });

  it("uses a corrected tempo, because a correction is ground truth", () => {
    const corrected = fakeFile(
      { id: "a" },
      {
        ...emptyReport({
          tempo: { bpm: 92, confidence: 0.9, method: "tempogram", alternates_bpm: [46, 184], notes: null },
        }),
        user_edits: {
          tempo_bpm: 46,
          downbeat_phase: null,
          first_downbeat_s: null,
          key: null,
          meter: null,
          section_labels: null,
          edited_at: "2026-09-13T10:00:00Z",
        },
      },
    );
    expect(summarizeCrate([corrected], []).tempoRange).toEqual({ lo: 46, hi: 46 });
  });
});
