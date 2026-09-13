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
| `derived/{user_id}/bundles/{bundle_id}.zip` | compute | export bundles |
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

`jobs.result` always carries `{ ...ids of rows written }` so the client can
select them on the surface when the job finishes.

## 6. Peaks

`files.peaks` is renderer-agnostic:

```
{ "version": 1, "points": 2000, "min": [..2000 floats..], "max": [..2000 floats..] }
```

Values in `[-1, 1]` rounded to 3 decimals, mono mixdown, exactly `points`
entries each (short files are padded with zeros).

## 7. Web API routes

| Route | Method | Does |
|---|---|---|
| `/api/files/prepare` | POST | dedupe check, storage path |
| `/api/files/complete` | POST | insert file + analyze job, dispatch |
| `/api/files` | GET | list the caller's files (`?kind=&parent=`) |
| `/api/files/[id]` | GET, PATCH, DELETE | one file; PATCH edits `title`, `artist` |
| `/api/files/[id]/url` | GET | signed playback URL (10 min) |
| `/api/files/[id]/edits` | POST | apply a `user_edits` field; logs a `corrections` row |
| `/api/files/[id]/reanalyze` | POST | queue `analyze` with a newer version |
| `/api/jobs` | POST | create + dispatch any job kind (body `{ kind, file_id?, params }`) |
| `/api/jobs/[id]` | GET | job row |
| `/api/jobs/[id]/retry` | POST | requeue a failed job |
| `/api/loops` | GET, POST | list loops for a file; create a user loop |
| `/api/loops/[id]` | PATCH, DELETE | edit edges, name |
| `/api/loops/[id]/render` | POST | queue `render_loop` |
| `/api/search` | POST | hybrid library search |
| `/api/chat` | POST | streaming chat with tools |
| `/api/breakdowns/[fileId]` | GET, POST | latest breakdown; queue a new one |
| `/api/breakdowns/[fileId]/narrate` | POST | stream narration under the grounding contract |
| `/api/compare` | POST | queue a comparison |
| `/api/web/search`, `/api/web/fetch` | POST | web information tools (server only) |

All routes read the caller from the Supabase session cookie and use the
anon client under RLS, except the dispatch step and result reads that need
the service role (kept in `web/lib/supabase/admin.ts`, server-only).

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
