// The grounding contract fixtures (BUILD_PACKET section 14), against the
// tool handlers with in-memory doubles. No network anywhere.

import { describe, expect, it } from "vitest";
import { MemoryWebCache } from "@/lib/webinfo/cache";
import { fetchPage } from "@/lib/webinfo/fetchPage";
import { RobotsCache } from "@/lib/webinfo/robots";
import type { BreakdownRow } from "@/lib/types/db";
import { fakeContext, fakeFile, fakeId, fakeWeb, MemoryChatDb } from "./fakes";
import { batchFingerprint, runTool } from "./handlers";
import { WEB_QUOTA_MESSAGE } from "./limits";
import { GROUNDING_CONTRACT, LINK_REFUSAL, SYSTEM_PROMPT } from "./system";
import { BATCH_GPU_CONFIRM } from "./tools";

describe("musical facts come only from the report", () => {
  it("get_report and explain say chords are not analyzed yet when the section is null, and the prompt forbids inventing them", async () => {
    const file = fakeFile({ original_filename: "beat.wav" }, { chords: null });
    const ctx = fakeContext(new MemoryChatDb([file]));

    const report = await runTool("get_report", { file_id: file.id }, ctx);
    expect(report.is_error).toBe(false);
    const parsed = JSON.parse(report.text) as { chords: unknown; not_analyzed: string[] };
    expect(parsed.chords).toBe("not analyzed yet");
    expect(parsed.not_analyzed).toContain("chords");
    expect(report.card).toMatchObject({ type: "report", not_analyzed: expect.arrayContaining(["chords"]) });
    expect(report.text).not.toMatch(/Fm7|Cm7|progression/);

    const explain = await runTool("explain", { file_id: file.id }, ctx);
    expect(explain.text).toContain("Chords: not analyzed yet");
    expect(explain.text).toContain("Not analyzed yet: ");

    expect(SYSTEM_PROMPT).toContain(GROUNDING_CONTRACT);
    expect(GROUNDING_CONTRACT).toContain("Never claim a value from a section that is null");
    expect(GROUNDING_CONTRACT).toContain("say you don't know");
  });

  it("explain prefixes 'roughly' to a 0.4-confidence reverb estimate and 'likely' to a 0.7 key", async () => {
    const file = fakeFile(
      {},
      {
        effects_estimates: {
          reverb_tail_s: { value: 1.5, confidence: 0.4, method: "decay", notes: "rough" },
          sidechain_ducking: { detected: false, depth_db: null, confidence: 0.5, method: "envelope" },
          saturation_above_hz: { value: null, confidence: 0.3, method: "harmonics", notes: null },
        },
      },
    );
    const ctx = fakeContext(new MemoryChatDb([file]));
    const out = await runTool("explain", { file_id: file.id }, ctx);
    expect(out.text).toContain("roughly reverb tail 1.5 s");
    expect(out.text).toContain("Key: likely F minor");
    expect(out.text).toContain("Tempo: 92 BPM");
    const report = await runTool("get_report", { file_id: file.id, sections: ["effects_estimates"] }, ctx);
    const parsed = JSON.parse(report.text) as { effects_estimates: { reverb_tail_s: { hedge: string } } };
    expect(parsed.effects_estimates.reverb_tail_s.hedge).toBe("roughly");
  });

  it("a file without a report yields nothing about its audio", async () => {
    const file = fakeFile({ status: "queued" }, null);
    const out = await runTool("get_report", { file_id: file.id }, fakeContext(new MemoryChatDb([file])));
    expect(out.text).toContain("no report yet");
    expect(out.text).not.toMatch(/\d+ BPM/);
  });
});

