# BUILD_PACKET.md

---

## Part I: The Goal

### What we're building

A hub for producers. The AI platform for people who make beats, for musicians who work with samples, for anyone whose creative process involves taking recorded sound and turning it into something else. It exists to make that process faster, cleaner, and better understood, without taking the creative act away from the person doing it.

Producers spend most of their time on things that aren't music. Hunting for the loop point. Fighting the warp markers. Digging through four hundred gigabytes of unsorted folders for the one Rhodes chop they know they have. Trying to figure out, by ear and by guessing, how a record they love was put together. Re-cutting a drum break for the tenth time. Looking up who produced something, what it sampled, what gear was on it. None of that is the music. All of it stands between the producer and the music.

This platform takes that layer away. You bring your material. It measures it, remembers it, and does the mechanical work at the speed of a sentence. You keep the decisions. You keep the taste. You keep the beat.

### What makes it different

There are three things it's not, and each one is a category someone else already occupies.

**It's not an AI music generator.** Those make the music. Producers don't want that, and the ones who'd use it aren't producers. Everything this platform produces is derived from something the user brought. Layering the drums from one record over the sample from another is in. Re-voicing a piano line as a guitar is in. Typing "make me a boom-bap beat" and getting one is out, forever.

**It's not a DAW.** DAWs are where beats get finished. This is where material gets prepared, understood, and found. It hands off to the DAW cleanly, as named WAVs, MIDI, and kits, and never tries to replace it.

**It's not a chatbot with opinions about music.** Generic AI assistants guess. Ask them the BPM of a track and they'll make a number up. This platform never listens with a language model. It listens with signal processing and pretrained audio models, produces measured results with a confidence on every value, and the language layer only ever speaks from those measurements or from web sources it can cite. When it doesn't know, it says so.

What it is, in one sentence: your sample library, and it knows what's in everything, and it'll do the work if you ask.

### Who it's for

The producer who flips soul records and wants the loop found in seconds instead of minutes. The beatmaker who isn't technical yet and wants to understand how the records they love are built, in real numbers, so they can learn. The musician with a decade of unsorted samples who wants to type what they're hearing in their head and have it come back. The person who hums drum patterns in the car and wants them to become MIDI. Anyone who'd rather spend their session making decisions than doing chores.

### How this document works

Everything below is the basis, not the boundary. The architecture, the schemas, the algorithms, and the phase plan are here so that building can start today with the decisions already made. But the platform will grow past this document, and it's supposed to. While building, Claude Code will see tools, features, and shortcuts that would help a producer's flow. Those get proposed through `docs/PROPOSALS.md` using the template in Section 20, reviewed between phases, and promoted into the plan when they fit. The test for whether a proposal fits: does it make the human's beatmaking faster, better, or more understood, without making the beat for them?

The beat breakdown (Section 11) is the feature this platform should be known for. Get it right.

---

## Part II: Principles and Decisions

### 1. Principles

These are in `CLAUDE.md` and restated here because they shape every design choice below.

1. **Nothing from nothing.** Every output is derived from audio the user brought. Transformation, combination, and re-voicing of user material are all in scope. Generation from a text prompt with no source is out.
2. **Measure, don't guess.** Every analysis value carries `method` and `confidence`. The language layer speaks musical facts only from the AnalysisReport and world facts only from cited web results.
3. **Read the internet, never download audio from it.** Search and page fetch for information are in. Audio or video bytes from any URL, stream, or platform are out, enforced in code.
4. **Every output is editable.**
5. **The library is the product.** Everything produced becomes a searchable library entry with its own analysis.
6. **User audio is private, always.**
7. **User corrections are ground truth.**
8. **Tests before DSP.**
9. **The accuracy harness gates merges.**

### 2. Decisions already made

