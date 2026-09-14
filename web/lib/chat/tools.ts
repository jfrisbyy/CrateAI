// The chat's tools (BUILD_PACKET section 14), as strict Anthropic tool
// definitions. Every description says what the tool returns and what it
// never does; the schemas are the contract lib/chat/handlers.ts validates
// against again with zod before touching anything.

import { ALL_STEMS } from "@/lib/types/stemModels";
import type Anthropic from "@anthropic-ai/sdk";
import { EXPORT_FORMATS } from "@/lib/export/types";
import { REPORT_SECTIONS } from "@/lib/types/report";

const uuid = (what: string) => ({ type: "string", description: `${what}; a library UUID.` });

const keySchema = {
  type: "object",
  description: "Sharps: Bb is A#.",
  properties: {
    tonic: { type: "string", enum: ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] },
    mode: { type: "string", enum: ["major", "minor"] },
  },
  required: ["tonic", "mode"],
  additionalProperties: false,
};

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): Anthropic.Tool {
  return {
    name,
    description,
    strict: true,
    input_schema: { type: "object", properties, required, additionalProperties: false },
  };
}

/** The stem names any separator returns; the split is chosen from these. */
export const STEM_NAMES = ALL_STEMS as readonly string[] as [string, ...string[]];
export const CHOP_MODES = ["transients", "grid", "manual"] as const;
export const MIDI_KINDS = ["melody", "drums", "chords", "groove"] as const;
export const REVOICE_PATHS = ["symbolic", "neural"] as const;
export const EDIT_FIELDS = ["tempo_bpm", "downbeat_phase", "first_downbeat_s", "key", "meter", "section_labels"] as const;

/** Tools that run on a GPU (OPEN_QUESTIONS E.23): a batch with more than BATCH_GPU_CONFIRM of them asks first. */
export const GPU_TOOLS: ReadonlySet<string> = new Set(["separate_stems", "revoice", "embed"]);
export const BATCH_GPU_CONFIRM = 5;
export const BATCH_MAX_OPERATIONS = 20;

