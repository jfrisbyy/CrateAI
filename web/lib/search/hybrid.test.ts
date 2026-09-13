import { describe, expect, it } from "vitest";
import { emptyReport } from "@/lib/report/effective";
import type { FileRow, TagRow, VectorMatch } from "@/lib/types/db";
import { mergeParsed, parseWithClaude, QuerySchema, type ParseClient } from "./claudeParser";
import { EmbedUnavailableError, embedText } from "./embedText";
import { hybridSearch, TEXT_FALLBACK_NOTE, type HybridDeps } from "./hybrid";
import { matchedFor, mergeHits } from "./merge";
import { parseQuery } from "./parse";

function file(id: string, extra: Partial<FileRow> = {}, report: Partial<NonNullable<FileRow["report"]>> = {}): FileRow {
  return {
    id,
    user_id: "u",
    sha256: id,
    original_filename: `${id}.wav`,
    storage_path: `library/u/${id}.wav`,
    size_bytes: 1,
    duration_s: 10,
    sample_rate: 44100,
    channels: 2,
    format: "wav",
    kind: "original",
    parent_file_id: null,
    status: "ready",
    analysis_version: 1,
    report: emptyReport({
      tempo: { bpm: 85, confidence: 0.9, method: "t", alternates_bpm: [42.5, 170], notes: null },
      key: { tonic: "F", mode: "minor", confidence: 0.7, method: "k", alternate: null, notes: null },
      ...report,
    }),
    peaks: null,
    title: null,
    artist: null,
    created_at: "2026-09-13T00:00:00Z",
    updated_at: "2026-09-13T00:00:00Z",
    ...extra,
  };
}

function tag(fileId: string, name: string): TagRow {
  return { id: `${fileId}:${name}`, user_id: "u", file_id: fileId, tag: name, source: "model", confidence: 0.8, created_at: "2026-09-13T00:00:00Z" };
}

function deps(overrides: Partial<HybridDeps> & { files: FileRow[]; tags?: TagRow[]; vector?: VectorMatch[]; embedded?: number; calls?: string[] }): HybridDeps {
  const calls = overrides.calls ?? [];
  const byId = new Map(overrides.files.map((f) => [f.id, f]));
  return {
    libraryFilter: async (args) => {
      calls.push(`filter:${JSON.stringify(args)}`);
      return overrides.files.filter((f) => {
        const bpm = f.report?.tempo?.bpm ?? 0;
        if (args.p_bpm_min != null && bpm < args.p_bpm_min) return false;
        if (args.p_bpm_max != null && bpm > args.p_bpm_max) return false;
        if (args.p_tonic && f.report?.key?.tonic !== args.p_tonic) return false;
        if (args.p_text && !f.original_filename.toLowerCase().includes(args.p_text.toLowerCase())) return false;
        if (args.p_tags && !(overrides.tags ?? []).some((t) => t.file_id === f.id && args.p_tags?.includes(t.tag))) return false;
        return true;
      });
    },
    searchEmbeddings: async (args) => {
      calls.push(`vector:${args.p_model}`);
      return overrides.vector ?? [];
    },
    similarFiles: async (args) => {
      calls.push(`similar:${args.p_file_id}`);
      return overrides.vector ?? [];
    },
    getFiles: async (ids) => ids.map((id) => byId.get(id)).filter((f): f is FileRow => f !== undefined),
    getTags: async () => overrides.tags ?? [],
    countEmbeddings: async () => overrides.embedded ?? 3,
    embedText: async () => {
      calls.push("embed");
      return { model: "clap-test", dim: 3, vectors: [[0.1, 0.2, 0.3]] };
    },
    parseClient: null,
    ...overrides,
  };
}

describe("merge ordering", () => {
  it("ranks vector hits by similarity, then filter-only hits, each file once", () => {
    const a = file("a");
    const b = file("b");
    const c = file("c");
    const d = file("d");
    const parsed = parseQuery("dusty around 85");
    const hits = mergeHits({
      vector: [
        { file_id: "b", similarity: 0.71 },
        { file_id: "a", similarity: 0.93 },
        { file_id: "c", similarity: 0.5 },
      ],
      filtered: [d, a, c],
      filesById: new Map([a, b, c, d].map((f) => [f.id, f])),
      tagRows: [],
      parsed,
      limit: 10,
    });
    expect(hits.map((h) => h.file.id)).toEqual(["a", "b", "c", "d"]);
    expect(hits[0]?.matched).toEqual({ bpm: 85, similarity: 0.93 });
    expect(hits[3]?.matched).toEqual({ bpm: 85 });
    expect(hits[3]?.similarity).toBeUndefined();
  });

  it("reports the report fields that matched", () => {
    const f = file("x");
    const parsed = parseQuery("dusty horns in f minor around 85 no drums");
    const m = matchedFor(f, parsed, ["dusty", "brass", "piano"]);
    expect(m).toEqual({ bpm: 85, key: "F minor", tags: ["dusty", "brass"], has_drums: false });
  });
});