| Decision | Choice | Why |
|---|---|---|
| Hosting shape | Next.js on Vercel + Supabase + Modal | Frontend and thin API on Vercel; auth, Postgres, storage, realtime on Supabase; all Python compute on Modal with per-second billing and GPUs on demand. |
| Analysis runtime | One Modal function per stage | Separation and neural re-voicing need a GPU for seconds. Modal scales to zero. |
| Beat tracking | `librosa` first; BeatNet behind the same interface in Phase 2 | Ship the deterministic path, upgrade without changing callers. |
| Key detection | Krumhansl-Schmuckler on chroma CQT | Deterministic, explainable, natural confidence. |
| Meter | Assume 4/4, per-file override | Correct for the target material. Detection is a proposal candidate. |
| Downbeats | Low-band onset energy phase selection over 4 phases | Cheap, usually right, always overridable. |
| Structure segmentation | Self-similarity novelty + spectral clustering (librosa `segment`) with beat-synchronous features | Standard, no model download, decent on loop-based music. |
| Stems | `audio-separator`, `htdemucs_ft` default, BS-RoFormer and `htdemucs_6s` selectable | Best open quality, model exposed to user. |
| Embeddings | CLAP for audio and text, `pgvector` HNSW | One model gives audio-to-audio and text-to-audio search. |
| Audio → MIDI | Basic Pitch on isolated stems | Open, decent, best after separation. |
| Re-voicing, first path | Symbolic: extract MIDI, render through a sampled instrument (SFZ / SF2 via FluidSynth) | Deterministic, accurate pitch, returns MIDI so notes are editable. |
| Re-voicing, second path | Neural audio-to-audio timbre transfer (DDSP-family or RAVE-family, evaluated at build time) | More expressive, less controllable. Ships after symbolic, behind the same interface, labeled as experimental. |
| Combining files | Tempo-match by time-stretch, key-match by pitch-shift, downbeat-align, per-layer gain and offset, render | A "put these together" operation, not a sequencer. |
| Web information | Search API (Brave or Tavily) + page fetch, as chat tools with citations | Reading only. No media download path exists in the codebase. |
| Loop preview | Client-side Web Audio, raw and crossfaded | Zero-latency drag feedback; server renders the canonical export with the same algorithm. |
| Uploads | Supabase Storage via tus, multi-file and folder, browser-side SHA-256 dedupe before bytes move | Libraries are tens of gigs. |
| Accuracy dataset | Public annotated datasets + logged user corrections | Nobody hand-labels. |
| Billing | Stripe, Phase 9 | Not before there's something to bill for. |

---

## Part III: Architecture

### 3. Data model (Postgres, Supabase)

All tables have `user_id uuid references auth.users` and RLS restricting every operation to `auth.uid() = user_id`. Service role bypasses RLS only from Modal result writers and admin scripts.

```
files
  id uuid pk, user_id, sha256, original_filename, storage_path,
  duration_s, sample_rate, channels, format,
  kind text ('original'|'stem'|'chop'|'loop_render'|'layer_render'|'revoice_render'),
  parent_file_id uuid null fk -> files.id,
  status text ('uploading'|'queued'|'analyzing'|'ready'|'failed'),
  analysis_version, report jsonb, peaks jsonb, created_at, updated_at
  unique (user_id, sha256)

jobs
  id uuid pk, user_id, file_id fk null, kind text
    ('analyze'|'stems'|'chop'|'midi'|'embed'|'render_loop'|'layer'|'revoice'
     |'breakdown'|'compare'|'beatbox_train'|'beatbox_transcribe'),
  status ('queued'|'running'|'done'|'failed'), params jsonb, result jsonb,
  error, modal_call_id, created_at, started_at, finished_at

loops       id, user_id, file_id, start_s, end_s, bars, score, origin ('finder'|'user'|'chat'),
            components jsonb, name, render_file_id fk null, created_at
stems       id, user_id, file_id, stem, model, stem_file_id fk, created_at
chops       id, user_id, source_file_id, start_s, end_s, index, name, chop_file_id fk, created_at
midi        id, user_id, source_file_id, kind ('melody'|'drums'|'chords'|'beatbox'|'groove'),
            storage_path, notes jsonb, created_at
layers      id, user_id, name, tempo_bpm, key jsonb, render_file_id fk null, created_at
layer_items id, layer_id fk, file_id fk, offset_s, gain_db, stretch_ratio, pitch_semitones, muted
revoices    id, user_id, source_file_id, instrument, path ('symbolic'|'neural'),
            midi_id fk null, render_file_id fk, created_at
breakdowns  id, user_id, file_id fk, version, content jsonb, web_context jsonb, created_at
comparisons id, user_id, file_a_id, file_b_id, content jsonb, created_at
embeddings  id, user_id, file_id, model, vector vector(512), created_at   -- HNSW index
tags        id, user_id, file_id, tag, source ('model'|'user'), confidence
corrections id, user_id, file_id, field, predicted jsonb, corrected jsonb, created_at
conversations id, user_id, title, created_at, updated_at
messages    id, conversation_id, role, content jsonb, tool_calls jsonb, citations jsonb, created_at
beatbox_profiles id, user_id, model_path, classes jsonb, sample_count, cv_accuracy, trained_at
```

Storage: `library/{user_id}/{sha256[:2]}/{sha256}.{ext}` for originals; `derived/{user_id}/{file_id}/...` for everything produced. Private bucket. Playback via signed URLs, 10-minute expiry, Range supported.

### 4. AnalysisReport schema

The spine. JSON Schema in `docs/analysis_report.schema.json`, Pydantic in `analysis/lockedgroove/report.py`, TypeScript types generated into `web/lib/types/report.ts`. One test asserts all three agree.

