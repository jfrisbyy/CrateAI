# HANDOFF: compute wiring (seam c)

The job runner, result writers, the Modal app and the local runner. Everything
here sits behind the dispatch contract in `docs/CONTRACTS.md` sections 4 and 9
and writes results with the service role.

## Files

| File | What it is |
|---|---|
| `analysis/lockedgroove/db.py` | `Database` protocol; `SupabaseDatabase` (PostgREST over httpx, service role); `InMemoryDatabase` (tests; mirrors defaults, check constraints and the `(user_id, sha256)` unique key). `jsonable()` converts numpy scalars before any write. |
| `analysis/lockedgroove/storage.py` | `Storage` protocol; `SupabaseStorage` (Storage REST API, bucket `audio`); `LocalStorage(root)`. `validate_path()` refuses URLs, absolute paths and `..` (principle 3). |
| `analysis/lockedgroove/jobs/__init__.py`, `jobs/common.py` | `JobContext` (throttled progress, `download()` with cleanup, scratch `workdir`, `queued_job_ids`), `JobError`. |
| `analysis/lockedgroove/jobs/runner.py` | `run_job(job_id, db, storage)`: the lifecycle of section 4, `KIND_PHASE` table, importlib dispatch to `lockedgroove.jobs.<kind>.run`, the principle-3 param check. |
| `analysis/lockedgroove/jobs/analyze.py` | `analyze` (report, peaks, vitals, tags, idempotency, 20-minute cap) and `task: find_loops`. |
| `analysis/lockedgroove/jobs/render_loop.py` | `render_loop`: 24-bit WAV to `derived/{user}/{file}/loops/{loop_id}.wav`, `files` row, `loops.render_file_id`, queued `analyze` for the render. |
| `analysis/lockedgroove/server.py` | `create_app()` (the FastAPI app both hosts serve), `LocalRunner` (thread pool of 2), `main()` = `lockedgroove-server` on 127.0.0.1:8787. |
| `analysis/lockedgroove/modal_app.py` | Modal 1.x app: `run_job_cpu`, `run_job_gpu`, `web` (ASGI: `/dispatch`, `/health`); pure `choose_runner()` and `verify_bearer()`. |
| `analysis/.env.example` | The three compute variables for the local runner. |
| `analysis/tests/test_db_inmemory.py`, `test_storage.py`, `test_runner.py`, `test_job_analyze.py`, `test_job_render_loop.py`, `test_dispatch.py` | 106 tests: 105 pass, 1 skips until the `beats` stage lands (`105 passed, 1 skipped in 1.68s`). |

No contract file was modified. `pyproject.toml` needed no change (everything
used is already in the `compute` and `dev` extras; `tomllib` is stdlib).

## Running it

```bash
cd analysis
/home/user/crateai-venv/bin/python -m pytest tests/test_db_inmemory.py tests/test_storage.py \
    tests/test_runner.py tests/test_job_analyze.py tests/test_job_render_loop.py tests/test_dispatch.py -q
```

Local runner (no Modal account needed):

```bash
cp analysis/.env.example analysis/.env      # fill in the service role key and the dispatch secret
cd analysis && uv sync --extra compute --extra dev && uv run lockedgroove-server
# web/.env.local: COMPUTE_DISPATCH_URL=http://127.0.0.1:8787
```

Without the three variables it exits with the instructions instead of
starting. `GET /health` lists `implemented_kinds` (currently `analyze`,
`render_loop`) and the phase each kind arrives in.

## Modal deploy (owner)

```bash
cd analysis
uv sync --extra compute
uv run modal token new                     # once per machine; opens the browser
uv run modal secret create lockedgroove \
    SUPABASE_URL=https://ufmpwtjtyzmfucjyuhqo.supabase.co \
    SUPABASE_SERVICE_ROLE_KEY=<Project Settings -> API -> service_role> \
    COMPUTE_DISPATCH_SECRET=<the value in web/.env.local>
uv run modal deploy lockedgroove/modal_app.py
```