describe("world facts come only from cited web results", () => {
  it("says 'I couldn't find that' when the search returns nothing, and fabricates no citation", async () => {
    const web = fakeWeb({ results: {} });
    const out = await runTool("web_search", { query: "who produced obscure record" }, fakeContext(new MemoryChatDb(), { web }));
    expect(out.is_error).toBe(false);
    expect(out.text).toContain("I couldn't find that");
    expect(out.citations).toEqual([]);
    expect(out.card).toEqual({ type: "web", kind: "search", query: "who produced obscure record", items: [], citations: [] });
    expect(web.searched).toEqual(["who produced obscure record"]);
  });

  it("every world-fact card carries a citation for each item", async () => {
    const web = fakeWeb({
      results: { "q": [{ title: "Credits", url: "https://credits.example/x", snippet: "Produced by Someone." }] },
      pages: { "https://credits.example/x": { ok: true, page: { url: "https://credits.example/x", title: "Credits", text: "Produced by Someone in 1976.", fetched_at: "2026-09-13T00:00:00Z" }, cached: false } },
      identify: {
        identified: true,
        artist: "A",
        title: "T",
        queries: ["A T producer"],
        findings: [{ kind: "producer", text: "Produced by Someone.", citation: { url: "https://credits.example/x", title: "Credits" } }],
        searches_run: 1,
      },
    });
    const file = fakeFile({ title: "T", artist: "A" });
    const ctx = fakeContext(new MemoryChatDb([file]), { web });

    const search = await runTool("web_search", { query: "q" }, ctx);
    expect(search.card?.type).toBe("web");
    if (search.card?.type === "web") {
      expect(search.card.items).toHaveLength(1);
      expect(search.card.citations).toEqual([{ url: "https://credits.example/x", title: "Credits" }]);
      for (const item of search.card.items) expect(item.url).toMatch(/^https:\/\//);
    }
    expect(search.citations).toHaveLength(1);
    expect(search.searches).toBe(1);

    const page = await runTool("fetch_page", { url: "https://credits.example/x" }, ctx);
    expect(page.citations).toEqual([{ url: "https://credits.example/x", title: "Credits" }]);
    expect(page.card).toMatchObject({ type: "web", kind: "page", citations: [{ url: "https://credits.example/x" }] });

    const context = await runTool("identify_context", { file_id: file.id }, ctx);
    expect(context.citations).toEqual([{ url: "https://credits.example/x", title: "Credits" }]);
    if (context.card?.type === "web") for (const item of context.card.items) expect(item.url).toBe("https://credits.example/x");
    expect(context.searches).toBe(1);
  });

  it("identify_context explains an unidentified file instead of guessing", async () => {
    const file = fakeFile({ original_filename: "take3.wav" });
    const out = await runTool("identify_context", { file_id: file.id }, fakeContext(new MemoryChatDb([file])));
    expect(out.text).toContain("isn't identified");
    expect(out.citations).toEqual([]);
  });

  it("the daily web search allowance is enforced in the tool", async () => {
    const ctx = fakeContext(new MemoryChatDb(), { usage: { webSearchesLeft: 0 } });
    const out = await runTool("web_search", { query: "q" }, ctx);
    expect(out.is_error).toBe(true);
    expect(out.text).toBe(WEB_QUOTA_MESSAGE);
    const ctx2 = fakeContext(new MemoryChatDb(), { usage: { webSearchesLeft: 1 } });
    await runTool("web_search", { query: "q" }, ctx2);
    expect(ctx2.usage.webSearchesLeft).toBe(0);
  });
});

describe("audio from links is refused", () => {
  it("the fetch_page guard never requests a media URL, and the prompt carries the standard sentence", async () => {
    const calls: string[] = [];
    const fetcher = async (input: string) => {
      calls.push(input);
      return new Response("", { status: 200, headers: { "content-type": "text/html" } });
    };
    const web = {
      provider: "brave" as const,
      search: async () => ({ results: [], cached: false }),
      fetchPage: (url: string) => fetchPage(url, { fetcher, robots: new RobotsCache(fetcher), cache: new MemoryWebCache() }),
      identifyContext: async () => ({ identified: false, artist: null, title: null, queries: [], findings: [], searches_run: 0 }),
    };
    const ctx = fakeContext(new MemoryChatDb(), { web });
    for (const url of ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://soundcloud.com/x/y", "https://cdn.example.com/track.mp3", "https://example.com/download/9"]) {
      const out = await runTool("fetch_page", { url }, ctx);
      expect(out.is_error).toBe(true);
      expect(out.text).toContain(LINK_REFUSAL);
    }
    expect(calls).toEqual([]);
    expect(SYSTEM_PROMPT).toContain(LINK_REFUSAL);
    expect(SYSTEM_PROMPT).toContain("never download audio from it");
  });

  it("an audio response is refused after the fact too", async () => {
    const fetcher = async () => new Response("ID3", { status: 200, headers: { "content-type": "audio/mpeg" } });
    const web = {
      provider: "brave" as const,
      search: async () => ({ results: [], cached: false }),
      fetchPage: (url: string) => fetchPage(url, { fetcher, robots: new RobotsCache(async () => new Response("", { status: 404 })), cache: new MemoryWebCache() }),
      identifyContext: async () => ({ identified: false, artist: null, title: null, queries: [], findings: [], searches_run: 0 }),
    };
    const out = await runTool("fetch_page", { url: "https://example.com/listen" }, fakeContext(new MemoryChatDb(), { web }));
    expect(out.is_error).toBe(true);
    expect(out.text).toContain("audio/mpeg");
    expect(out.text).toContain(LINK_REFUSAL);
  });
});

describe("library operations", () => {
  it("set_edit applies through the same merge as the edits route and logs a correction", async () => {
    const file = fakeFile();
    const db = new MemoryChatDb([file]);
    const out = await runTool("set_edit", { file_id: file.id, field: "tempo_bpm", value: { number: 90 } }, fakeContext(db));
    expect(out.is_error).toBe(false);
    expect(out.card).toEqual({ type: "edit", file_id: file.id, file_name: "song.wav", field: "tempo_bpm", predicted: 92, corrected: 90 });
    expect(db.corrections).toHaveLength(1);
    expect(db.corrections[0]).toMatchObject({ field: "tempo_bpm", predicted: 92, corrected: 90 });
    const stored = db.files.get(file.id)!;
    expect(stored.report?.tempo?.bpm).toBe(92);
    expect(stored.report?.user_edits.tempo_bpm).toBe(90);

    const key = await runTool("set_edit", { file_id: file.id, field: "key", value: { key: { tonic: "A#", mode: "minor" } } }, fakeContext(db));
    expect(key.card).toMatchObject({ type: "edit", field: "key", corrected: { tonic: "A#", mode: "minor" } });
    const bad = await runTool("set_edit", { file_id: file.id, field: "meter", value: { number: 3 } }, fakeContext(db));
    expect(bad.is_error).toBe(true);
    expect(bad.text).toContain("value.text for meter");
  });

  it("find_loops returns existing finder loops, otherwise queues the finder job", async () => {
    const file = fakeFile();
    const db = new MemoryChatDb([file]);
    const ctx = fakeContext(db);
    const queued = await runTool("find_loops", { file_id: file.id }, ctx);
    expect(queued.card).toMatchObject({ type: "job", kind: "analyze", file_id: file.id, status: "queued", dispatch: null });
    expect(db.jobs[0]?.params).toEqual({ task: "find_loops", bars: [1, 2, 4, 8], top_k: 12 });
    const again = await runTool("find_loops", { file_id: file.id }, ctx);
    expect(again.summary).toContain("already queued");
    expect(db.jobs).toHaveLength(1);

    db.jobs[0]!.status = "done";
    db.loops.push({ ...(await db.insertLoop({ file_id: file.id, start_s: 0, end_s: 10.43, name: null, bars: 4 })), origin: "finder", score: 0.82 });
    const listed = await runTool("find_loops", { file_id: file.id }, ctx);
    expect(listed.card?.type).toBe("loops");
    if (listed.card?.type === "loops") expect(listed.card.loops[0]).toMatchObject({ bars: 4, score: 0.82 });

    const notReady = fakeFile({ status: "analyzing" }, null);
    db.files.set(notReady.id, notReady);
    const refused = await runTool("find_loops", { file_id: notReady.id }, ctx);
    expect(refused.is_error).toBe(true);
    expect(refused.text).toContain("needs the analysis first");
  });

  it("create_loop, render_loop and layer write the rows the routes would", async () => {
    const a = fakeFile({ original_filename: "drums.wav" });
    const b = fakeFile({ original_filename: "sample.wav" });
    const db = new MemoryChatDb([a, b]);
    const ctx = fakeContext(db);
    const loop = await runTool("create_loop", { file_id: a.id, start_s: 2.608, end_s: 13.04, name: "hook" }, ctx);
    expect(loop.card).toMatchObject({ type: "loop", loop: { origin: "chat", name: "hook", bars: 4 } });
    const loopId = loop.card?.type === "loop" ? loop.card.loop.id : "";
    const render = await runTool("render_loop", { loop_id: loopId }, ctx);
    expect(render.card).toMatchObject({ type: "job", kind: "render_loop" });
    expect(db.jobs.find((j) => j.kind === "render_loop")?.params).toEqual({ loop_id: loopId, crossfade_ms: 12, snap_zero_crossing: true });

    const layer = await runTool("layer", { items: [{ file_id: a.id }, { file_id: b.id, gain_db: -3, offset_s: 0.5 }] }, ctx);
    expect(layer.card).toMatchObject({ type: "layer", tempo_bpm: 92, key: "F minor", items: [{ name: "drums.wav", gain_db: 0 }, { name: "sample.wav", gain_db: -3, offset_s: 0.5 }] });
    expect(db.layers).toHaveLength(1);
    expect(db.layerItems.map((i) => i.position)).toEqual([0, 1]);
    expect(db.jobs.find((j) => j.kind === "layer")?.params).toEqual({ layer_id: db.layers[0]!.id });
    const missing = await runTool("layer", { items: [{ file_id: fakeId() }] }, ctx);
    expect(missing.is_error).toBe(true);
  });

  it("queues stems, chops, midi, revoice, embed and reports a compute outage honestly", async () => {
    const file = fakeFile();
    const db = new MemoryChatDb([file]);
    const ctx = fakeContext(db, { dispatch: async () => ({ ok: false, reason: "compute not configured" }) });
    const stems = await runTool("separate_stems", { file_id: file.id, model: "htdemucs_6s" }, ctx);
    expect(stems.card).toMatchObject({ type: "job", kind: "stems", dispatch: "compute not configured" });
    expect(stems.text).toContain("stays queued");
    expect((await runTool("chop", { file_id: file.id, mode: "transients", params: { count: 8 } }, ctx)).card).toMatchObject({ type: "job", kind: "chop" });
    expect((await runTool("chop", { file_id: file.id, mode: "manual" }, ctx)).is_error).toBe(true);
    expect((await runTool("extract_midi", { file_id: file.id, kind: "drums" }, ctx)).card).toMatchObject({ type: "job", kind: "midi" });
    expect((await runTool("revoice", { file_id: file.id, instrument: "rhodes" }, ctx)).card).toMatchObject({ type: "job", kind: "revoice" });
    expect(db.jobs.find((j) => j.kind === "revoice")?.params).toEqual({ instrument: "rhodes", path: "symbolic" });
    expect((await runTool("embed", { file_id: file.id }, ctx)).card).toMatchObject({ type: "job", kind: "embed" });
  });

  it("breakdown returns the latest document when it is fresh, else queues", async () => {
    const file = fakeFile();
    const db = new MemoryChatDb([file]);
    const ctx = fakeContext(db);
    const queued = await runTool("breakdown", { file_id: file.id }, ctx);
    expect(queued.card).toMatchObject({ type: "breakdown", status: "queued" });
    db.jobs[0]!.status = "done";
    const row: BreakdownRow = {
      id: fakeId(),
      user_id: "user-1",
      file_id: file.id,
      version: 1,
      content: {
        schema_version: "1.0",
        file_id: file.id,
        generated_at: "2026-09-13T12:00:00Z",
        analysis_version: 1,
        identified: false,
        title: null,
        artist: null,
        requires: [],
        sections: [
          { key: "vitals", title: "The vitals", facts: [{ text: "92 BPM.", source: "tempo.bpm", confidence: 0.91, hedge: "", value: 92, time_s: null, end_s: null, bar: null, citation: null }], missing: [] },
          { key: "context", title: "The context", facts: [{ text: "Produced by Someone.", source: "web", confidence: null, hedge: "", value: null, time_s: null, end_s: null, bar: null, citation: { url: "https://c.example/", title: "Credits" } }], missing: [] },
        ],
      },
      web_context: null,
      narration: null,
      created_at: "2026-09-13T12:00:00.000Z",
    };
    db.breakdowns.push(row);
    const ready = await runTool("breakdown", { file_id: file.id }, ctx);
    expect(ready.card).toMatchObject({ type: "breakdown", status: "ready", version: 1 });
    expect(ready.citations).toEqual([{ url: "https://c.example/", title: "Credits" }]);
    expect(ready.text).toContain("92 BPM.");
  });

  it("search returns a card with the matched fields and the mode", async () => {
    const file = fakeFile({ original_filename: "dusty.wav" });
    const ctx = fakeContext(new MemoryChatDb([file]), {
      librarySearch: async (query) => ({
        results: [{ file, matched: { bpm: 92, key: "F minor" }, similarity: 0.9 }],
        parsed: { text_query: query, bpm_min: 90, bpm_max: 94, tonic: "F", mode: "minor", kind: null, tags: [], has_drums: null, is_loop_based: null, similar: false, similar_to_file_id: null, parser: "rules" },
        mode: "vector",
        note: null,
      }),
    });
    const out = await runTool("search", { query: "dusty f minor 92" }, ctx);
    expect(out.card).toMatchObject({ type: "search", mode: "vector", results: [{ file_id: file.id, name: "dusty.wav", matched: { bpm: 92, key: "F minor" }, similarity: 0.9 }] });
  });

  it("rejects unknown tools and invalid inputs without throwing", async () => {
    const ctx = fakeContext(new MemoryChatDb());
    expect((await runTool("make_beat", {}, ctx)).is_error).toBe(true);
    const bad = await runTool("get_report", { file_id: "not-a-uuid" }, ctx);
    expect(bad.is_error).toBe(true);
    expect(bad.text).toContain("file_id");
    const missing = await runTool("get_report", { file_id: fakeId() }, ctx);
    expect(missing.text).toContain("isn't in your library");
  });
});

describe("batch confirmation (OPEN_QUESTIONS E.23)", () => {
  const stemOps = (n: number, ids: string[]) => ids.slice(0, n).map((id) => ({ tool: "separate_stems", input_json: JSON.stringify({ file_id: id }) }));

  it("runs up to five GPU operations, asks first above five, and runs when confirmed", async () => {
    const files = Array.from({ length: 8 }, (_, i) => fakeFile({ original_filename: `f${i}.wav` }));
    const ids = files.map((f) => f.id);
    const db = new MemoryChatDb(files);
    const ctx = fakeContext(db);

    const five = await runTool("batch", { operations: stemOps(BATCH_GPU_CONFIRM, ids) }, ctx);
    expect(five.card?.type).toBe("batch");
    expect(db.jobs.filter((j) => j.kind === "stems")).toHaveLength(5);

    const six = await runTool("batch", { operations: stemOps(6, ids.slice(0, 0).concat(ids)) }, fakeContext(new MemoryChatDb(files)));
    expect(six.card?.type).toBe("confirm");
    if (six.card?.type === "confirm") {
      expect(six.card.gpu_count).toBe(6);
      expect(six.card.operations).toHaveLength(6);
      expect(six.card.batch_id).toBe(batchFingerprint(six.card.operations));
      expect(six.card.estimate).toContain("6 GPU jobs");
    }
    expect(six.text).toContain("needs_confirmation");

    const db2 = new MemoryChatDb(files);
    const confirmed = await runTool("batch", { operations: stemOps(6, ids), confirmed: true }, fakeContext(db2));
    expect(confirmed.card?.type).toBe("batch");
    expect(db2.jobs).toHaveLength(6);

    const db3 = new MemoryChatDb(files);
    const viaPane = await runTool("batch", { operations: stemOps(6, ids) }, fakeContext(db3, { confirmedBatch: batchFingerprint(stemOps(6, ids)) }));
    expect(viaPane.card?.type).toBe("batch");
    expect(db3.jobs).toHaveLength(6);
  });

  it("counts only GPU tools toward the threshold and refuses nested batches and unknown tools", async () => {
    const files = Array.from({ length: 10 }, () => fakeFile());
    const db = new MemoryChatDb(files);
    const ops = files.map((f) => ({ tool: "get_report", input_json: JSON.stringify({ file_id: f.id }) }));
    const out = await runTool("batch", { operations: ops }, fakeContext(db));
    expect(out.card?.type).toBe("batch");
    if (out.card?.type === "batch") expect(out.card.items).toHaveLength(10);
    expect((await runTool("batch", { operations: [{ tool: "batch", input_json: "{}" }] }, fakeContext(db))).is_error).toBe(true);
    expect((await runTool("batch", { operations: [{ tool: "nope", input_json: "{}" }] }, fakeContext(db))).is_error).toBe(true);
    const tooMany = await runTool("batch", { operations: Array.from({ length: 21 }, () => ({ tool: "get_report", input_json: "{}" })) }, fakeContext(db));
    expect(tooMany.is_error).toBe(true);
    const badJson = await runTool("batch", { operations: [{ tool: "get_report", input_json: "{" }] }, fakeContext(db));
    if (badJson.card?.type === "batch") expect(badJson.card.items[0]).toMatchObject({ is_error: true });
  });
});
