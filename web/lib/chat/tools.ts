// The chat's tools (BUILD_PACKET section 14), as strict Anthropic tool
// definitions. Every description says what the tool returns and what it
// never does; the schemas are the contract lib/chat/handlers.ts validates
// against again with zod before touching anything.

import type Anthropic from "@anthropic-ai/sdk";
import { REPORT_SECTIONS } from "@/lib/types/report";

const uuid = (what: string) => ({ type: "string", description: `${what} (a UUID from the library or the conversation context).` });

const keySchema = {
  type: "object",
  description: "A key in the report's spelling: tonic uses sharps (Bb is A#, Eb is D#).",
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

export const STEM_MODELS = ["htdemucs_ft", "htdemucs_6s", "bs_roformer"] as const;
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
    "Read the effective analysis report of one file in the library (user edits resolved over analyzed values): the vitals (tempo, key, meter, downbeats, feel) with confidence, the sections, a per-section drum pattern summary in producer terms, sample use, chords, instrumentation, loudness, spectral and effects estimates, and tags. Every value carries its confidence and its hedge word; a section that has not been analyzed reads \"not analyzed yet\" and is listed under not_analyzed. Pass `sections` to get only some of them (the vitals always come). This is the only source of musical facts about audio; it never listens to the audio itself, never guesses, and never invents a value for a null section.",
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
    "Return the effective report of one file formatted for narration: one line per measured fact, in producer language (step names like \"the and of three\", conventional key spellings), with the hedge word for its confidence band attached to every value (\"likely\", \"roughly\", \"I can't tell\") and \"not analyzed yet\" for every section that has not run. Use it when the user asks what a file is or how it was made. It never returns anything that is not in the report and never fills a null section.",
    { file_id: uuid("The file") },
    ["file_id"],
  ),
  tool(
    "find_loops",
    "Rank loop candidates on a file's beat grid (the loop finder). Returns the loops already found for the file when they exist; with refresh=true, or when there are none, it queues the finder job and returns the job so the loops arrive on the surface when it finishes. Needs an analyzed file (status ready). It never edits audio.",
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
    "Create a loop region on a file from a start and end time in seconds (a user-placed loop, editable on the surface). Returns the loop row. It does not render audio; call render_loop for a WAV.",
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
    "Queue the seamless render of a loop (zero-crossing snap, 12 ms equal-power tail crossfade) as a 24-bit WAV that becomes a library entry. Returns the job. It never changes the loop's edges.",
    { loop_id: uuid("The loop") },
    ["loop_id"],
  ),
  tool(
    "separate_stems",
    "Queue stem separation for a file (GPU): drums, bass, vocals and other with htdemucs_ft (default), plus guitar and piano with htdemucs_6s, or bs_roformer. Each stem becomes its own library file with its own analysis. Returns the job; the stems arrive when it finishes. Never runs on audio from a link, only on library files.",
    { file_id: uuid("The file"), model: { type: "string", enum: [...STEM_MODELS], description: "Separation model; default htdemucs_ft." } },
    ["file_id"],
  ),
  tool(
    "chop",
    "Queue chopping a file into slices that become library files and pads: transients (onsets, ranked by strength), grid (equal slices across a bar range), or manual (marker times). Returns the job. It never generates new material.",
    {
      file_id: uuid("The file"),
      mode: { type: "string", enum: [...CHOP_MODES] },
      params: {
        type: "object",
        description: "Mode options: count (transients cap or grid divisions), min_gap_ms (transients), start_bar and end_bar (grid, 0-based), divisions (grid), markers_s (manual, seconds).",
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
    "Queue MIDI extraction from a file: melody (Basic Pitch on the stem), drums (hit classification with the measured offsets kept as timing), chords (from the chord segments), or groove (the measured swing and offsets as a template). Returns the job; the MIDI row arrives when it finishes. It transcribes only what was measured.",
    { file_id: uuid("The file"), kind: { type: "string", enum: [...MIDI_KINDS] } },
    ["file_id", "kind"],
  ),
  tool(
    "layer",
    "Combine material from different library files into one layer (\"the drums from this over the sample from that\"): creates the layer and its items, then queues the render, which tempo-matches by time-stretch and key-matches by pitch-shift to the target (default: the first item's effective values), aligns downbeats and mixes with per-item gain and offset. Returns the layer and the job; the render becomes a library file and every lane stays editable. Every item must be a library file; it never generates a lane from nothing and never takes audio from a link.",
    {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 8,
        items: {
          type: "object",
          properties: {
            file_id: uuid("A library file"),
            gain_db: { type: "number", minimum: -60, maximum: 12, description: "Lane gain in dB; default 0." },
            offset_s: { type: "number", minimum: -600, maximum: 600, description: "Lane offset in seconds; default 0." },
          },
          required: ["file_id"],
          additionalProperties: false,
        },
      },
      target_tempo: { type: "number", minimum: 20, maximum: 400, description: "BPM to match everything to; default the first item's." },
      target_key: keySchema,
      name: { type: "string", description: "Optional layer name." },
    },
    ["items"],
  ),
  tool(
    "revoice",
    "Queue re-voicing a part in another instrument (GPU): symbolic (default) extracts MIDI first and renders it through a sampled instrument, so the notes come back editable; neural is audio-to-audio and experimental. Instruments: piano, rhodes, electric_guitar, acoustic_guitar, upright_bass, strings, brass, synth and the others the compute image lists. Returns the job. The source is always the user's file; it never creates a part from nothing.",
    {
      file_id: uuid("The file or stem to re-voice"),
      instrument: { type: "string", description: "Target instrument id, snake_case." },
      path: { type: "string", enum: [...REVOICE_PATHS], description: "symbolic (default) or neural." },
    },
    ["file_id", "instrument"],
  ),
  tool(
    "breakdown",
    "The beat breakdown of a file: returns the latest breakdown (its sections as measured facts with hedges, and what it still needs) when one exists and the report has not been edited since; otherwise queues the breakdown job, which also queues stems and per-stem analysis when they are missing, and returns the job. Composed from report fields only; a null field is reported as not measured, never filled in.",
    { file_id: uuid("The file"), refresh: { type: "boolean", description: "Compose a new version even when one exists." } },
    ["file_id"],
  ),
  tool(
    "compare",
    "Compare two files side by side (\"my beat vs the reference\"): returns the latest comparison's deltas when one exists, otherwise queues the comparison job and returns it. Both files must be analyzed. Deltas are measured differences with hedges, never judgments.",
    { file_a_id: uuid("The first file (usually mine)"), file_b_id: uuid("The second file (usually the reference)") },
    ["file_a_id", "file_b_id"],
  ),
  tool(
    "search",
    "Hybrid search of the user's own library: structured filters (bpm, key, kind, drums, loop-based) parsed from the query plus a CLAP text embedding of the descriptive words, or nearest neighbours of the open file for \"like this\". Returns the matching files with the report fields that matched, ranked by similarity, and says when text search fell back to filters because the embed job or compute is missing. It searches only this user's library, never the internet and never other users.",
    { query: { type: "string", description: "The search as the producer would type it, e.g. \"something dusty in F minor around 85 with horns, no drums\"." }, limit: { type: "integer", minimum: 1, maximum: 50 } },
    ["query"],
  ),
  tool(
    "web_search",
    "Search the web for information a producer would look up: who produced a record, what it sampled, what sampled it, gear, interviews, technique. Returns titles, snippets and URLs; every result is a citation and world facts are stated only from them. It returns no media, never downloads anything, and is counted against the daily search allowance.",
    { query: { type: "string", description: "The search query." } },
    ["query"],
  ),
  tool(
    "fetch_page",
    "Read one web page for citation: returns its title and readable text (headings and paragraphs, capped at 40k characters). It refuses, before making any request, links to media platforms (YouTube, SoundCloud, Spotify, Apple Music, Tidal, Deezer, Mixcloud, Audiomack, Bandcamp downloads and streams), download and stream paths, and media file types; it respects robots.txt; and after the response it refuses anything that is not text, HTML or JSON. It cannot fetch audio or video and there is no way to turn a URL into a library file.",
    { url: { type: "string", description: "An http(s) URL of a page (an article, a credits page, an interview)." } },
    ["url"],
  ),
  tool(
    "identify_context",
    "Build and run the web searches a producer would run for a file, from its title and artist (or a filename shaped \"Artist - Title\"): producer credits, sample source, who sampled it, interviews about the production, gear. Returns findings (one sentence each, with a citation) grouped by kind, and says when the file is not identified. It never fingerprints the audio against any catalog and never fetches media; up to five searches, counted against the daily allowance.",
    { file_id: uuid("The file") },
    ["file_id"],
  ),
  tool(
    "set_edit",
    "Apply one user edit to a file's report (tempo_bpm, downbeat_phase, first_downbeat_s, key, meter, section_labels) through the same merge the header strip uses, and log a corrections row with the analyzed value and the correction. Only one of the value fields applies: `number` for tempo_bpm, downbeat_phase and first_downbeat_s; `text` for meter (\"4/4\"); `key` for key; `section_labels` for section_labels. Returns the field, the predicted value and the corrected value. Never overwrites the analyzed value itself.",
    {
      file_id: uuid("The file"),
      field: { type: "string", enum: [...EDIT_FIELDS] },
      value: {
        type: "object",
        properties: {
          number: { type: "number", description: "For tempo_bpm (BPM), downbeat_phase (0-15) and first_downbeat_s (seconds)." },
          text: { type: "string", description: "For meter, e.g. \"4/4\", \"3/4\", \"6/8\"." },
          key: keySchema,
          section_labels: {
            type: "array",
            description: "For section_labels: the section index and its new label.",
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
  tool(
    "batch",
    `Run up to ${BATCH_MAX_OPERATIONS} operations across files in one call (\"separate stems on all of these\"): each operation names a tool and carries that tool's input as a JSON object string. Runs them in order and returns each result. When more than ${BATCH_GPU_CONFIRM} of them are GPU operations (separate_stems, revoice, embed) it does not run; it returns a confirmation request with the count and an estimate, and runs only when called again with confirmed=true after the user has agreed. A batch cannot contain a batch.`,
    {
      operations: {
        type: "array",
        minItems: 1,
        maxItems: BATCH_MAX_OPERATIONS,
        items: {
          type: "object",
          properties: {
            tool: { type: "string", description: "The tool to run, e.g. separate_stems." },
            input_json: { type: "string", description: "That tool's input, as a JSON object string, e.g. {\"file_id\": \"...\"}." },
          },
          required: ["tool", "input_json"],
          additionalProperties: false,
        },
      },
      confirmed: { type: "boolean", description: "True only after the user agreed to the GPU cost shown in the confirmation." },
    },
    ["operations"],
  ),
];

export const TOOL_NAMES: readonly string[] = CHAT_TOOLS.map((t) => t.name);