```json
{
  "schema_version": "3.0",
  "file": { "id", "sha256", "original_filename", "duration_s", "sample_rate", "channels", "format", "kind", "parent_file_id" },
  "tempo": { "bpm", "confidence", "method", "alternates_bpm": [half, double], "notes" },
  "beats": { "times_s": [], "confidence", "method", "downbeats_s": [], "downbeat_phase", "downbeat_confidence", "downbeat_method", "meter", "notes" },
  "key": { "tonic", "mode", "confidence", "method", "alternate": { "tonic", "mode", "correlation" }, "notes" },
  "chords": { "segments": [{ "start_s", "end_s", "label", "confidence" }], "method", "notes" },
  "onsets": { "times_s": [], "method", "count" },
  "groove": { "swing_pct", "timing_deviation_ms": { "mean", "std" }, "feel": "straight|swung|loose", "method", "confidence" },
  "structure": {
    "sections": [{ "start_s", "end_s", "start_bar", "bars", "label", "energy", "confidence" }],
    "loop_period_bars", "loop_period_confidence", "method", "notes"
  },
  "drums": {
    "source_estimate": "sampled_break|programmed|mixed|unknown", "source_confidence",
    "patterns": [{ "section_index", "kick": [], "snare": [], "hat": [], "other": [], "accents": [], "density_per_bar" }],
    "method", "notes"
  },
  "sample_use": {
    "is_loop_based", "chop_count_estimate", "chop_reordering_detected", "pitch_shift_semitones_estimate",
    "confidence", "method", "notes"
  },
  "instrumentation": {
    "per_section": [{ "section_index", "present": ["drums","bass","vocals","other"], "entries": [], "exits": [] }],
    "method", "confidence"
  },
  "loudness": { "integrated_lufs", "true_peak_dbtp", "loudness_range_lu", "method" },
  "spectral": { "centroid_hz_mean", "stereo_width", "low_high_ratio_db", "method" },
  "effects_estimates": {
    "reverb_tail_s": { "value", "confidence", "method", "notes": "rough" },
    "sidechain_ducking": { "detected", "depth_db", "confidence", "method" },
    "saturation_above_hz": { "value", "confidence", "method" }
  },
  "tags": [{ "tag", "confidence", "source" }],
  "user_edits": { "tempo_bpm", "downbeat_phase", "first_downbeat_s", "key", "meter", "section_labels", "edited_at" }
}
```

Sections that haven't run are `null`. `effective(report)` resolves `user_edits` over analyzed values; every consumer uses it. Stems and chops get their own full report, so `drums` and `instrumentation` on an original can also be derived from its stem children where available (more accurate) and the method field says which.

**Confidence derivations**, each documented in the function docstring:
- `tempo`: strongest tempogram peak over second, squashed to [0,1].
- `beats`: fraction of predicted beats within ±30 ms of an onset.
- `downbeat`: normalized margin between winning phase and runner-up.
- `key`: normalized gap between best and second-best profile correlation.
- `chords`: per-segment posterior.
- `groove`: inverse of onset-timing variance once beats are trusted.
- `structure`: novelty peak prominence for boundaries; silhouette score for labels.
- `drums.source_estimate`: programmed drums have near-zero timing variance and near-identical hit spectra; sampled breaks drift and vary. Confidence from the separation of those two measures.
- `sample_use`: self-similarity repetition strength for `is_loop_based`; count of distinct short repeated segments for chops; cross-correlation peak for pitch shift when a source is in the library.
- `effects_estimates`: capped at 0.6 by design so the narration always hedges.

### 5. Job system

1. Client uploads via tus. On completion, calls `POST /api/files/complete` with storage path and sha256.
2. Server inserts `files` (`queued`) and a `jobs` row, invokes the Modal function asynchronously.
3. Modal downloads with a signed URL, runs, writes results with the service role.
4. Supabase Realtime pushes the row change; client updates.
5. Every job kind follows this pattern. Failures write `jobs.error` and surface a retry.

Every Modal function is idempotent on `(file_id, analysis_version)`. Bumping `analysis_version` triggers lazy re-analysis on next open.

---

## Part IV: Capabilities

### 6. Analysis stages

All in `analysis/lockedgroove/analysis/`. Pure functions `(y, sr, context) -> Section`. Each has a synthetic-fixture test.

