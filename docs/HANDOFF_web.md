# HANDOFF_web.md

Web seam (d) library and upload flow, (e) working surface, plus the Phase 1
Loops tab and the chat shell. Everything under `web/` except
`web/lib/types/report.ts` (generated) and `web/lib/audio/renderLoop.ts` +
`renderLoop.test.ts` (written concurrently by the loop-render agent; the web
build imports `renderLoopPreview` from it).

## Design plan (frontend-design pass)

Subject: a producer's workbench for sample material. The numbers are the
interface (hashes, BPMs, keys, seconds, bars); the audience includes
beatmakers who are not technical; the primary job is getting from "file" to
"a loop I trust" fast, reading every value with its confidence.

Tokens (five named colors; everything else is a tint of one of them):

| token    | value   | role |
|----------|---------|------|
| graphite | #232326 | ground. A true graphite, not near-black; rules must read on it. |
| slate    | #1b1b1e | recessed wells: inputs, the waveform, the composer, the drop zone. |
| rule     | #3a3a40 | every border, divider and grid tick. Structure is drawn with this one line. |
| chalk    | #e6e3dc | text and waveform. `chalk-dim` / `chalk-faint` are its tints on graphite. |
| pad      | #f0a63a | the amber of a lit MPC pad. Playhead, active loop, running progress, focus ring, the one primary action per view. Nothing else is amber. |

Status never uses red or green: a failed row is chalk text plus an amber
retry; confidence is an amber dot at three fill levels (full >= 0.8, half
0.6–0.8, ring below), aligned with the hedge bands, and no dot when unmeasured.

Type: Public Sans 400/500/600 for labels, names and sentences (sentence
case, no capitals-eyebrows); JetBrains Mono 400/500 for every numeral and
readout, with `font-variant-numeric: tabular-nums` set on `body`. Readouts
sit one or two steps above their labels (scale 11 / 13 / 15.5 / 19 / 27).

Layout: one screen, three panes, the page never scrolls; each pane scrolls
inside. Left 288 px library, center flexible, right 336 px chat; the chat
folds to a toggle under 1180 px so a 1280 px laptop keeps a usable surface.
Everything left-aligned; numbers right-aligned in tabular columns.

```
┌ 44px ─────────────────────────────────────────────────────────────────────┐
│ CrateAI ●   [ search: 85 bpm, 80-95, f minor, fm, kind:stem ]   ? Chat ⏻ │
├ 288px ──────┬ flexible ───────────────────────────────┬ 336px ────────────┤
│ drop zone   │ name            kind  3:21  ready  0:12.340                  │
│ uploads     │ BPM 92.0● ½ ×2 Tap   Key F minor● or Ab   1st downbeat ... │
│ ─ Originals ├───────────────────────────────────────────┤ conversation ▾   │
│  song.wav   │ ▁▂▃▅▇▅▃▂▁ waveform 168px, beat ticks,     │ messages          │
│  92.0● Fm●  │   downbeat lines, dashed section bounds   │                   │
│ ─ Stems     ├───────────────────────────────────────────┤                   │
│ ─ Loops     │ Loops Stems Chops Layers Re-voice … Report│ ─────────────     │
│             │ ▶ found · 4 bars · 0:04.000–0:12.000 0.82 │ composer          │
└─────────────┴───────────────────────────────────────────┴───────────────────┘
```

Principles: (1) the waveform is the only large object, everything else is a
table of numbers with a rule between rows; (2) rules, not boxes: no cards,
no shadows, radius <= 3 px, no gradients; (3) numbers are the interface:
mono, larger than the label, confidence dot beside, hedge word in the label;
(4) amber means live: happening now or wanting your hand; (5) copy directs:
empty states say what to do, errors say what happened and offer the retry.

Checked against the generic-default list in the skill: not near-black plus
acid green (graphite ground, amber pinned by the brief); rules encode row
and pane structure in a dense tool rather than a broadsheet; no card kit;
no capitals eyebrows, no middle-dot meta strings (columns instead), no "→"
on buttons; mono is used for data only, as the brief asks; motion is the
playhead and progress widths only, and `prefers-reduced-motion` is honored.
Two revisions after the check: the first plan had green/red status colors
(the dashboard default) and a tracked-caps wordmark; both were dropped.

## Files