export const CHAT_TOOLS: Anthropic.Tool[] = [
  tool(
    "get_report",
    "Read the effective analysis report of one file (user edits resolved over analyzed values): vitals (tempo, key, meter, downbeats, feel), sections, a per-section drum summary in producer terms, sample use, chords, instrumentation, loudness, spectral and effects estimates, tags. Every value carries its confidence and hedge word; an unanalyzed section reads \"not analyzed yet\" and is listed under not_analyzed. `sections` narrows it; the vitals always come. This is the only source of musical facts about audio; it never listens to the audio, never guesses, and never invents a value for a null section.",
    {
      file_id: uuid("The file"),
      sections: {
        type: "array",
        description: "Which report sections to include; omit for all of them.",
        items: { type: "string", enum: [...REPORT_SECTIONS, "tags", "user_edits"] },
      },
    },
    ["file_id"],
  ),
  tool(
    "explain",
    "The effective report of one file formatted for narration: one line per measured fact, in producer language (\"the and of three\", conventional key spellings), each value carrying the hedge word for its confidence band, and \"not analyzed yet\" for every section that has not run. Use it when asked what a file is or how it was made. It never returns anything that is not in the report and never fills a null section.",
    { file_id: uuid("The file") },
    ["file_id"],
  ),
  tool(
    "find_loops",
    "Rank loop candidates on a file's beat grid. Returns the loops already found when there are some; otherwise, or with refresh=true, queues the finder and returns the job, so the loops arrive on the surface when it finishes. Needs an analyzed file. It never edits audio.",
    {
      file_id: uuid("The file"),
      bars: { type: "array", description: "Loop lengths in bars to consider; default [1, 2, 4, 8].", items: { type: "integer", minimum: 1, maximum: 64 } },
      top_k: { type: "integer", description: "How many candidates to keep; default 12.", minimum: 1, maximum: 50 },
      refresh: { type: "boolean", description: "Run the finder again even when loops exist." },
    },
    ["file_id"],
  ),
  tool(
    "create_loop",
    "Create a loop region on a file from a start and end in seconds, editable on the surface. It does not render audio; call render_loop for a WAV.",
    {
      file_id: uuid("The file"),
      start_s: { type: "number", description: "Start in seconds.", minimum: 0 },
      end_s: { type: "number", description: "End in seconds, after the start.", minimum: 0 },
      name: { type: "string", description: "Optional name for the loop." },
    },
    ["file_id", "start_s", "end_s"],
  ),
  tool(
    "render_loop",
    "Queue the seamless render of a loop (zero-crossing snap, 12 ms equal-power tail crossfade) as a 24-bit WAV that becomes a library entry. It never changes the loop's edges.",
    { loop_id: uuid("The loop") },
    ["loop_id"],
  ),
  tool(
    "separate_stems",
    "Queue stem separation for a file (GPU). Ask for the split, never a model: drums, bass, vocals and other (the default), or vocals and instrumental, or those four plus guitar and piano. The best separator installed that makes them runs. Each stem becomes its own library file with its own analysis. Library files only, never audio from a link.",
    { file_id: uuid("The file"), stems: { type: "array", items: { type: "string", enum: [...STEM_NAMES] }, description: "The split; omit for drums, bass, vocals and other." } },
    ["file_id"],
  ),
  tool(
    "chop",
    "Queue chopping a file into slices that become library files and pads: transients (onsets ranked by strength), grid (equal slices across a bar range), or manual (marker times). It never generates new material.",
    {
      file_id: uuid("The file"),
      mode: { type: "string", enum: [...CHOP_MODES] },
      params: {
        type: "object",
        description: "count/min_gap_ms for transients; start_bar, end_bar, divisions for grid; markers_s for manual.",
        properties: {
          count: { type: "integer", minimum: 1, maximum: 128 },
          min_gap_ms: { type: "number", minimum: 5, maximum: 2000 },
          start_bar: { type: "integer", minimum: 0 },
          end_bar: { type: "integer", minimum: 0 },
          divisions: { type: "integer", minimum: 1, maximum: 64 },
          markers_s: { type: "array", items: { type: "number", minimum: 0 } },
        },
        additionalProperties: false,
      },
    },
    ["file_id", "mode"],
  ),
  tool(
    "extract_midi",
    "Queue MIDI extraction from a file: melody (Basic Pitch on the stem), drums (hit classification, measured offsets kept as timing), chords (from the chord segments), or groove (measured swing and offsets as a template). It transcribes only what was measured.",
    { file_id: uuid("The file"), kind: { type: "string", enum: [...MIDI_KINDS] } },
    ["file_id", "kind"],
  ),
  tool(
    "layer",
    "Combine material from different library files into one layer (\"the drums from this over the sample from that\"): creates the layer and its items, then queues the render, which tempo-matches by stretch and key-matches by pitch-shift to the target (default: the first item's effective values), aligns downbeats and mixes with per-item gain and offset. The render becomes a library file and every lane stays editable. Every item must be a library file; it never generates a lane from nothing and never takes audio from a link.",
    {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            file_id: uuid("A library file"),
            gain_db: { type: "number", minimum: -60, maximum: 12, description: "dB; default 0." },
            offset_s: { type: "number", minimum: -600, maximum: 600, description: "seconds; default 0." },
          },
          required: ["file_id"],
          additionalProperties: false,
        },
      },
      target_tempo: { type: "number", minimum: 20, maximum: 400, description: "BPM to match to; default the first item's." },
      target_key: keySchema,
      name: { type: "string", description: "Optional layer name." },
    },
    ["items"],
  ),
  tool(
    "revoice",
    "Queue re-voicing a part in another instrument (GPU): symbolic (default) extracts MIDI first and renders it through a sampled instrument, so the notes come back editable; neural is audio-to-audio and experimental. Instruments: piano, rhodes, electric_guitar, acoustic_guitar, upright_bass, strings, brass, synth and the others the compute image lists. The source is always the producer's file; it never creates a part from nothing.",
    {
      file_id: uuid("The file or stem to re-voice"),
      instrument: { type: "string", description: "Target instrument id, snake_case." },
      path: { type: "string", enum: [...REVOICE_PATHS], description: "symbolic (default) or neural." },
    },
    ["file_id", "instrument"],
  ),
  tool(
    "breakdown",
    "The beat breakdown of a file: the latest one (sections as measured facts with hedges, and what it still needs) when it exists and the report has not been edited since; otherwise it queues the job, which also queues stems and per-stem analysis when they are missing. Composed from report fields only; a null field is reported as not measured, never filled in.",
    { file_id: uuid("The file"), refresh: { type: "boolean", description: "Compose a new version even when one exists." } },
    ["file_id"],
  ),
  tool(
    "compare",
    "Compare two files side by side (\"my beat vs the reference\"): the latest comparison's deltas when there is one, otherwise it queues the job. Both files must be analyzed. Deltas are measured differences with hedges, never judgments.",
    { file_a_id: uuid("The first file (usually mine)"), file_b_id: uuid("The second file (usually the reference)") },
    ["file_a_id", "file_b_id"],
  ),
  tool(
    "search",
    "Hybrid search of the producer's own library: structured filters (bpm, key, kind, drums, loop-based) parsed from the query plus a CLAP text embedding of the descriptive words, or nearest neighbours of the open file for \"like this\". Returns the files with the report fields that matched, ranked by similarity, and says when text search fell back to filters. It searches only this producer's library, never the internet and never other users.",
    { query: { type: "string", description: "As the producer would type it: \"something dusty in F minor around 85 with horns, no drums\"." }, limit: { type: "integer", minimum: 1, maximum: 50 } },
    ["query"],
  ),
  tool(
    "web_search",
    "Search the web for what a producer would look up: who produced a record, what it sampled, what sampled it, gear, interviews, technique. Returns titles, snippets and URLs; every result is a citation and world facts are stated only from them. It returns no media, never downloads anything, and counts against the daily allowance.",
    { query: { type: "string", description: "The search query." } },
    ["query"],
  ),
  tool(
    "fetch_page",
    "Read one web page for citation: its title and readable text (headings and paragraphs, capped at 40k characters). Before making any request it refuses media platforms (YouTube, SoundCloud, Spotify, Apple Music, Tidal, Deezer, Mixcloud, Audiomack, Bandcamp), download and stream paths, and media file types; it respects robots.txt; and afterwards it refuses anything that is not text, HTML or JSON. It cannot fetch audio or video and there is no way to turn a URL into a library file.",
    { url: { type: "string", description: "An http(s) URL of a page." } },
    ["url"],
  ),
  tool(
    "identify_context",
    "Run the web searches a producer would run for a file, from its title and artist (or a filename shaped \"Artist - Title\"): credits, sample source, who sampled it, interviews, gear. Returns findings (one sentence each, with a citation) grouped by kind, and says when the file is not identified. It never fingerprints the audio against any catalog and never fetches media; up to five searches, counted against the daily allowance.",
    { file_id: uuid("The file") },
    ["file_id"],
  ),
  tool(
    "set_edit",
    "Apply one user edit to a file's report through the same merge the header strip uses, and log a corrections row with the analyzed value and the correction. Exactly one value field applies: `number` for tempo_bpm, downbeat_phase and first_downbeat_s, `text` for meter, `key` for key, `section_labels` for section_labels. Never overwrites the analyzed value itself.",
    {
      file_id: uuid("The file"),
      field: { type: "string", enum: [...EDIT_FIELDS] },
      value: {
        type: "object",
        properties: {
          number: { type: "number", description: "tempo_bpm (BPM), downbeat_phase (0-15), first_downbeat_s (seconds)." },
          text: { type: "string", description: "meter, e.g. \"4/4\"." },
          key: keySchema,
          section_labels: {
            type: "array",
            description: "section_labels: each section's index and its new label.",
            items: { type: "object", properties: { index: { type: "integer", minimum: 0 }, label: { type: "string" } }, required: ["index", "label"], additionalProperties: false },
          },
        },
        additionalProperties: false,
      },
    },
    ["file_id", "field", "value"],
  ),
  tool(
    "embed",
    "Queue the CLAP embedding job for a file (GPU) so it takes part in text and similarity search. Returns the job. It never changes the file or its report, only adds the embedding row.",
    { file_id: uuid("The file") },
    ["file_id"],
  ),
  // --- the surfaces that live in the producer's browser (lib/chat/surfaces.ts) ---
  tool(
    "session_control",
    "Move the controls of the producer's open session: transport and locators, the arrangement, the rack, a lane's EQ, filters and tuning, the keyboard instrument, the panel. Each step is one sentence in the session's own vocabulary, which the session block of the context lists in full — say them exactly like that. Every step runs on the same control the mouse moves, so the producer sees it and can undo it; the result gives the line each control says, and those are the words to answer in. It states no fact about audio, and a step it does not recognise is refused with the vocabulary rather than guessed at.",
    {
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        description: "One control per step, in order, e.g. \"solo the drums\", \"loop bars 9 to 16\", \"keep it\".",
        items: { type: "string" },
      },
    },
    ["steps"],
  ),
  tool(
    "read_session",
    "Read the open session in detail: the whole song, or one bar of it, or one lane with every region's lineage — which record, which bars of it, what was done to it, which separator made it. Derived from the arrangement, so it never invents a bar for a session with no measured tempo.",
    {
      bar: { type: "integer", minimum: 1, maximum: 9999, description: "One bar of the song." },
      track: { type: "string", description: "One lane, by the name on it." },
    },
    [],
  ),
  tool(
    "export_song",
    "Queue the render of the open session as a DAW-importable bundle: one stem per lane across the whole song, sample-aligned, a tempo map, and a README saying which record each lane came from and what was done to it. Returns the job; the zip lands when it finishes and only this producer can download it. It renders what is on the timeline and nothing else.",
    {
      format: { type: "string", enum: [...EXPORT_FORMATS], description: "Default flac." },
      include_muted: { type: "boolean", description: "Render muted lanes too; by default they are held back and named." },
    },
    [],
  ),
  tool(
    "batch",
    `Run up to ${BATCH_MAX_OPERATIONS} operations in one call (\"separate stems on all of these\"): each names a tool and carries that tool's input as a JSON object string. They run in order. With more than ${BATCH_GPU_CONFIRM} GPU operations (separate_stems, revoice, embed) it does not run: it returns a confirmation with the count and an estimate, and runs only when called again with confirmed=true after the producer agreed. A batch cannot contain a batch.`,
    {
      operations: {
        type: "array",
        minItems: 1,
        maxItems: BATCH_MAX_OPERATIONS,
        items: {
          type: "object",
          properties: {
            tool: { type: "string", description: "e.g. separate_stems." },
            input_json: { type: "string", description: "That tool's input as a JSON object string." },
          },
          required: ["tool", "input_json"],
          additionalProperties: false,
        },
      },
      confirmed: { type: "boolean", description: "True only after the producer agreed to the cost shown." },
    },
    ["operations"],
  ),
];

export const TOOL_NAMES: readonly string[] = CHAT_TOOLS.map((t) => t.name);