| Stage | Method | Test |
|---|---|---|
| `tempo.py` | `librosa.beat.beat_track` + tempogram ratio | 90 BPM click → 90±1, conf>0.9; 180 → 180 or 90, truth in alternates |
| `beats.py` | `beat_track(start_bpm=hint)`; downbeat phase from low-passed onset strength | Kick-on-1 synthetic → phase recovered |
| `key.py` | mean `chroma_cqt` × 24 Krumhansl profiles | C major arpeggio → C major; A minor → alternate covers |
| `chords.py` | chroma templates per beat, Viterbi smoothing, on `other` stem when present | 4-chord synthetic recovered |
| `onsets.py` | `onset_detect(backtrack=True)` | 8 clicks → 8 onsets ±10 ms |
| `groove.py` | onset deviation from nearest 16th; swing from off-beat 8th ratio | straight vs 62% → 50 vs 62 ±3 |
| `structure.py` | beat-synchronous MFCC+chroma, recurrence matrix, novelty for boundaries, spectral clustering for labels; loop period from the strongest lag in the recurrence | synthetic ABAB with 4-bar loop → 4 boundaries, period 4 |
| `drums.py` | on the `drums` stem: onset detection, hit classification (kick/snare/hat/other) by centroid, low-band energy, decay; per-section pattern on the effective 16th grid with velocity; source estimate from timing variance and hit-spectrum similarity | synthetic programmed pattern → exact grid, `programmed`; same pattern with 8 ms jitter and spectral variation → `sampled_break` |
| `sampleuse.py` | recurrence lag analysis for loop period; short-segment repetition with reordering detection for chops; pitch-shift estimate by cross-correlation against library candidates flagged as possible sources | synthetic 4-bar loop chopped into 4 and reordered → `is_loop_based`, `chop_count_estimate=4`, `reordering=true` |
| `instrumentation.py` | per-stem RMS per section → present/absent with entry and exit bars | synthetic with bass entering at bar 9 → entry at 9 |
| `loudness.py` | `pyloudnorm` BS.1770-4 | −20 dBFS sine → LUFS ±1 |
| `spectral.py` | centroid, mid/side width, low/high ratio | mono → width 0 |
| `effects.py` | reverb: decay slope after isolated transients; sidechain: envelope anticorrelation with kick; saturation: harmonic energy | synthetic 1.5 s reverb → 1.5 ±0.4 |
| `tags.py` | CLAP zero-shot against ~120 producer terms | Rhodes sample → "rhodes" in top 5 |

### 7. Loop finder and renderer

`loops/finder.py`: `find_loops(y, sr, report, bars=[1,2,4,8], top_k=12)`
- Candidates: every `[downbeat_i, downbeat_(i+n))` from `effective(report)`.
- Score: `seam` 0.40 (mel-spectrogram cosine between last 100 ms and first 100 ms, plus RMS continuity), `stability` 0.25 (1 − normalized variance of per-beat RMS), `novelty` 0.25 (penalize interior structure boundaries), `onset_lock` 0.10 (onset within ±20 ms of start, decaying to 0 at ±80 ms). Weights are constants; tune only against the harness.
- Dedupe near-identical candidates and contiguous repeats.
- Return `components` so UI and chat can say why.

`loops/render.py`: `render_loop(y_stereo, sr, start_s, end_s, crossfade_ms=12, snap_zero_crossing=True)`
- Snap edges to nearest zero crossing within ±2 ms, never further.
- Tail crossfade: equal-power crossfade of the audio after `end` into the head of the loop, so the natural tail wraps. Fallback to self-crossfade at end of file.
- Export 24-bit WAV named `{stem}_{bpm}bpm_{key}_{bars}bar.wav`.
- Ported to `web/lib/audio/renderLoop.ts` for client preview; one shared test vector asserted by both.

### 8. Stems, chops, MIDI

**Stems** (`stems/separate.py`, GPU): `audio-separator`, default `htdemucs_ft`; `htdemucs_6s` for guitar/piano; BS-RoFormer selectable. Each stem becomes a `files` row with `parent_file_id` and gets its own `analyze` job.

**Chops** (`chops/chop.py`): `transients` (onsets, 40 ms min gap, cap N ranked by strength), `grid` (N equal slices across a bar range), `manual` (user markers). 3 ms fades. Each chop becomes a `files` row, `kind='chop'`.

**MIDI** (`chops/midi.py`): melody via Basic Pitch on a stem; drums via `drums.py` hit classification with **measured offsets preserved as MIDI timing**; chords from `chords`; groove template from `groove`. Export bundle: WAVs + `.mid` + `manifest.json` zipped.

**Pads**: 16 pads bound to chops or stems; tap plays; keyboard 1–8 Q–I; record mode captures hits with wall-clock timing against the effective grid → MIDI with real offsets. Audition and capture surface. No step sequencer, no arrangement.

### 9. Combine: layering material from different files

The operation behind "the drums from this beat over top of that beat."