The deploy prints one web URL of the shape
`https://<workspace>--lockedgroove-web.modal.run` (in a non-default Modal
environment: `https://<workspace>-<environment>--lockedgroove-web.modal.run`).
That URL is `COMPUTE_DISPATCH_URL` for web/.env.local and Vercel; the web
posts to `${COMPUTE_DISPATCH_URL}/dispatch`. Check it with
`curl $COMPUTE_DISPATCH_URL/health`. The volume `lockedgroove-model-cache`
(mounted at `/cache`) is created on first deploy. Logs:
`uv run modal app logs lockedgroove`. Redeploy after any change under
`analysis/lockedgroove/` (the package is mounted with
`add_local_python_source`, so a redeploy is seconds, not an image rebuild,
unless dependencies change).

`LOCKEDGROOVE_GPU_EXTRAS=1 uv run modal deploy ...` adds the `gpu` extra
(torch, audio-separator, basic-pitch, laion-clap) to the GPU image. It is off
by default until Phase 2 lands the stages that need it, so a resolver
conflict in those heavy packages cannot break the Phase 0 deploy.

## What the other seams should know

* **`POST /dispatch` is served by one ASGI app, not `modal.fastapi_endpoint`.**
  `fastapi_endpoint` mounts a function at `/` only, so the contract's
  `{COMPUTE_DISPATCH_URL}/dispatch` and `/health` could not both be one base
  URL. `modal_app.web` (`@modal.asgi_app()`) serves the same
  `lockedgroove.server.create_app()` the local runner uses; auth, response
  shape and error codes are identical on both hosts and tested once.
* **Responses**: `200 {ok: true, call_id}`; `401 {ok: false, error: "unauthorized"}`
  (no header, wrong scheme, wrong token, or no secret configured);
  `404` unknown job; `400` bad body; a job already `done` answers
  `200 {ok: true, call_id, already_done: true}` without running again.
  Compute records `jobs.modal_call_id` itself (also for follow-up jobs), so
  the web may skip writing it.