```
web/
  package.json  tsconfig.json  next.config.ts  postcss.config.mjs  eslint.config.mjs
  vitest.config.ts  .env.example  .gitignore  README.md  middleware.ts
  app/
    layout.tsx globals.css
    (auth)/layout.tsx  (auth)/login/page.tsx
    auth/callback/route.ts  auth/signout/route.ts
    (app)/layout.tsx  (app)/page.tsx  (app)/f/[fileId]/page.tsx
    api/files/prepare  api/files/complete  api/files (GET)
    api/files/[id] (GET PATCH DELETE)  api/files/[id]/url  api/files/[id]/edits  api/files/[id]/reanalyze
    api/jobs (POST)  api/jobs/[id] (GET)  api/jobs/[id]/retry
    api/loops (GET POST)  api/loops/[id] (PATCH DELETE)  api/loops/[id]/render  api/loops/find
    api/search  api/conversations (GET POST)  api/conversations/[id] (GET DELETE)  api/chat
  components/
    ui.ts
    auth/LoginForm.tsx
    shell/Workspace.tsx TopBar.tsx KeymapSheet.tsx SetupNotice.tsx searchState.tsx
    library/LibraryPane.tsx UploadZone.tsx UploadQueue.tsx FileRow.tsx SearchBox.tsx
    surface/Surface.tsx surfaceState.tsx HeaderStrip.tsx Waveform.tsx SurfaceTabs.tsx
            LoopsTab.tsx ReportTab.tsx ShellTab.tsx EmptySurface.tsx ConfidenceDot.tsx (+ .test.tsx)
    chat/ChatPane.tsx MessageList.tsx Composer.tsx
  lib/
    env.ts http.ts format.ts
    supabase/client.ts server.ts admin.ts middleware.ts
    types/db.ts (hand-written rows + Database generic)   types/report.ts (generated, untouched)
    api/types.ts api/client.ts
    compute/dispatch.ts
    storage/paths.ts
    report/effective.ts (+test) hedge.ts (+test) edits.ts (+test) grid.ts (+test)
    music/keys.ts (+test)
    search/parse.ts (+test)
    audio/sha256.ts (+test) sha256.worker.ts hashFile.ts decode.ts loopPlayer.ts
    audio/renderLoop.ts (+test)   <- owned by the loop-render agent
    upload/fs.ts uploader.ts
    keys/commands.ts
    state/LibraryProvider.tsx
```

## Commands run and results

