# CONTRACTS.md

The glue between the seams in BUILD_PACKET section 17. Anything that crosses
a seam boundary (web ↔ database ↔ compute) is defined here, so agents working
on different seams agree without talking.

## 1. Environment variables

### web (Vercel / `.env.local`)

| Name | Used for |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/publishable key (client) |
| `SUPABASE_SERVICE_ROLE_KEY` | Server routes only. Never sent to the client. |
| `COMPUTE_DISPATCH_URL` | Base URL of the compute dispatcher (Modal web endpoint or the local runner) |
| `COMPUTE_DISPATCH_SECRET` | Bearer secret shared with compute |
| `ANTHROPIC_API_KEY` | Chat and breakdown narration |
| `WEB_SEARCH_PROVIDER` | `brave` or `tavily` |
| `BRAVE_SEARCH_API_KEY` / `TAVILY_API_KEY` | Web information tools |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID` | Phase 10 |

### compute (Modal secret `lockedgroove`, or `analysis/.env` for the local runner)

| Name | Used for |
|---|---|
| `SUPABASE_URL` | Same project as web |
| `SUPABASE_SERVICE_ROLE_KEY` | Result writers bypass RLS |
| `COMPUTE_DISPATCH_SECRET` | Bearer secret checked by the dispatcher |
| `LOCKEDGROOVE_MODEL_CACHE` | Optional; where model weights live (Modal volume mount) |

The Anthropic key lives only in web. Compute produces structured content;
narration happens in web routes so there is exactly one place the grounding
contract is enforced.

## 2. Storage layout (bucket `audio`, private)

| Prefix | Written by | Contents |
|---|---|---|
| `library/{user_id}/{sha256[:2]}/{sha256}.{ext}` | user, via tus | originals |
| `derived/{user_id}/{file_id}/stems/{model}/{stem}.wav` | compute | stems |
| `derived/{user_id}/{file_id}/chops/{index:03d}.wav` | compute | chops |
| `derived/{user_id}/{file_id}/loops/{loop_id}.wav` | compute | loop renders |
| `derived/{user_id}/{file_id}/midi/{kind}.mid` | compute | MIDI |
| `derived/{user_id}/{layer_id}/layer.wav` | compute | layer renders |
| `derived/{user_id}/{file_id}/revoice/{revoice_id}.wav` | compute | re-voice renders |
| `derived/{user_id}/bundles/{bundle_id}.zip` | compute | export bundles (a song export uses the export job's id) |
| `derived/{user_id}/beatbox/model.joblib` | compute | per-user beatbox model |

Playback and download: signed URLs, 10-minute expiry, produced by web server
routes only for rows the caller owns. Range requests are supported by
Supabase Storage for signed URLs.

## 3. Upload flow (web)

1. Client hashes the file (streaming SHA-256, `web/lib/audio/sha256.ts`).
2. `POST /api/files/prepare` `{ sha256, filename, size_bytes, content_type }`
   → `{ status: "exists", file }` when the user already has this hash, else
   `{ status: "upload", storage_path }`.
3. Client uploads with tus to
   `${NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/resumable`, chunk size
   6 MiB, headers `authorization: Bearer <user jwt>`, `x-upsert: false`,
   metadata `{ bucketName: "audio", objectName: storage_path, contentType }`.
4. `POST /api/files/complete` `{ sha256, storage_path, original_filename, size_bytes, content_type }`
   → inserts `files` (status `queued`), inserts an `analyze` job, dispatches.
   Returns `{ file, job }`.
5. The client subscribes to Realtime on `files` and `jobs` filtered by
   `user_id` and renders status live.

## 4. Job dispatch contract (web → compute)

`POST {COMPUTE_DISPATCH_URL}/dispatch`

```
authorization: Bearer {COMPUTE_DISPATCH_SECRET}
content-type: application/json

{ "job_id": "<uuid>" }
```

Response `200 { "ok": true, "call_id": "<modal call id or local id>" }`.
The compute side reads the `jobs` row with the service role, so the body is
only the id. Web stores `call_id` in `jobs.modal_call_id`.

Compute lifecycle for every job kind:

1. `jobs.status = 'running'`, `started_at = now()`.
2. Download inputs with signed URLs (service role).
3. Run. Progress (optional) to `jobs.progress`.
4. Write results (see 5) and `jobs.status = 'done'`, `result`, `finished_at`.
5. On exception: `jobs.status = 'failed'`, `jobs.error = str(exc)`; a file
   whose primary analysis failed gets `files.status = 'failed'`.

Idempotency: `analyze` on `(file_id, analysis_version)` is a no-op when
`files.analysis_version >= requested` and `files.report` is present.

## 5. Job kinds, params, results

| kind | params | writes |
|---|---|---|
| `analyze` | `{ analysis_version?: int, stages?: string[] }` | `files.report`, `files.peaks`, `files.duration_s/sample_rate/channels/format`, `files.status='ready'`, `tags` rows (source `model`) |
| `stems` | `{ model: "htdemucs_ft" \| "htdemucs_6s" \| "bs_roformer" }` | one `files` row per stem (`kind='stem'`, `parent_file_id`), `stems` rows, and one `analyze` job per stem |
| `chop` | `{ mode: "transients" \| "grid" \| "manual", count?, start_bar?, end_bar?, markers_s?: number[] }` | `files` rows (`kind='chop'`), `chops` rows |
| `midi` | `{ kind: "melody" \| "drums" \| "chords" \| "groove" }` | `midi` row; `result.notes` mirrors `midi.notes` |
| `embed` | `{ model?: string }` | `embeddings` row |
| `render_loop` | `{ loop_id, crossfade_ms?: 12, snap_zero_crossing?: true }` | `files` row (`kind='loop_render'`), `loops.render_file_id` |
| `layer` | `{ layer_id }` | `files` row (`kind='layer_render'`), `layers.render_file_id` |
| `revoice` | `{ instrument, path: "symbolic" \| "neural", keep_groove?: bool }` | `midi` row (symbolic), `files` row (`kind='revoice_render'`), `revoices` row |
| `breakdown` | `{ }` | `breakdowns` row (new version); queues `stems` + per-stem `analyze` if missing |
| `compare` | `{ file_a_id, file_b_id }` | `comparisons` row |
| `beatbox_train` | `{ examples: [{class, storage_path}] }` | `beatbox_profiles` row |
| `beatbox_transcribe` | `{ recording_path, grid_file_id?, bpm? }` | `midi` row (`kind='beatbox'`) |
| `export` | `{ song, format?: "flac" \| "wav", bit_depth?: 16 \| 24, sample_rate?: 44100 \| 48000, include_muted?: bool, midi_ids?: uuid[] }` | the zip at `derived/{user_id}/bundles/{job_id}.zip`; **no `files` row** |

`jobs.result` always carries `{ ...ids of rows written }` so the client can
select them on the surface when the job finishes.

### `export`: the song out

The arrangement is not persisted yet (`20260913001000_song_arrangement.sql` is
written and not applied), so `params.song` **is** the song: lanes in the
producer's order, each with its regions, each region with `file_id`, `start_s`,
`duration_s`, `offset_s`, `gain`, `rate`, its `lineage` and the one line
`web/lib/session/lineage.ts` derives from it. The Python mirror is
`analysis/lockedgroove/export/song.py`; the TypeScript that builds it is
`web/lib/export/song.ts`. When the song tables land, `POST /api/export/song`
grows a `{ session_id }` form that reads the same shape out of them and nothing
else moves.

`result` carries `storage_path`, `filename`, `folder`, `size_bytes`, the audio
settings, `length_samples`, the grid, one entry per stem (with its measured
peak and whether it clipped), the lanes that were **not** exported and why, the
MIDI that went in, and any notes. There is no `files` row: an export is a
derived artefact the producer downloads, not a library entry.

Because every id in `params.song` is caller input, ownership is settled three
times: the route resolves every `file_id` and `midi_id` through the caller's
RLS client before the job row is written; the handler re-checks each row's
`user_id` **and** that its `storage_path` is under that user's own prefix
(`derived.owner_path_ok`) before downloading anything; and the download route
fetches the zip with the caller's client, so the storage policy decides.
Metering is the runner's usual `cpu_seconds` row.

## 6. Peaks

`files.peaks` is renderer-agnostic:

```
{ "version": 1, "points": 2000, "min": [..2000 floats..], "max": [..2000 floats..] }
```

Values in `[-1, 1]` rounded to 3 decimals, mono mixdown, exactly `points`
entries each (short files are padded with zeros).

## 7. Web API routes

Every route reads the caller from the Supabase session cookie and uses the
anon client under RLS. The service role (`web/lib/supabase/admin.ts`,
server-only) is used only where the contract says so: job dispatch, the
`web_cache` table, derived-object writes (`derived/`), the takedown form,
the Stripe webhook, and the health probe. Request and response shapes live
in `web/lib/api/types.ts` and the per-seam `web/lib/api/*.ts` modules.

### Files, jobs, loops (Phases 0 and 1)

| Route | Method | Does |
|---|---|---|
| `/api/files/prepare` | POST | dedupe check by SHA-256, storage path, storage quota |
| `/api/files/complete` | POST | insert file + analyze job, dispatch |
| `/api/files` | GET | list the caller's files (`?kind=&parent=`) |
| `/api/files/[id]` | GET, PATCH, DELETE | one file; PATCH edits `title`, `artist` |
| `/api/files/[id]/url` | GET | signed playback URL (10 min) |
| `/api/files/[id]/edits` | POST | apply a `user_edits` field; logs a `corrections` row |
| `/api/files/[id]/reanalyze` | POST | queue `analyze` with a newer version |
| `/api/jobs` | POST | create + dispatch any job kind (body `{ kind, file_id?, params }`); quota check |
| `/api/jobs/[id]` | GET | job row |
| `/api/jobs/[id]/retry` | POST | requeue a failed job |
| `/api/loops` | GET, POST | list loops for a file; create a user loop |
| `/api/loops/[id]` | PATCH, DELETE | edit edges, bars, name; logs `loop_edges` / `loop_bars` (`via` says which control) |
| `/api/loops/[id]/render` | POST | queue `render_loop`; logs `loop_pick` when the exported row was not ranked first |
| `/api/loops/find` | POST | queue the loop finder (`analyze` with `task: find_loops`) |
| `/api/loops/personalization` | GET, PATCH | whether this account's own loop corrections adjust its ranking |

### Stems, chops, MIDI (Phases 2 and 3)

| Route | Method | Does |
|---|---|---|
| `/api/files/[id]/stems` | GET, POST | stems of a file; queue `stems` (GPU) |
| `/api/files/[id]/chops` | GET, POST | chops of a file; queue `chop` with a mode and its params |
| `/api/files/[id]/chops/[chopId]` | PATCH | move a chop's edges or rename it (logs a correction) |
| `/api/files/[id]/midi` | GET, POST | MIDI rows for a file; queue `midi` (drums, or Basic Pitch on a stem) |
| `/api/files/[id]/bundle` | GET | zip of chops + .mid + a readme, streamed to the creating user |
| `/api/midi/pads` | POST | a pads recording as a `.mid` under `derived/`; inserts a `midi` row |
| `/api/midi/[id]/download` | GET | signed URL for one MIDI file |

### Export (Phase 13)

| Route | Method | Does |
|---|---|---|
| `/api/export/song` | POST | `{ song, format?, bit_depth?, sample_rate?, include_muted?, midi_ids? }` → queue an `export` job; 413 over the cap, 404 for a record or MIDI the caller cannot open |
| `/api/export/[id]/download` | GET | the finished zip for the creating user, fetched with the caller's client (`[id]` is the export job's id) |

Stems plus a tempo map plus a readme, in that order of importance: per-lane
renders across the full song at one length, a MIDI tempo track and a text map,
and a README whose lineage section is the part only this product can write. The
size cap is 1 GiB of finished zip, refused from arithmetic before anything is
rendered; `web/lib/export/song.ts` and `analysis/lockedgroove/export/bundle.py`
hold the same numbers so the panel and the job cannot disagree. See
`docs/HANDOFF_export.md`.

### Breakdown and compare (Phase 4)

| Route | Method | Does |
|---|---|---|
| `/api/breakdowns/[fileId]` | GET, POST | latest breakdown; queue a new version |
| `/api/breakdowns/[fileId]/narrate` | POST | stream narration under the grounding contract (NDJSON) |
| `/api/compare` | GET, POST | latest comparison for a pair (`?a=&b=`; `a` alone gives its latest); queue `compare` |

### Web information (Phase 5)

| Route | Method | Does |
|---|---|---|
| `/api/web/search` | POST | `{ query, count? }` → results with citations; cached in `web_cache` |
| `/api/web/fetch` | POST | `{ url }` → extracted page text; the URL guard runs before, the content-type check after; media is refused |

Both are server-side tools of the chat as well; the guard (`web/lib/webinfo/guard.ts`)
refuses media hosts, download and stream paths, media extensions, private
addresses and credentials, and every redirect hop is re-checked. There is no
route anywhere that turns a URL into a `files` row.

### Search (Phase 6)

| Route | Method | Does |
|---|---|---|
| `/api/search` | POST | `{ query, limit?, kind?, current_file_id? }` → `{ results: [{ file, matched, similarity? }], files, parsed, mode, note }` |
| `/api/embeddings` | GET, POST | which ready files carry a CLAP embedding; queue `embed` for the ones that don't |

`mode` is `vector` when the text went through `/embed_text` (section 10) and
`filters` when it fell back to the structured filters plus a name match;
`note` says why. Rules parse BPM, key, kind, tags and negations first; the
model parser only sees what is left, and rules win on merge.

### Compatibility (Phase 7)

| Route | Method | Does |
|---|---|---|
| `/api/compat` | POST | `{ file_id, limit?, stretch_tolerance?, max_semitones?, max_octaves?, kind?, include_keyless? }` → `{ source, matches: [{ file, score, confidence, confidence_bound_by, confidence_reason, method, compatible, reason, tempo, key, timbre }], considered, note, method }` |

"What in my crate works with this?": the caller's files whose grid and harmony
meet this one's. The `compatible_files` RPC (section 11) does the coarse
filtering under RLS; the route scores what comes back with `web/lib/compat/theory.ts`,
the TypeScript mirror of `analysis/lockedgroove/analysis/compat.py`, and uses the
CLAP embeddings both files already carry to break ties by timbre. `reason` is the
row's plain line ("relative minor, 2% faster"); `confidence` is bounded by the
weakest measurement the claim uses and `confidence_bound_by` names it. A match is
one `POST /api/layers { file_ids: [open, match] }` from being a layer lane.

### Layers and re-voice (Phase 7)

| Route | Method | Does |
|---|---|---|
| `/api/layers` | GET, POST | the caller's layers; create one |
| `/api/layers/[id]` | GET, PATCH, DELETE | one layer with its items; rename; delete |
| `/api/layers/[id]/items` | POST | add a lane (a file, with offset, gain, stretch policy) |
| `/api/layers/[id]/items/[itemId]` | PATCH, DELETE | offset, gain, mute; remove |
| `/api/layers/[id]/render` | POST | queue `layer` |
| `/api/revoices` | POST | queue `revoice` (symbolic or neural) for a MIDI row |
| `/api/revoices/[id]` | GET | one re-voice with its audio and MIDI |
| `/api/files/[id]/revoices` | GET | re-voices derived from a file |

### Chat (Phase 8)

| Route | Method | Does |
|---|---|---|
| `/api/chat` | POST | `{ conversation_id, message, file_ids, open_file_id, batch? }` → NDJSON events `text`, `tool_call`, `tool_result` (with a card), `citations`, `done`, `error` |
| `/api/conversations` | GET, POST | the caller's conversations; start one |
| `/api/conversations/[id]` | GET, DELETE | a conversation with its messages; delete |

The chat runs a manual tool loop over nineteen strict tools (`web/lib/chat/tools.ts`).
Musical facts come only from `get_report` and `explain`; world facts only from
`web_search`, `fetch_page` and `identify_context`; every operation tool queues
the same job kinds as the tabs. Batches over five GPU operations return a
`confirm` card first. Free-tier turn and web-search caps answer 429.

### Beatbox (Phase 9)

| Route | Method | Does |
|---|---|---|
| `/api/beatbox/upload-url` | POST | signed upload URL for one enrollment or pattern recording under `library/{uid}/beatbox/` |
| `/api/beatbox/train` | POST | queue `beatbox_train` on the enrollment recordings |
| `/api/beatbox/profile` | GET | the caller's classifier profile (classes, per-class counts, accuracy) |
| `/api/beatbox/transcribe` | POST | queue `beatbox_transcribe` on a pattern recording |
| `/api/beatbox/transcriptions` | GET | the caller's beatbox MIDI rows |
| `/api/beatbox/transcriptions/[midiId]` | PATCH | correct a hit's class or time (logs a correction) |

### Account and product (Phase 10)

| Route | Method | Does |
|---|---|---|
| `/api/profile` | GET, PATCH | plan, display name |
| `/api/usage` | GET | this period's metered usage against the plan's limits |
| `/api/billing/checkout` | POST | Stripe Checkout session for the paid plan |
| `/api/billing/portal` | POST | Stripe customer portal session |
| `/api/billing/webhook` | POST | Stripe events → `profiles.plan` (signature verified, service role) |
| `/api/takedown` | POST, GET | the public DMCA notice form (rate limited, honeypot); GET is the owner's review list |
| `/api/health` | GET | database, storage and compute reachability for uptime checks |

## 8. Analysis pipeline interface (python)

```
from lockedgroove.pipeline import analyze_array, analyze_file
report = analyze_array(y, sr, file_info=FileInfo(...), stages=None)   # AnalysisReport
```

Stages are pure functions `(y: np.ndarray, sr: int, ctx: Context) -> Section`
in `lockedgroove/analysis/`. `Context` carries the partial report built so
far (tempo before beats, beats before groove and structure) plus optional
stem arrays for the stem-aware stages. Every stage sets `method` and
`confidence` and documents the confidence derivation in its docstring.

## 9. Local runner

`cd analysis && uv run lockedgroove-server` starts a FastAPI app on
`http://127.0.0.1:8787` exposing the same `/dispatch` route as Modal and
running jobs in a thread pool. Set `COMPUTE_DISPATCH_URL=http://127.0.0.1:8787`
in `web/.env.local` to develop without Modal. GPU job kinds run on CPU
there, slowly, or fail with a clear error if the model is not installed.

## 10. Text embeddings for search (web → compute)

`POST {COMPUTE_DISPATCH_URL}/embed_text` with the same bearer as `/dispatch`
and body `{ "texts": ["dusty soul loop"] }` (at most 32 texts of 500
characters) returns `{ "ok": true, "model": "<clap model name>", "dim": 512,
"vectors": [[...], ...] }`. Vectors are L2-normalized and live in the same
space as the `embeddings.vector` column written by the `embed` job, so the
web passes them to the `search_embeddings` RPC with `p_model` set to the
returned model name. 503 means no embedder is installed on that runner.

## 11. Compatibility (`compatible_files`)

`supabase/migrations/20260913000500_compat.sql`. The coarse candidate set behind
`POST /api/compat`, shaped like `library_filter` and `similar_files`: `security
invoker` so RLS applies, `set search_path = public, extensions`, effective values
(a `user_edits` correction wins over the prediction), capped limit.

```sql
compatible_files(
  p_file_id            uuid,
  p_limit              integer          default 20,
  p_stretch_tolerance  double precision default 0.14,  -- max(r, 1/r) - 1; 0.06 transparent
  p_max_semitones      integer          default 2,     -- how far the caller will pitch a file
  p_kind               text             default null,
  p_max_octaves        integer          default 1,     -- 1 = half-time and double-time
  p_include_keyless    boolean          default true
) returns table (file_id uuid, octave_factor double precision, folded_bpm double precision,
                 stretch_ratio double precision, stretch_distance double precision,
                 key_relation text, semitone_shift integer)
```

Tempo is compared octave-folded (170 and 85 BPM are one grid); `stretch_ratio` is
`source / folded candidate`, the same direction and meaning as
`combine/align.py`'s `stretch_ratio`. `key_relation` is one of `same`,
`relative`, `dominant`, `subdominant`, `parallel`, or null when either side has no
key. Non-tonal material (`file_is_tonal`: the `NON_TONAL_TAGS` of `align.py`, or a
stem named drums) has no key here whatever its chroma read, matching what the
layer render does with it.

The theory lives in three places that must agree, and two test suites hold them
to it via `web/lib/compat/parity.json`:

| | |
|---|---|
| `analysis/lockedgroove/analysis/compat.py` | the source of truth: thresholds, relationships, scores, confidence rule |
| `web/lib/compat/theory.ts` | the port the API and the panel use |
| `20260913000500_compat.sql` | `pitch_class_index`, `key_direct_relation`, `key_relation_strength`, `key_match_shift`, `key_match_relation`, `file_is_tonal` |

The same migration adds `files_effective_bpm_idx` on `(user_id, coalesce(user_edits
tempo, tempo))`, which `library_filter` and `search_embeddings` also filter on.