* **Follow-up jobs**: a handler that creates jobs (a render's `analyze`, a
  stem's `analyze` in Phase 2) lists their ids in `result.queued_job_ids`;
  the host dispatches them (thread pool locally, `.spawn()` on Modal). The
  web does not need to poll for compute-created jobs.
* **`jobs.result`** always carries the ids written (`file_id`,
  `render_file_id`, `analyze_job_id`, `loop_ids`, `tag_ids`), plus for
  `analyze`: `stages`, `stage_errors` (stage name -> reason, e.g. a stage
  module not landed yet), `timings_s`, and `truncated_to_s` / `note` for
  files over 20 minutes.
* **`analyze` params** beyond the contract: `force: true` re-runs regardless
  of version; `task: "find_loops"` with `bars` / `top_k` runs the loop finder
  under the `analyze` kind (no schema change) and returns `loop_ids`.
  `stages: [...]` given explicitly *adds* those sections to the existing
  report (base report kept); omitting `stages` runs the Phase 0 set on a
  fresh report. `user_edits` survive every re-analysis.
* **Version written**: `files.analysis_version` and `report.analysis_version`
  are set to the requested version (default `lockedgroove.ANALYSIS_VERSION`);
  `result.code_analysis_version` says which code ran.
* **Loops table**: `find_loops` deletes the file's rows with `origin =
  'finder'` and inserts the new candidates (name from the finder, e.g.
  "4 bars @ 12.3s"); `user` and `chat` loops are never touched. `render_loop`
  re-renders the same loop to the same storage key; the same bytes dedupe to
  the existing `files` row via `(user_id, sha256)`.
* **Principle 3 in code**: every job fails before its handler runs if any
  param key (nested, case-insensitive) is `url`, `href`, `link`, `uri` or
  ends in `_url`/`_href`/`_link`/`_uri`. `storage_path`, `recording_path`
  are fine. Storage keys with a scheme or a leading slash are refused too.
* **Database protocol** grew `update_rows(table, filters, patch)` and
  `delete_rows(table, filters)` beyond the requested list (needed to set
  `loops.render_file_id` and to replace finder rows). Both refuse empty
  filters.

## Interpretation choices

1. **"Primary analysis failed → `files.status = 'failed'`"**: an `analyze`
   job with no `task` (or `task: "analyze"`) is primary. On failure the file
   becomes `failed` only when it has no report yet; a file that already has
   a report goes back to `ready` (its old report still stands). A failed
   `find_loops` never changes the file.
2. **Long files (B.9)**: the first 20 minutes are analyzed; `duration_s`,
   `report.file.duration_s` and the peaks describe the whole file; the job
   result carries `truncated_to_s: 1200` and a `note`. The report itself is
   untouched (no invented `notes`), so the web can show the note from the
   job row or from `duration_s > 1200`.
3. **Progress**: `jobs.progress` is written at most once per 2 s (calls
   inside the window are dropped, not deferred); `0.0` at start and `1.0`
   with the `done` update are always written. Stage names are kept in memory
   only (no column for them; see proposals).
4. **`run_job` never raises for a failing job** (the row carries the
   failure); it raises only when the job row does not exist. A job already
   `done` is returned as is. A job found `running` is run again (crash
   retry).
5. **Modal images**: dependency lists are constants in `modal_app.py`
   mirrored from `pyproject.toml`; `test_dispatch.py` fails if they drift.
   `modal` itself is not pip-installed into the image (the runtime injects
   it).
6. **`find_loops` input**: the mono mixdown at the native sample rate and the
   *effective* report (the finder applies `effective()` again; idempotent).
7. **Loop filenames** come from `lockedgroove.loops.naming.loop_filename`
   (conventional key spelling, `-` for spaces); when `loops.bars` is null the
   bar count is derived from the effective tempo; with no naming module the
   fallback spells sharps.
8. **Retries**: PostgREST calls retry 3 times on 5xx and transport errors
   with backoff; 4xx raise at once.

## Failures seen in other agents' tests (not touched)

Full suite at the time of writing: `4 failed, 295 passed, 3 skipped in 15.21s`.
The failures are in files owned by the analysis and loops agents and were
still changing between runs (an earlier run had 11):
`tests/test_drums.py::test_open_hat_ratio_and_mix_fallback`,
`tests/test_loop_render.py::test_snap_keeps_the_edge_when_no_crossing_is_in_range`,
`tests/test_loop_render.py::test_snap_uses_the_mono_sum_so_channels_move_together`,
`tests/test_loop_render.py::test_invalid_ranges_raise`. Skips:
`test_chops.py` (no `basic_pitch`), `test_combine.py` (no `tempo` stage yet),
and my real-finder test (waits for the `beats` stage). None involve
`db.py`, `storage.py`, `jobs/`, `server.py` or `modal_app.py`.

## Proposals (for docs/PROPOSALS.md; not appended there to avoid clashing with concurrent edits)

## Durable follow-up dispatch
**What it does for a producer:** A stem separation or a loop render always ends with its own analysis in the library, even if the container that created the follow-up job died before it could hand it on.
**Principle it serves:** 5, the library is the product.
**Principle it risks:** None.
**What it takes:** Today the runner dispatches `result.queued_job_ids` in-process. A Postgres trigger on `jobs` insert (`pg_net` POST to `/dispatch`) or a small web-side sweeper for `status = 'queued'` rows older than a minute makes it durable. Half a day.
**Where it belongs:** Phase 2 (stems create many follow-ups).
**Status:** proposed.

## Stage-level progress in the UI
**What it does for a producer:** While a file analyzes, the row says what is being measured ("beats", "key", "structure"), not just a percentage, so the wait reads as work, and a slow stage is visible.
**Principle it serves:** 2, measure don't guess (show the measurement happening).
**Principle it risks:** None.
**What it takes:** A `jobs.progress_stage text` column (one migration), one extra field in the throttled progress write, a label in the library row. An hour.
**Where it belongs:** Phase 0 or 1.
**Status:** proposed.

## Cancel a running job
**What it does for a producer:** Queued the wrong file for stems, or a 20-minute mix for a breakdown: stop it, and stop paying for the GPU minute.
**Principle it serves:** 4, every output is editable (including the decision to run it); cost control for Phase 10.
**Principle it risks:** None.
**What it takes:** `jobs.status = 'cancelled'` (check constraint change), a cooperative check inside `JobContext.progress()` that raises, `modal.FunctionCall.from_id(modal_call_id).cancel()` from a web route, `DELETE /api/jobs/[id]`. A day.
**Where it belongs:** Phase 2 (first GPU jobs).
**Status:** proposed.