describe("hybridSearch", () => {
  it("embeds the text, searches vectors with the filters, and appends filter-only hits", async () => {
    const files = [file("v1"), file("v2"), file("f1"), file("out", {}, { tempo: { bpm: 120, confidence: 0.9, method: "t", alternates_bpm: [60, 240], notes: null } })];
    const calls: string[] = [];
    const res = await hybridSearch("dusty in f minor around 85", {}, deps({ files, calls, vector: [{ file_id: "v2", similarity: 0.8 }, { file_id: "v1", similarity: 0.9 }] }));
    expect(res.mode).toBe("vector");
    expect(res.note).toBeNull();
    expect(res.results.map((r) => r.file.id)).toEqual(["v1", "v2", "f1"]);
    expect(calls.filter((c) => c === "embed")).toHaveLength(1);
    expect(calls.some((c) => c.startsWith("vector:clap-test"))).toBe(true);
    expect(res.parsed).toMatchObject({ tonic: "F", mode: "minor", bpm_min: 80, bpm_max: 90, text_query: "dusty" });
  });

  it("falls back to filters and name match when compute is unreachable, and says so", async () => {
    const files = [file("soul_dusty_break"), file("clean_piano")];
    const res = await hybridSearch("dusty", {}, deps({ files, embedText: async () => { throw new EmbedUnavailableError("compute unreachable (ECONNREFUSED)"); } }));
    expect(res.mode).toBe("filters");
    expect(res.note).toContain(TEXT_FALLBACK_NOTE);
    expect(res.note).toContain("compute unreachable");
    expect(res.results.map((r) => r.file.id)).toEqual(["soul_dusty_break"]);
    expect(res.results[0]?.matched.name).toBe("soul_dusty_break.wav");
  });

  it("falls back when compute answers 503 and when nothing is embedded yet", async () => {
    const files = [file("a")];
    const via503 = await hybridSearch("warm rhodes", {}, deps({ files, embedText: async () => { throw new EmbedUnavailableError("no text embedder on that runner"); } }));
    expect(via503.mode).toBe("filters");
    expect(via503.note).toContain("no text embedder");
    const none = await hybridSearch("warm rhodes", {}, deps({ files, embedded: 0 }));
    expect(none.mode).toBe("filters");
    expect(none.note).toContain("no files are embedded yet");
  });

  it("in filters mode, tagged files are found through the tag expansion", async () => {
    const files = [file("a"), file("b")];
    const res = await hybridSearch("warm rhodes", {}, deps({ files, tags: [tag("a", "rhodes")], embedded: 0 }));
    expect(res.mode).toBe("filters");
    expect(res.results.map((r) => r.file.id)).toEqual(["a"]);
    expect(res.results[0]?.matched.tags).toEqual(["rhodes"]);
  });

  it("keeps the structured filters when the words match no name", async () => {
    const files = [file("a"), file("b")];
    const res = await hybridSearch("dusty in f minor", {}, deps({ files, embedded: 0 }));
    expect(res.results.map((r) => r.file.id)).toEqual(["a", "b"]);
    expect(res.results[0]?.matched.key).toBe("F minor");
  });

  it("runs 'like this' through similar_files and applies the filters itself", async () => {
    const files = [file("src"), file("n1"), file("n2", {}, { tempo: { bpm: 140, confidence: 0.9, method: "t", alternates_bpm: [70, 280], notes: null } })];
    const calls: string[] = [];
    const res = await hybridSearch("more like this around 85", { currentFileId: "src" }, deps({ files, calls, vector: [{ file_id: "n1", similarity: 0.9 }, { file_id: "n2", similarity: 0.85 }, { file_id: "src", similarity: 1 }] }));
    expect(calls).toContain("similar:src");
    expect(res.mode).toBe("vector");
    expect(res.results.map((r) => r.file.id)).toEqual(["n1"]);
    expect(res.parsed.similar_to_file_id).toBe("src");
  });

  it("explains when 'like this' has no open file", async () => {
    const res = await hybridSearch("like this", {}, deps({ files: [file("a")] }));
    expect(res.mode).toBe("filters");
    expect(res.note).toContain("needs an open file");
  });
});