| Command | Result |
|---|---|
| `pnpm install` | ok (pnpm 10.33.0, Node 22.22); next 15.5.25, react 19.3.0, typescript 5.9.3, eslint 9.39.5, vitest 3.2.7, tailwindcss 4.3.3, @supabase/supabase-js 2.116.0, @supabase/ssr 0.12.7, tus-js-client 4.3.1, wavesurfer.js 7.12.12, zod 4.6.4 |
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0, no warnings |
| `pnpm test` | 9 files, 100 tests passed (90 of mine + the loop-render agent's 10) |
| `pnpm build` (with `NEXT_PUBLIC_SUPABASE_*` unset) | exit 0: compiled, lint + types pass, 15 routes; `/f/[fileId]` 241 kB first load, middleware 94.7 kB; Google Fonts fetched at build; the SHA-256 worker is emitted as its own chunk |
| `pnpm start` with no env (smoke test) | `/login` 200 with the "no Supabase keys" notice; `/` and `/f/abc` 200 with the setup notice; `/api/files` and `/api/files/prepare` 503 `{ error: "Missing environment variable NEXT_PUBLIC_SUPABASE_URL ..." }` |

## Interpretation choices

- **File selection is a route.** `/f/[fileId]` renders the surface; the
  `(app)` layout persists the library and chat across navigation, so a file
  can be linked, reloaded, and later opened from the chat. `/` is the empty
  surface.
- **Realtime + polling.** The store subscribes to `postgres_changes` on
  `files` and `jobs` filtered by `user_id`, refetches on `visibilitychange`
  and `online`, resubscribes if the channel is not joined, and polls every
  15 s while any job is queued/running (insurance for a channel that never
  joins). Loops are not in the publication, so the surface refetches loops
  when a `render_loop` or find-loops job for the file reaches `done`.
- **Uploads.** Hash in a Worker (own SHA-256, tested against Node's crypto
  for 15 sizes incl. empty and > 1 MiB and for chunk-independence), then
  `prepare`, then tus (6 MiB chunks, Bearer user JWT, `x-upsert: false`,
  metadata `bucketName/objectName/contentType`), then `complete`. A tus
  409 (object already there from an earlier interrupted session) is treated
  as uploaded and `complete` runs; `complete` verifies the object exists by
  signing it before inserting the row, and returns the existing row on a
  unique-violation instead of failing. `complete` recomputes the storage
  path from the caller's id and the hash and rejects a mismatching one.
- **`files.status = 'uploading'`** is never written by the web app: rows
  are inserted at `complete` with `queued`, as the contract says; the
  uploading state is the client queue.
- **Dispatch failures leave the job `queued`** and write
  `jobs.error = "dispatch: <reason>"`; the library row shows
  "queued (compute not configured)" with a Retry that re-dispatches.
  `jobs/[id]/retry` accepts failed jobs and queued jobs.
- **Edits** require a report (409 otherwise). `predicted` in the corrections
  row is the analyzed value, never a previous edit. A `downbeat_phase` edit
  clears `first_downbeat_s` and vice versa (they are two ways to say the
  same thing; `effective()` gives the click precedence). `section_labels`
  edits merge into the existing map. The merge happens in the route
  (`lib/report/edits.ts`, tested); a `jsonb_set` RPC would make it atomic
  and is proposed below.
- **Reanalyze** queues `analyze` with `analysis_version = current + 1`
  (so compute's idempotency check lets it run) and, from the Report tab's
  per-section Run, `stages: [<section>]`. Compute should merge partial runs
  into the existing report via `analyze_array(base_report=...)`.
- **Key spelling** (OPEN_QUESTIONS C.13): `lib/music/keys.ts`. Majors lean
  flat (Db Eb Ab Bb, F# stays), minors lean sharp (C# F# G#, Eb and Bb
  stay). The other enharmonic is in the header's hover title; the report
  keeps sharps.
- **Search** parses `85 bpm` (±2), `80-95`, `around 85` (±5), a bare 2–3
  digit number in 40–300, `f minor` / `fm` / `Bbmaj` / `Ebmin`, and
  `kind:stem` (`kind:loop` maps to `loop_render`), then calls
  `library_filter`. Leftover words filter by filename/title/artist for now.
  The Phase 6 seam is marked in `lib/search/parse.ts`.
- **Chat** stores content as Anthropic-style blocks
  `[{type:"text", text}]`; the route streams `text/plain` and sets
  `x-conversation-id` / `x-message-id` / `x-user-message-id`. The client
  reads the stream, then reloads the conversation so ids, tool calls and
  citations come from the rows. `GET /api/conversations/[id]` (conversation
  + messages) was added beyond the contract table; noted below.
- **Preview** decodes the file lazily (first loop play) with
  `decodeAudioData`; raw loops use `AudioBufferSourceNode.loopStart/End`,
  rendered loops play the buffer from `renderLoopPreview` and show its
  `meta` (snapped ms per edge, effective crossfade, tail/self mode). While a
  loop plays the media-element transport is paused and the amber playhead
  on the overlay is driven from the audio clock.
- **Snap modes** apply on drag end (`region-updated`): a resize snaps the
  moved edge; a move snaps the start and keeps the length. Zero-crossing
  preference is a checkbox applied after the grid snap, within ±2 ms, only
  once the audio is decoded.
- **`noUncheckedIndexedAccess`** was in the first tsconfig; it was removed
  because the concurrently written `renderLoop.ts` does not compile under
  it and `next build` typechecks every file. `strict` stays on.
- **Peaks** `[max, min]` go to wavesurfer as two channels; its renderer
  takes `abs()` of the second for the lower half, which draws a correct
  min/max envelope without decoding. Without peaks (file not analyzed yet,
  or compute unconfigured) wavesurfer decodes the signed URL itself so the
  surface still works.
- Folder drop on Safari has no `webkitGetAsEntry` for directories (BACKLOG
  Phase 0); the picker path with `webkitdirectory` works everywhere.

## The loops/find contract (for compute)

`POST /api/loops/find { file_id, bars?, top_k? }` inserts a `jobs` row:

```
kind   = 'analyze'
params = { "task": "find_loops", "bars": [1, 2, 4, 8], "top_k": 12 }
```

and dispatches it. Compute treats an `analyze` job whose `params.task` is
`"find_loops"` as the loop finder, not as analysis:

1. `jobs.status = 'running'`.
2. Load the file's audio and `effective(files.report)`; run
   `loops/finder.py: find_loops(y, sr, report, bars, top_k)`.
3. Delete that file's existing `loops` rows with `origin = 'finder'`, insert
   the new candidates with `origin = 'finder'`, `bars`, `score`,
   `components` (the score parts: seam, stability, novelty, onset_lock),
   `name = null`.
4. `jobs.status = 'done'`, `jobs.result = { "loop_ids": [...] }`.

The web refetches `GET /api/loops?file_id=` when that job reaches `done`.
The route refuses (409) when `files.status != 'ready'` or `report` is null.

Cross-checked after writing: `analysis/lockedgroove/jobs/analyze.py`
(HANDOFF_compute.md) already implements this exactly (`task: "find_loops"`
under the `analyze` kind, `bars` / `top_k`, finder rows replaced,
`result.loop_ids`), and `stages: [...]` there adds sections onto the kept
base report, which is what the Report tab's per-section Run sends. Compute
also records `jobs.modal_call_id` itself and may answer `/dispatch` with
`already_done: true`; the web's dispatch helper stores the same id, so the
two writes agree. CI (`.github/workflows/ci.yml`) runs `pnpm typecheck`,
`lint`, `test`, `build` from `web/` with a frozen lockfile; all four pass.

## Other things for the compute side

- `render_loop` params are `{ loop_id, crossfade_ms: 12, snap_zero_crossing: true }`
  and the job's `file_id` is the loop's `file_id`. When done, set
  `loops.render_file_id` and put the render in `files` with
  `kind = 'loop_render'`, `parent_file_id = <source>`; the web finds the
  render by `render_file_id` and offers Open (it is a library entry) and
  Download (signed URL).
- `analyze` with `params.stages` present should recompute only those
  report fields and keep the rest (`base_report`). `params.analysis_version`
  is set to `current + 1` by the reanalyze route.
- While running, `jobs.progress` (0–1) shows as a per-row amber line and
  "analyzing 40%" in the library; please write it.
- `jobs.error` set by the web while a job is still `queued` always starts
  with `dispatch:`; compute can overwrite it.
- `files.status` flow expected: `queued` (web) -> `analyzing` (compute) ->
  `ready` / `failed`.

## Schema and contract notes (docs/CONTRACTS.md, if you want them there)

- Added route: `GET/DELETE /api/conversations/[id]` (conversation and its
  messages). `POST /api/conversations` exists as in the table.
- Added route: `POST /api/loops/find` (above).
- `POST /api/files/[id]/reanalyze` accepts an optional `{ stages }`.
- `messages.content` shape: Anthropic-style content blocks.
- A `library_filter` text parameter (name/title/artist `ilike`) would move
  the leftover-text filtering into SQL; today it is applied in the route
  after the RPC.

## Proposals (PROPOSALS.md template)

## Atomic user-edit merge
**What it does for a producer:** Two edits made quickly (tap a tempo, then set the downbeat) never overwrite each other, even from two tabs.
**Principle it serves:** 7, corrections are ground truth; 4.
**Principle it risks:** None.
**What it takes:** A `set_user_edit(file_id, field, value)` SQL function doing `jsonb_set` on `report -> 'user_edits'` and the corrections insert in one statement; the route calls it instead of read-merge-write.
**Where it belongs:** Phase 1 hardening.
**Status:** proposed.

## Loops in the Realtime publication
**What it does for a producer:** Loops the finder or the chat writes appear on the waveform the moment they land, without the surface polling job status.
**Principle it serves:** 5, the library is the product.
**Principle it risks:** None; RLS applies to Realtime.
**What it takes:** `alter publication supabase_realtime add table public.loops` plus `replica identity full`; a small subscription in the surface.
**Where it belongs:** Phase 1.
**Status:** proposed.

## Tempo-locked loop length
**What it does for a producer:** A "bars" field on each loop that, when typed, moves the end edge to exactly that many bars on the grid; and a lock that keeps a drag on the start edge from changing the bar count.
**Principle it serves:** 4, every output is editable.
**Principle it risks:** None.
**What it takes:** `barsToSeconds` exists in `lib/report/grid.ts`; a number input on the loop row and a lock toggle.
**Where it belongs:** Phase 1.
**Status:** proposed.

## Waveform zoom
**What it does for a producer:** Pinch or wheel to zoom the waveform so a 1-bar loop on a 6-minute record can be placed by eye.
**Principle it serves:** 4.
**Principle it risks:** None.
**What it takes:** wavesurfer `minPxPerSec` + scroll; the grid overlay must follow the scroll offset.
**Where it belongs:** Phase 1 or 2.
**Status:** proposed.

## Build note

`pnpm build` and `pnpm start` were run with `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` unset. Nothing reads the env at module
scope: `lib/env.ts` throws a named `EnvError` at the request that needs a
value, route handlers turn that into a 503 with the variable's name, the
`(app)` layout and `/login` render a setup notice, and the middleware passes
requests through. With the keys present the same paths run normally.

Not exercised here (no Supabase session or compute in the sandbox): the
signed-in flows end to end (tus upload against Storage, Realtime delivery,
wavesurfer rendering in a browser). The pieces are typed against the real
client libraries and the pure logic (hashing, parsing, effective(), edits,
snapping, key spelling) is unit-tested; the first signed-in run should be
watched for: the tus `x-upsert: false` + 409 path, the Realtime channel
joining under RLS (the store polls every 15 s while jobs run if it does
not), and wavesurfer drawing the `[max, min]` peaks as expected.