`combine/align.py`:
- Given a target tempo and key (default: the first item's effective values), compute for each item the stretch ratio (`target_bpm / item_bpm`) and pitch shift in semitones (nearest key match, or none if the item is drums / non-tonal by tags).
- Time-stretch with `signalsmith-stretch` or Rubber Band. Pitch-shift the same way. Both preserve transients in the default mode; the user can choose a mode.
- Align first downbeats. Expose `offset_s` per item for the user to nudge in bars, beats, 16ths, or free.

`combine/layer.py`:
- Sum items with per-item gain, optional simple high-pass or low-pass per item (so drums and sample don't fight in the low end), and a soft limiter on the sum.
- Render to a `files` row, `kind='layer_render'`, which gets its own analysis and is searchable.
- The `layers` and `layer_items` rows are the editable state. Re-render is cheap.

Working surface: a stacked lane view, one lane per item, each lane draggable for offset, with gain, stretch mode, pitch, mute. Not a timeline editor. No automation, no clips, no arrangement. Just "these together, like this."

Tests: two synthetic loops at 88 and 96 BPM combine to a render whose beat grid matches 88 with confidence >0.9; a pitched sample and its drums combine with no pitch shift applied to the drums lane.

### 10. Re-voice: the same part in a different instrument

The operation behind "this piano line, but guitar."

**Symbolic path** (`revoice/symbolic.py`), ships first:
1. Isolate the source part (the stem, or a chop).
2. Extract MIDI with Basic Pitch. Return the MIDI to the user immediately as a piano roll; this is the editable object.
3. Render the MIDI through a sampled instrument. Ship with a curated set of open instruments (SFZ / SF2: acoustic and electric guitar, Rhodes, upright piano, upright bass, strings, brass, a few synths), rendered with FluidSynth or an SFZ engine on Modal.
4. Optional: apply the source's measured groove offsets to the rendered notes so it keeps the feel.
5. Result becomes a `files` row, `kind='revoice_render'`, linked to the MIDI and the source.

Accuracy note for the chat: the symbolic path is only as good as the transcription. Polyphonic sources will have wrong or missing notes. The MIDI is shown so the user fixes them, and re-render is one click.

**Neural path** (`revoice/neural.py`), ships later, labeled experimental:
- Audio-to-audio timbre transfer (DDSP-family for monophonic sources, RAVE-family or a current open model for broader timbre; evaluate at build time and record the choice in PROPOSALS).
- Same interface: source file + target instrument → render. No MIDI returned, so the editability is via re-running with different settings, and the chat says so.
- Never used for "generate a guitar part from nothing." The source is always the user's audio.

### 11. Beat breakdown: the centerpiece

The feature this platform should be known for. When a producer asks "how was this made," the answer should be the one a mentor with perfect ears and a spectrum analyzer would give: specific, honest about uncertainty, in producer language, and useful for actually doing it yourself.

**What a breakdown contains**, in the order a producer reads it. Every value links to its measurement and carries its confidence label in the UI.

1. **The vitals.** BPM (with the alternate if confidence is low), key and mode (with the alternate), meter, feel (straight, swung with percentage, or loose with the measured deviation).
2. **The structure.** Sections with bar counts and labels (intro, verse, hook, bridge, outro, or A/B/C if labels are uncertain), where energy rises and drops, and the loop period: "the whole thing sits on a 4-bar loop; the hook adds a second layer at bar 33."
3. **The sample.** Is it loop-based? How many chops, and are they reordered? Was it pitched, and by how much, if a possible source is in the library or was identified? Which bars carry the sample and which don't. "Four chops of a 2-bar phrase, played in the order 1-2-1-3, pitched up a semitone."
4. **The drums.** Sampled break or programmed, with the reasoning. The pattern per section on a 16th grid with accents: kick placements, snare placements, hat density and openness, ghost notes if detected. Swing. Where the drums drop out. Whether they're layered (two kick spectra detected). "Kick on the one and the and-of-three, snare on two and four with a ghost before four, hats on 8ths swung 58 percent, break-sourced based on timing drift."
5. **The bass.** Present or not, from the bass stem. Root motion against the chord segments. Whether it follows the sample or moves independently. Ducking against the kick, with depth.
6. **The harmony.** Chord progression per section, from the `other` stem. Relationship between the sample's key and the song's key.
7. **The melodic layer.** From the `other` and `vocals` stems: presence, range, contour, whether it's a chop (vocal sample) or a performance, extracted MIDI available.
8. **The arrangement.** Instrument entries and exits per section from the instrumentation stage. "Bass enters at bar 9. Hats drop for the last bar of every 8. Vocal chop appears only in the hook."
9. **The mix.** Integrated loudness, dynamic range, low/high balance, stereo width, sidechain detected or not, reverb estimate on the snare, saturation estimate. All labeled rough where they're rough.
10. **The context**, from the web when the user identifies the track or the metadata does: who produced it, what it sampled, what has sampled it, gear or technique the producer has discussed, with citations. If the user hasn't identified the track and metadata doesn't, this section says "identify the track and I can add what's been documented about it."
11. **The recipe.** A short synthesis in producer terms of how you'd approach recreating it, derived only from the above. "Find a 2-bar soul loop around 88 in F minor. Chop it in four. Program a swung boom-bap pattern with the kick pushed to the and-of-three. Low-pass the loop under a live-feeling break. Duck the sample 3 dB on the kick."

**How it's built** (`breakdown/compose.py`):
- Requires: full `analyze`, `stems`, and per-stem `analyze` to have run. Queues them if missing and streams the breakdown as sections become available.
- Composes the `content` from report fields only. A field that's `null` produces a line saying it wasn't measured and offering to run it. A field with confidence under a threshold gets an explicit hedge word chosen by band: ≥0.8 none, 0.6–0.8 "likely," 0.4–0.6 "roughly" or "possibly," under 0.4 "I can't tell."
- Calls the web information tools (Section 13) for the context section only when the track is identified.
- Sends the composed structure to the language layer for narration with the grounding contract (Section 14). The narration cannot introduce a fact not in the structure. Tested with adversarial fixtures.
- Stored in `breakdowns` with a version; re-runs after user edits produce a new version.

**Compare** (`breakdown/compare.py`): two files, same structure, side by side, with deltas. The most valuable form of this is "my beat vs the reference": mine is 3 dB heavier in the low end, my hats are twice as dense, my swing is 52 against their 58, my sample sits in the same range as my bass and theirs doesn't. This is how a producer who isn't skilled yet gets skilled.

**Acceptance**: on a known loop-based hip-hop record, the breakdown's vitals, structure, drum pattern, and sample-use sections are correct on inspection by the owner, every uncertain value is hedged, nothing is invented, and the recipe is something a producer could follow.

### 12. Search

- CLAP embeddings for every file, stem, chop, loop render, layer render, and re-voice render. HNSW index.
- Similarity: nearest neighbors across the user's library.
- Text: CLAP text embedding → neighbors, combined with structured filters parsed from the query.
- Hybrid parser: the chat's search tool sends the query to Claude with a tool schema returning `{text_query, bpm_min, bpm_max, key, mode, kind, tags, has_drums, is_loop_based}`. "Something dusty in F minor around 85 with horns, no drums" resolves fully.
- Results show the report fields that matched.

### 13. Web information

Chat tools, not ingest paths:

| Tool | Does | Never does |
|---|---|---|
| `web_search(query)` | Search API, returns titles, snippets, URLs | Return media |
| `fetch_page(url)` | Fetches and extracts readable text for citation, within robots and terms | Fetch audio, video, or anything from a media CDN; the fetcher has an allowlist of content types |
| `identify_context(file_id)` | Uses filename, metadata, and user-supplied title/artist to build search queries: producer credits, sample sources, what-sampled-this, interviews, gear | Fingerprint against any external catalog |

Use cases this unlocks: "who produced this," "what did this sample," "show me songs that flipped this same sample," "what did he say about how he made it," "what's the standard way to chop a break like this." All answered with citations, all clearly separated from measured facts in the narration.

The rule, in code: the fetch layer rejects any response whose content type is audio or video, any URL matching known media hosts' download or stream paths, and any request originating from an ingest surface. There is no code path from a URL to a `files` row.

### 14. Chat and command layer

`POST /api/chat` streams from the Anthropic API with tool use. System prompt embeds the principles and the effective reports of any files in context.

| Tool | Does |
|---|---|
| `get_report(file_id)` | Effective report. The only way the model learns anything about audio. |
| `find_loops`, `create_loop`, `render_loop` | Loop operations. |
| `separate_stems(file_id, model?)` | Queues separation. |
| `chop(file_id, mode, params)` | Queues chop. |
| `extract_midi(file_id, kind)` | Queues MIDI. |
| `layer(items[], target_tempo?, target_key?)` | Creates a layer and queues render. |
| `revoice(file_id, instrument, path?)` | Queues re-voice. |
| `breakdown(file_id)` | Queues or returns the breakdown. |
| `compare(file_a, file_b)` | Queues or returns the comparison. |
| `search(query)` | Hybrid library search. |
| `web_search`, `fetch_page`, `identify_context` | Web information with citations. |
| `set_edit(file_id, field, value)` | Applies an edit, logs a correction. |
| `explain(file_id)` | Report formatted for narration with hedges attached. |
| `batch(operations[])` | Runs a list across many files. |

**Grounding contract**, tested: given `chords: null`, a chord question yields "not analyzed yet, want me to?" and never a progression. Given a web search with no results, a world-fact question yields "I couldn't find that" and never a guess. Given `effects_estimates.reverb_tail_s.confidence=0.4`, narration says "roughly." Every world fact in a reply carries a citation; every musical fact traces to a report field.

**Every result is an object on the working surface.** A loop is a region. Chops are pads. Stems are library rows. A layer is stacked lanes. A re-voice is a piano roll plus audio. A breakdown is a document with links from every number to the waveform position it came from.

### 15. Beatbox → MIDI

Per-user model, because vocal percussion varies too much across people for a general one.

- Enrollment: ~20 examples each of the user's kick, snare, hat via MediaRecorder. Onset-segment, extract MFCCs, centroid, ZCR, low-band ratio, decay; train a small classifier. Store per user. Report cross-validated accuracy; refuse to enable under 85%.
- Transcription: record a pattern, onset-detect with 60 ms minimum gap, classify, place on the effective grid of a chosen file or a free tempo, preserve measured offsets, emit MIDI plus an editable step view.
- Corrections feed the next enrollment.

---

## Part V: Quality, Interface, Plan

### 16. Accuracy harness, without hand-labeling

- `scripts/fetch_public_datasets.py`: GiantSteps Tempo and Key; Ballroom; any set with redistributable audio and beat, downbeat, key, or structure labels. Logged sources.
- `corrections` table: every user edit logs prediction and fix. Grows for free, on material users care about, never used for anything else.
- `scripts/eval_accuracy.py`: scores the pipeline on both, per dataset. Runs in CI on any PR touching `analysis/`. Fails on regression.

| Metric | Definition | Initial gate |
|---|---|---|
| BPM exact | ≤ 2 BPM off | ≥ 80% |
| BPM octave-tolerant | exact, or true in alternates | ≥ 95% |
| Key exact | tonic and mode | ≥ 65% |
| Key relative-tolerant | exact, or alternate matches | ≥ 85% |
| Downbeat | within ±60 ms mod bar length | ≥ 75% |
| Structure boundaries | F-measure at ±1 bar, where labels exist | ≥ 0.6 |

Gates rise as neural tracking and the corrections set come online.

### 17. Frontend

Next.js App Router. One workspace, three panes.

**Left: Library.** Upload zone (files or folders, tus, browser-side hash dedupe, per-file progress). File list grouped by kind, each row with BPM and key confidence dots, status, live job progress. Search box runs hybrid search.

**Center: Working surface.** For the open file: waveform with beat grid, downbeat emphasis, and section boundaries; header strip with BPM (editable, halve/double, tap), key (primary and alternate), first downbeat (click to set), meter override. Tabs: **Loops**, **Stems**, **Chops** (with pads and record-to-MIDI), **Layers** (stacked lanes), **Re-voice** (piano roll plus render), **Breakdown** (the document, every number linked to the waveform), **Compare** (pick a second file). Keyboard: space, `[` `]`, 1–8 Q–I.

**Right: Chat.** Tool calls render as cards. Web results render with citations. Results push to the surface. Conversations persist.

**Design direction:** dense, quiet, dark, one accent, monospace numerals, no marketing chrome inside the app. Read `/mnt/skills/public/frontend-design/SKILL.md` if present.

**Seams for parallel agents:** (a) Supabase schema, RLS, storage policies; (b) Python analysis stages with tests; (c) Modal wiring and result writers; (d) library and upload flow; (e) working surface; (f) chat route and tools; (g) web information tools; (h) accuracy harness. (a), (b), (g), (h) are independent. (c) needs (a) and (b). (d) and (e) need (a) and the report types. (f) needs (c), (e), (g).

### 18. Phase plan

Each phase ships. Each ends when its acceptance line is met and the harness passes.

| Phase | Builds | Acceptance |
|---|---|---|
| **0. Foundation** | Supabase project, schema, RLS, storage. Next.js with auth and the three-pane shell. tus upload with dedupe. Modal `analyze` with tempo, beats, key, onsets, groove, loudness, spectral, structure. Realtime status. Library list. Harness with public datasets, gates in CI. | Upload 50 files including a folder, watch them analyze live, see vitals with confidence, harness passes. |
| **1. Loops** | Finder, renderer, client preview, Loops tab with grid, edits, snap modes, raw and rendered playback, export. Corrections logging. | Open a record, get ranked loops, drag to taste, hear it seamless, export a clean WAV. |
| **2. Stems and better beats** | GPU separation, stems as child files with analysis, Stems tab, BeatNet behind `track_beats`, gates raised. | Loop just the "other" stem. Harness gates raised and met. |
| **3. Chops and MIDI** | Chop modes, pads, record-to-MIDI, Basic Pitch, drum transcription, groove export, bundle export. | Chop three ways, tap a pattern with feel, download a kit plus MIDI. |
| **4. Breakdown** | `drums.py`, `sampleuse.py`, `instrumentation.py`, `chords.py`, `effects.py`, tags. Breakdown composer with hedging bands. Breakdown tab with waveform links. Compare. | The acceptance line in Section 11, on five records the owner knows. |
| **5. Web information** | Search and fetch tools with content-type allowlist and media-host rejection, `identify_context`, citations in chat, context section of the breakdown. | "Who produced this and what did it sample" answered with sources; a request to pull audio from a link is refused with the standard message. |
| **6. Search** | CLAP embeddings for everything, HNSW, similarity, text, hybrid parser, library search box. | "Something dusty in F minor around 85 with horns, no drums" works on a 500-file library. |
| **7. Combine and Re-voice** | Align and layer with stretch and pitch, Layers tab; symbolic re-voice with the curated instrument set, Re-voice tab; neural path evaluated and shipped or deferred with a written reason. | "The drums from this over the sample from that" renders and is editable. A piano stem comes back as guitar with editable MIDI. |
| **8. Chat as front door** | All tools, streaming, cards, batch, persisted conversations. Grounding contract fixtures. | A five-step sentence runs end to end and every result is editable on the surface. |
| **9. Beatbox** | Enrollment, per-user classifier, transcription, correction loop. | Enroll, beatbox, get MIDI that sounds like what was hummed. |
| **10. Product hardening** | Stripe with a free tier capped by storage and GPU minutes, metering, DMCA agent and takedown flow, ToS and privacy, observability, backups, rate limits. | Someone who isn't the owner can sign up, pay, use it, and be handled correctly if a takedown arrives. |

### 19. Costs to design around

- **Storage:** Supabase Storage at launch; R2 behind the same module if egress bites. A 20 GB library is on the order of $0.30–$0.50/month.
- **GPU:** separation and neural re-voice are cents per song. Meter GPU seconds; cap free.
- **Language:** small per turn. Cap free turns.
- **Web search:** per-query API cost; cache by query for 24 hours; cap free.
- **Bandwidth:** playback streams originals. Signed URLs with Range. Watch this one.

Free tier proposal: 2 GB, 5 stem jobs/month, 50 chat turns/day, 20 web searches/day.

### 20. Proposals: how the plan grows

`docs/PROPOSALS.md` template:

```
## <name>
**What it does for a producer:** one paragraph, in their words.
**Principle it serves:** which of the nine.
**Principle it risks:** which, and how it's mitigated.
**What it takes:** stages, models, UI, rough effort.
**Where it belongs:** which phase, or a new one.
**Status:** proposed | accepted | deferred | declined, with the owner's note.
```

Seeded with these, so the file isn't empty and the bar is visible:

- **Meter detection** for 3/4 and 6/8 material. Serves measurement. Risks little. Phase 2+.
- **Reference-driven mixing hints**: given a comparison, suggest specific gain and EQ moves to close the gap. Serves the learning goal. Risks drifting into "doing the mix"; mitigated by returning suggestions, never applying them. Phase 4+.
- **Chop pitch matching**: pitch each chop to the song key automatically, editable per chop. Phase 3+.
- **Session export to DAW project formats** (Ableton, FL, Logic) instead of only WAV + MIDI bundles. Serves handoff. Effort is high per format. Phase 3+.
- **Groove transplant**: apply the measured groove of one file to the MIDI of another. Phase 3+.
- **Shared kits**: a user publishes a kit made only from re-voiced or synthesized material they own the rights to. Risks principle 6; needs a rights attestation flow. Phase 10+.

### 21. Legal requirements of hosting uploaded audio

- Register a DMCA agent ($6, dmca.copyright.gov, renew every three years). Publish the agent contact. Build the takedown flow in Phase 10.
- ToS: users upload only what they have the right to use; the service processes it solely for them.
- No public URLs to uploaded audio. No cross-user access. Exports downloaded by the creating user only.
- No code path from a URL to a `files` row. The fetch layer rejects media content types and media-host download paths.
- Web information tools respect robots and site terms; no scraping behind logins; cache responsibly.

### 22. Kickoff prompt for Claude Code

> Read `CLAUDE.md` and `docs/BUILD_PACKET.md` in full, including Part I. Plan the build across agents using the seams in Section 17, then execute Phase 0 through Phase 10 in order, one phase at a time. Within a phase, parallelize where the seams allow. Each phase ends when its acceptance line in Section 18 is met and the accuracy harness passes. Don't start a phase before the previous one's acceptance is met. As you build, propose anything that would make a producer's flow faster, better, or more understood, using the template in Section 20, into `docs/PROPOSALS.md`; don't build proposals in the current phase unless they're small and inside the phase's acceptance. Make the simplest choice that meets acceptance when the packet is ambiguous, note it in the PR, and don't stop to ask unless blocked. Report at the end of each phase in six lines: what shipped, what was deferred, proposals added, harness scores, cost observations, and anything I need to do.