describe("the Claude parser", () => {
  const fake = (output: unknown, calls: unknown[] = []): ParseClient => ({
    parse: async (params) => {
      calls.push(params);
      return { parsed_output: output };
    },
  });

  it("is used only when free text remains, and its fields fill what the rules left null", async () => {
    const calls: Array<{ system: string; messages: Array<{ content: string }> }> = [];
    const client = fake(
      { text_query: "dusty horns", bpm_min: null, bpm_max: null, key: null, kind: null, tags: ["dusty", "horns", "brass"], has_drums: false, is_loop_based: null, similar_to_current: false },
      calls,
    );
    const res = await hybridSearch("Something dusty in F minor around 85 with horns, no drums", {}, deps({ files: [file("a")], parseClient: client, embedded: 0 }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.messages[0]?.content).toBe("Something dusty in F minor around 85 with horns, no drums");
    expect(calls[0]?.system).toContain("Never invent a filter");
    expect(res.parsed).toMatchObject({ parser: "rules+claude", tonic: "F", mode: "minor", bpm_min: 80, bpm_max: 90, has_drums: false, text_query: "dusty horns" });
    expect(res.parsed.tags).toEqual(["dusty", "horns", "brass"]);

    const filtersOnly = await hybridSearch("85 bpm", {}, deps({ files: [file("a")], parseClient: client }));
    expect(calls).toHaveLength(1);
    expect(filtersOnly.parsed.parser).toBe("rules");
  });

  it("falls back to the rules when parsed_output is null or malformed or the call throws", async () => {
    expect(await parseWithClaude("q", fake(null))).toBeNull();
    expect(await parseWithClaude("q", fake({ nonsense: true }))).toBeNull();
    expect(
      await parseWithClaude("q", {
        parse: async () => {
          throw new Error("network");
        },
      }),
    ).toBeNull();
    const rules = parseQuery("dusty horns around 85");
    expect(mergeParsed(rules, null)).toBe(rules);
    const res = await hybridSearch("dusty horns around 85", {}, deps({ files: [file("a")], parseClient: fake(null), embedded: 0 }));
    expect(res.parsed).toMatchObject({ parser: "rules", bpm_min: 80, bpm_max: 90, text_query: "dusty horns" });
  });

  it("never lets Claude override a value the rules found", () => {
    const rules = parseQuery("f minor 90 bpm");
    const merged = mergeParsed(rules, { text_query: null, bpm_min: 60, bpm_max: 70, key: { tonic: "C", mode: "major" }, kind: "stem", tags: [], has_drums: null, is_loop_based: null, similar_to_current: true });
    expect(merged).toMatchObject({ tonic: "F", mode: "minor", bpm_min: 88, bpm_max: 92, kind: "stem", similar: true });
  });

  it("has a schema that matches the packet's field list", () => {
    expect(Object.keys(QuerySchema.shape).sort()).toEqual(["bpm_max", "bpm_min", "has_drums", "is_loop_based", "key", "kind", "similar_to_current", "tags", "text_query"]);
  });
});

describe("embedText", () => {
  it("posts the texts with the bearer and returns the vectors", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const res = await embedText(["dusty soul loop"], {
      baseUrl: "http://compute.local/",
      secret: "s3cret",
      fetcher: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true, model: "music_audioset_epoch_15_esc_90.14", dim: 2, vectors: [[0.6, 0.8]] }), { status: 200 });
      },
    });
    expect(res).toEqual({ model: "music_audioset_epoch_15_esc_90.14", dim: 2, vectors: [[0.6, 0.8]] });
    expect(calls[0]?.url).toBe("http://compute.local/embed_text");
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe("Bearer s3cret");
  });

  it("turns 503, other errors, and no configuration into EmbedUnavailableError", async () => {
    await expect(embedText(["x"], { baseUrl: undefined, secret: undefined, fetcher: async () => new Response("") })).rejects.toMatchObject({ reason: "compute not configured" });
    await expect(embedText(["x"], { baseUrl: "http://c", secret: "s", fetcher: async () => new Response("no embedder", { status: 503 }) })).rejects.toMatchObject({ reason: "no text embedder on that runner" });
    await expect(embedText(["x"], { baseUrl: "http://c", secret: "s", fetcher: async () => { throw new Error("ECONNREFUSED"); } })).rejects.toBeInstanceOf(EmbedUnavailableError);
    await expect(embedText(["x"], { baseUrl: "http://c", secret: "s", fetcher: async () => new Response("{}", { status: 200 }) })).rejects.toMatchObject({ reason: "compute returned an unexpected response" });
  });
});
