// The writer's half of the contract with the ranker.
//
// `analysis/lockedgroove/learn/loop_prefs.py` reads three `corrections.field`
// values and nothing else, and the payload shapes are pinned by the migration's
// column comment. Both sides used to describe those shapes in prose in two
// languages, which is how the overlap between what the web wrote and what the
// learner read came to be empty.
//
// This drives the real route handlers through two plausible sessions — one
// producer who keeps dragging loops out to eight bars, one who keeps pulling
// them in to two — and writes what the routes actually inserted to
// `analysis/tests/fixtures/loop_corrections_from_web.json`. The end-to-end test
// on the analysis side replays that file into an empty database and runs the
// finder over it, so the rows the ranker learns from are, byte for byte, the
// rows these routes produce. Change a payload here and that test changes with
// it or fails.
//
// Regenerate with `UPDATE_LOOP_CORRECTION_FIXTURE=1 pnpm test corrections`.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createWorld, params, patch, post, seedFile, seedLoop, USER_A, type World } from "@/lib/testing";
import type { Json, LoopRow } from "@/lib/types/db";
import { PATCH } from "./[id]/route";
import { POST as RENDER } from "./[id]/render/route";

const FIXTURE = path.resolve(process.cwd(), "..", "analysis", "tests", "fixtures", "loop_corrections_from_web.json");

/** 120 BPM in 4/4: two seconds a bar, so a fixture anyone can read. */
const BAR_S = 2;

/** A finder candidate's scored terms, as `find_loops` writes them. */
const TERMS = { seam: 0.61, phrase: 1, stability: 0.95, novelty: 1, onset_lock: 1, recurrence: 0.5 };

interface Payload {
  field: string;
  predicted: Json;
  corrected: Json;
}

let world: World;

beforeEach(() => {
  world = createWorld();
});

function loop(fileId: string, bars: number, startS: number, extra: Partial<LoopRow> = {}): LoopRow {
  return seedLoop(world.db, USER_A, fileId, {
    start_s: startS,
    end_s: startS + bars * BAR_S,
    bars,
    score: 0.8,
    origin: "finder",
    components: { ...TERMS, weights: { seam: 0.3, phrase: 0.22, stability: 0.15, novelty: 0.15, onset_lock: 0.1, recurrence: 0.08 } },
    ...extra,
  });
}

/** Drag the end of an offered loop until it is `to` bars long. */
async function dragEdgeOut(fileId: string, from: number, to: number): Promise<void> {
  const l = loop(fileId, from, 0);
  const res = await PATCH(patch(`/api/loops/${l.id}`, { start_s: l.start_s, end_s: l.start_s + to * BAR_S, bars: to }), params({ id: l.id }));
  expect(res.status).toBe(200);
}

/** Say the length outright with the bar control. */
async function setBars(fileId: string, from: number, to: number): Promise<void> {
  const l = loop(fileId, from, 0);
  const res = await PATCH(patch(`/api/loops/${l.id}`, { end_s: l.start_s + to * BAR_S, bars: to, via: "bars" }), params({ id: l.id }));
  expect(res.status).toBe(200);
}

/** Export the second row of a two-row rack: the producer took what we did not put first. */
async function exportSecondRow(fileId: string, topBars: number, chosenBars: number): Promise<void> {
  loop(fileId, topBars, 0, { score: 0.85 });
  const chosen = loop(fileId, chosenBars, 16, { score: 0.78 });
  const res = await RENDER(post(`/api/loops/${chosen.id}/render`), params({ id: chosen.id }));
  expect(res.status).toBe(201);
}

function written(): Payload[] {
  return world.db
    .rows("corrections")
    .map((r) => ({ field: r.field as string, predicted: r.predicted as Json, corrected: r.corrected as Json }));
}

/** One session of a producer who thinks a loop is eight bars long. */
async function dragsOutToEight(): Promise<Payload[]> {
  const a = seedFile(world.db, USER_A);
  for (let i = 0; i < 10; i += 1) await dragEdgeOut(a.id, 4, 8);
  for (let i = 0; i < 2; i += 1) await setBars(a.id, 4, 8);
  await exportSecondRow(seedFile(world.db, USER_A).id, 4, 8);
  await exportSecondRow(seedFile(world.db, USER_A).id, 4, 8);
  return written();
}

/** One session of a producer who chops breaks. */
async function pullsInToTwo(): Promise<Payload[]> {
  const a = seedFile(world.db, USER_A);
  for (let i = 0; i < 10; i += 1) await dragEdgeOut(a.id, 4, 2);
  for (let i = 0; i < 2; i += 1) await setBars(a.id, 4, 2);
  await exportSecondRow(seedFile(world.db, USER_A).id, 4, 2);
  await exportSecondRow(seedFile(world.db, USER_A).id, 4, 2);
  return written();
}

describe("the loop corrections the web writes", () => {
  it("logs a drag as loop_edges, the bar control as loop_bars, and an export off the top as loop_pick", async () => {
    const rows = await dragsOutToEight();

    expect(rows.map((r) => r.field)).toEqual([
      ...Array(10).fill("loop_edges"),
      "loop_bars",
      "loop_bars",
      "loop_pick",
      "loop_pick",
    ]);
    expect(rows[0]).toEqual({
      field: "loop_edges",
      predicted: { start_s: 0, end_s: 8, bars: 4 },
      corrected: { start_s: 0, end_s: 16, bars: 8 },
    });
    expect(rows[10]).toEqual({
      field: "loop_bars",
      predicted: { start_s: 0, end_s: 8, bars: 4 },
      corrected: { start_s: 0, end_s: 16, bars: 8 },
    });
    expect(rows[12]).toEqual({
      field: "loop_pick",
      predicted: { bars: 4, rank: 1, components: TERMS },
      corrected: { bars: 8, rank: 2, components: TERMS },
    });
  });

  it("says the opposite thing for a producer who pulls loops in", async () => {
    const rows = await pullsInToTwo();
    expect(rows).toHaveLength(14);
    expect(rows[0].corrected).toEqual({ start_s: 0, end_s: 4, bars: 2 });
    expect(rows[13].corrected).toMatchObject({ bars: 2, rank: 2 });
  });

  it("is the file the analysis end-to-end test replays", async () => {
    const histories = {
      drags_out_to_eight: await dragsOutToEight(),
      pulls_in_to_two: await (async () => {
        world = createWorld();
        return pullsInToTwo();
      })(),
    };
    const fixture = {
      note:
        "Written by web/app/api/loops/corrections.test.ts from the real route handlers: these are the " +
        "rows PATCH /api/loops/[id] and POST /api/loops/[id]/render insert. user_id and file_id are the " +
        "replaying test's to stamp. Regenerate with UPDATE_LOOP_CORRECTION_FIXTURE=1 pnpm test corrections.",
      bar_s: BAR_S,
      histories,
    };

    if (process.env.UPDATE_LOOP_CORRECTION_FIXTURE) {
      writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
    }
    expect(JSON.parse(readFileSync(FIXTURE, "utf8"))).toEqual(fixture);
  });
});
