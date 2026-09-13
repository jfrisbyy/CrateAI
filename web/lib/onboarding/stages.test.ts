import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { JobRow } from "@/lib/types/db";
import {
  ANALYSIS_LADDER,
  elapsedSeconds,
  fmtElapsed,
  isFullAnalyze,
  LADDER_STAGE_IDS,
  pastAnalysisRuns,
  positionAt,
} from "./stages";

function job(patch: Partial<JobRow> = {}): JobRow {
  return {
    id: "job-1",
    user_id: "u",
    file_id: "file-1",
    kind: "analyze",
    status: "done",
    params: {},
    result: null,
    error: null,
    modal_call_id: null,
    progress: null,
    created_at: "2026-09-13T00:00:00Z",
    started_at: "2026-09-13T00:00:00Z",
    finished_at: "2026-09-13T00:00:40Z",
    ...patch,
  };
}

const PIPELINE = fileURLToPath(new URL("../../../analysis/lockedgroove/pipeline.py", import.meta.url));

describe("the analysis ladder", () => {
  it("matches DEFAULT_STAGES in the pipeline it is reading progress from", () => {
    if (!existsSync(PIPELINE)) {
      // The web package can be checked out alone; nothing to compare against.
      expect(LADDER_STAGE_IDS.length).toBeGreaterThan(0);
      return;
    }
    const source = readFileSync(PIPELINE, "utf8");
    const block = /DEFAULT_STAGES: list\[str\] = \[([\s\S]*?)\]/.exec(source);
    expect(block).not.toBeNull();
    const stages = [...(block?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
    expect(stages.length).toBeGreaterThan(0);
    expect(LADDER_STAGE_IDS).toEqual(stages);
  });

  it("puts each stage at the fraction analyze.py writes for it", () => {
    // analyze.py: on_progress(stage, f) -> ctx.progress(0.1 + 0.8 * f),
    // pipeline.py: f = i / len(ordered), reported before the stage runs.
    const n = LADDER_STAGE_IDS.length;
    LADDER_STAGE_IDS.forEach((id, i) => {
      const stage = ANALYSIS_LADDER.find((s) => s.id === id);
      expect(stage, id).toBeDefined();
      expect(stage?.at).toBeCloseTo(0.1 + 0.8 * (i / n), 6);
    });
    expect(ANALYSIS_LADDER[0]?.at).toBe(0.02); // download
    expect(ANALYSIS_LADDER[1]?.at).toBe(0.05); // decode
  });

  it("reads the running step out of the progress fraction", () => {
    expect(positionAt(null).running).toBeNull();
    expect(positionAt(0).running).toBeNull();
    expect(positionAt(0.02).running?.id).toBe("download");
    expect(positionAt(0.06).running?.id).toBe("decode");
    expect(positionAt(0.1).running?.id).toBe("tempo");
    expect(positionAt(0.45).running?.id).toBe("key");
    expect(positionAt(0.8).running?.id).toBe("structure");
    // 0.95 is analyze.py's write step; the ladder's last entry covers it
    expect(positionAt(0.95).running?.id).toBe("write");
    expect(positionAt(1).running?.id).toBe("write");
  });

  it("splits the ladder into done, running and waiting", () => {
    const at = positionAt(0.4);
    expect(at.done.map((s) => s.id)).toEqual(["download", "decode", "tempo", "beats", "onsets"]);
    expect(at.running?.id).toBe("key");
    expect(at.waiting.map((s) => s.id)).toEqual(["groove", "loudness", "spectral", "structure", "write"]);
    expect(at.done.length + 1 + at.waiting.length).toBe(ANALYSIS_LADDER.length);
  });

  it("never claims a measured value: every step says what it will produce, not what it found", () => {
    for (const stage of ANALYSIS_LADDER) {
      expect(stage.gives).not.toMatch(/\d+(\.\d+)? ?(BPM|LUFS|kHz)/);
    }
  });
});

describe("elapsed and history", () => {
  it("counts from started_at to finished_at, or to now while running", () => {
    expect(elapsedSeconds(job())).toBe(40);
    expect(elapsedSeconds(job({ finished_at: null }), new Date("2026-09-13T00:01:00Z"))).toBe(60);
    expect(elapsedSeconds(job({ started_at: null }))).toBeNull();
  });

  it("has no estimate for the first analysis on an account", () => {
    expect(pastAnalysisRuns([])).toBeNull();
    expect(pastAnalysisRuns([job({ status: "running", finished_at: null })])).toBeNull();
  });

  it("takes the median of this account's own finished analyses", () => {
    const runs = pastAnalysisRuns([
      job({ id: "a", finished_at: "2026-09-13T00:00:30Z" }),
      job({ id: "b", finished_at: "2026-09-13T00:00:50Z" }),
      job({ id: "c", finished_at: "2026-09-13T00:01:40Z" }),
    ]);
    expect(runs).toEqual({ runs: 3, medianS: 50 });
  });

  it("ignores the loop finder and partial re-runs, which are not the same work", () => {
    expect(isFullAnalyze(job())).toBe(true);
    expect(isFullAnalyze(job({ params: { task: "find_loops" } }))).toBe(false);
    expect(isFullAnalyze(job({ params: { stages: ["chords"] } }))).toBe(false);
    expect(isFullAnalyze(job({ kind: "stems" }))).toBe(false);
    expect(pastAnalysisRuns([job({ params: { task: "find_loops" } })])).toBeNull();
  });

  it("formats a wait the way a producer reads one", () => {
    expect(fmtElapsed(9)).toBe("9 s");
    expect(fmtElapsed(59.4)).toBe("59 s");
    expect(fmtElapsed(70)).toBe("1:10");
    expect(fmtElapsed(null)).toBe("—");
  });
});
