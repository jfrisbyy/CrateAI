# HANDOFF_web_stems_chops.md

Web seam (e), Phase 2 Stems tab and Phase 3 Chops tab: pads, record-to-MIDI,
MIDI extraction and the kit bundle. Built on the shell in `HANDOFF_web.md`
(its tokens, `components/ui.ts` presets, `lib/http.ts` route helpers, the
LibraryProvider store and the `crateai:*` window events) without editing any
shared file. No git commands were run; nothing was committed.

## Files

```
web/
  components/surface/StemsTab.tsx                  replaced the Phase 2 placeholder
  components/surface/ChopsTab.tsx                  replaced the Phase 3 placeholder
  components/stems/
    useStems.ts        list + refetch on `stems` job done + separate()
    StemList.tsx       groups by model (newest first), rows: play, state, vitals, Open, Loop this stem
    FilePlayButton.tsx audition a library file via its signed URL (one at a time)
    useJobDone.ts      "a job for this file reached done" watch (the loops pattern)
    jobStatus.ts       job row -> one line of text; jobToShow(); paramOf()
    navigate.ts        openFile(router, id, tab): push, wait for the route, dispatch crateai:tab
  components/chops/
    ChopControls.tsx   transients / grid / manual controls, markers at the cursor, Chop
    ChopList.tsx       rows: play, index, name (rename), edges, length, state, Open
    PadGrid.tsx        16 pads, amber while sounding
    RecordPanel.tsx    length, count-in, live readout, step view with offsets, Save as MIDI
    MidiPanel.tsx      Melody/Drums/Chords/Groove, the .mid list with Download, Download kit
    useChops.ts  useMidi.ts  usePads.ts
  lib/api/stems.ts  chops.ts  midi.ts             client modules + the response types the routes import
  lib/midi/
    writer.ts (+test)    @tonejs/midi writer: writeMidi, writePadsMidi, padHitsToNotesJson, readMidi
    manifest.ts (+test)  planBundle(): zip paths, deduped names, manifest.json shape
    bundle.ts (+test)    buildBundleZip() with fflate, 200 MB cap
    download.ts          midi rows -> signed download URLs (server)
  lib/pads/
    grid.ts (+test)      placeHit(): bar / step / offset_ms on the 16th grid; bar and step lengths
    keymap.ts (+test)    1–8, Q–I -> pads 1–16; grid layout
    bindings.ts (+test)  bindPads(chops, stems): what each pad plays
    recording.ts (+test) acceptsHit, takeBars, placeTake, finalizeTake (pure)
    engine.ts            PadEngine: decode once per file, 3 ms fades, polyphonic, lit state
    recorder.ts          PadRecorder: count-in, audio-clock hits, fixed length or until stop
    click.ts             the count-in click (oscillator blips)
  app/api/files/[id]/stems/route.ts               GET list (joined), POST { model }
  app/api/files/[id]/chops/route.ts               GET list (joined), POST { mode, ... }
  app/api/files/[id]/chops/[chopId]/route.ts      PATCH { name }
  app/api/files/[id]/midi/route.ts                GET list with download URLs, POST { kind }
  app/api/files/[id]/bundle/route.ts              GET the kit zip
  app/api/midi/pads/route.ts                      POST a pads recording as .mid + midi row
  app/api/midi/[id]/download/route.ts             GET signed URL for one .mid
docs/HANDOFF_web_stems_chops.md                   this file
```

## Commands run and results (from `web/`)

| Command | Result |
|---|---|
| `pnpm typecheck` | exit 0 at 08:20 (whole package). At the very last run (08:23) it failed only on two files other agents were editing at that moment (below); `tsc --noEmit` filtered to my paths: 0 errors |
| `pnpm lint` | exit 0 at 08:21 (0 errors, 3 warnings in `components/layers/LaneTimeline.tsx`, not mine). At 08:23 one error in `lib/search/hybrid.test.ts` (not mine); `eslint` on my paths alone: exit 0, no warnings |
| `pnpm test` | 33 files, 307 tests passed (the count grows as other agents add suites); 30 are mine: `lib/midi/writer.test.ts` (5), `manifest.test.ts` (3), `bundle.test.ts` (2), `lib/pads/grid.test.ts` (6), `keymap.test.ts` (4), `bindings.test.ts` (3), `recording.test.ts` (7) |

Not run: `pnpm build` (other agents were mid-edit in the same tree; the
route modules follow the existing `params: Promise<{ id }>` shape and export
only handlers, which is what the build's route typing checks).

### Other agents' failures seen while working

The working tree is shared and moving. Files I do not own that failed at
one point or another: `lib/search/merge.ts` (ParsedQuery fields) and
`lib/narration/validate.ts` (`allFacts` unused), both fixed by their owners
before 08:20; then at 08:23 `lib/chat/limits.ts` (`Json` arithmetic at line
54) and `lib/search/hybrid.test.ts` (`tag` unused at line 40), which were
still in flight when I stopped. The three `LaneTimeline.tsx` lint warnings
remain. Nothing of mine depends on any of them.

## The routes (for CONTRACTS.md section 7)

| Route | Method | Does |
|---|---|---|
| `/api/files/[id]/stems` | GET | `{ stems: [{ ...stems row, file: { id, kind, status, duration_s, original_filename, vitals } \| null }] }`, vitals = `{ bpm, bpm_confidence, key, key_confidence }` from the effective report |
| `/api/files/[id]/stems` | POST `{ model }` | inserts `jobs` kind `stems` params `{ model }`, dispatches; 409 when the same model is already queued or running for the file; returns `{ job, dispatch }` (201) |
| `/api/files/[id]/chops` | GET | `{ chops: [{ ...chops row, file: same summary \| null }] }` in index order |
| `/api/files/[id]/chops` | POST | `{ mode: "transients", count, min_gap_ms }` \| `{ mode: "grid", start_bar, end_bar, divisions }` (0-based bars) \| `{ mode: "manual", markers_s }` → `jobs` kind `chop` with exactly those params; grid needs a report (409) |
| `/api/files/[id]/chops/[chopId]` | PATCH `{ name }` | rename; `{ chop }` |
| `/api/files/[id]/midi` | GET | `{ midi: [{ ...midi row, download_url, filename }] }` newest first, URLs signed for 10 min with `download=` |
| `/api/files/[id]/midi` | POST `{ kind }` | `melody \| drums \| chords \| groove` → `jobs` kind `midi` params `{ kind }`; needs a report (409) |
| `/api/midi/pads` | POST | `{ file_id, bpm, bars, beats_per_bar?, hits: [{ time_s, pad (0–15), chop_file_id, velocity }] }` → builds the .mid, uploads to `derived/{user}/{file}/midi/pads-{ms}.mid` with the admin storage client, inserts the `midi` row (kind `drums`) under RLS; `{ midi }` (201); 503 without `SUPABASE_SERVICE_ROLE_KEY` |
| `/api/midi/[id]/download` | GET | `{ url, expires_in, filename }` |
| `/api/files/[id]/bundle` | GET | `application/zip`, `content-disposition: attachment; filename="<name>_kit.zip"`; 409 with nothing to bundle, 413 over 200 MB |

Every route validates its body with zod, reads the user from the session
(RLS scopes rows), answers errors as `{ error, details }` via `lib/http.ts`.
The admin client is used for exactly two things: storing the pads .mid
(users cannot write under `derived/`) and fetching bundle bytes (falls back
to the caller's client, which RLS also allows for `derived/{own id}/…`).

## Interpretation choices

**Stems**
- The tab offers the three models from `stems/separate.py: MODELS` with
  one line each (`lib/api/stems.ts: STEM_MODELS`). Separating with a model
  that is already in flight for the file is refused (409) since it costs GPU
  minutes; a different model queues a second job. Groups are ordered newest
  model first; a `-fake` model reads "development stand-in, not a separation
  model" beside the base model name.
- Rows overlay the live `files` row from the LibraryProvider (status,
  progress line, vitals from `effective(report)`) on the route's summary, so
  a stem's own analysis is live without any new subscription. Stems rows
  themselves are refetched when a `stems` job for the file reaches `done`
  (`useJobDone`, the same watch the surface keeps for loops).
- "Open" navigates to `/f/[stemFileId]`. "Loop this stem" navigates and
  then dispatches `crateai:tab` = `loops` once `window.location.pathname`
  is the stem's route plus 60 ms (the new SurfaceTabs registers its listener
  in an effect after commit; polling with rAF, giving up after 4 s). The
  surface is keyed by file id so it starts on Loops anyway; the event makes
  the intent survive a different default later.
- Stem audition uses an `<audio>` element on the signed URL (one at a time)
  and pauses the transport and any loop first; there is nothing to decode.

**Chops**
- Modes map 1:1 onto `jobs/chop.py`: transients `{ count, min_gap_ms }`
  (defaults 16 and 40 ms), grid `{ start_bar, end_bar, divisions }` (the
  tab shows bars 1-based, sends 0-based), manual `{ markers_s }` with
  markers placed at `useSurface().cursor` ("Add marker at 0:12.340") and a
  removable chip list. Compute's `replace` default stands: every Chop
  replaces the file's chops (the tooltip says so).
- Chop names are editable (PATCH is cheap); the name is the pad label.
- Chop rows show the live chop-file status the same way stems do; the list
  is refetched when a `chop` job reaches `done`.

**Pads**
- Binding order (`lib/pads/bindings.ts`): chops by `index`, first sixteen,
  skipping chops without a file; when the file has no chops, its stems, the
  newest model's group first, each group in drums, bass, vocals, other,
  guitar, piano, instrumental order. Pads past the material are empty.
- Layout reads like the keyboard: rows 1–4, 5–8, Q–R, T–I.
- Playback: every bound file is fetched once via `GET /api/files/[id]/url`
  and decoded into an AudioBuffer (`PadEngine`, its own cache; the surface's
  `decodeFromUrl` cache holds three files). A tap starts a new source with a
  3 ms fade in and a 3 ms fade out at the buffer's end, through a gain set
  from velocity. Polyphonic, nothing chokes. Chops past pad 16 play through
  the same engine from the list (decoded on first play).
- Keyboard: `lib/keys/commands.ts` already emits `crateai:pad` with the
  1-based pad number, so `usePads` subscribes with `onPad`. Those events do
  not carry `KeyboardEvent.repeat`, so a capture-phase `keydown` listener
  notes `e.repeat` for pad keys first (capture on `window` runs before the
  shell's bubble listener) and repeated events are dropped: holding a key
  plays once. Velocity is always 1.0 (a keyboard has none); the tab says so.
  Pointer taps use `pointerdown`; Enter on a focused pad also triggers.
- The pad lights amber (`border-pad bg-pad/15 text-pad`) while any of its
  sources is sounding (`source.onended` clears it).

**Record mode**
- `Record` arms: one bar of count-in clicks (oscillator blips, the downbeat
  higher and louder) at the file's effective tempo (`useSurface().report.tempo`
  after `effective()`, default 90 when nothing is measured; the readout says
  when the default is in use), then recording for 1, 2, 4 or 8 bars or
  until Stop. A quieter click keeps going through the take (checkbox, on by
  default). Everything is scheduled on `AudioContext.currentTime`; a hit's
  `time_s` is the engine's trigger time minus the record start, so the click
  and the hits share one clock.
- Placement (`lib/pads/grid.ts: placeHit`): nearest 16th at the tempo
  (`60 / bpm / 4`), `bar` and `step` 0-based, `offset_ms` = measured minus
  grid, positive late, rounded to 1 µs. Steps per bar follow the meter
  (`grid.beatsPerBar` × 4).
- Hits are taken from half a 16th before the record start (an early "one")
  and, for a fixed length, until the end; a hit that rounds to the step just
  past the end of a fixed take is folded onto bar 1 step 1 with its early
  offset (`placeTake`), so a looped pattern keeps its feel; such hits are
  marked "(folded)" in the step view's title.
- The step view is one row per pad that was hit, 16 columns per bar, beat
  and bar rules, each hit cell showing its offset in ms (`+12`, `-8`),
  the current column amber while recording, hits placed live as they land.
- "Save as MIDI" posts the raw hits with `bars` (the chosen length, or the
  whole bars the hits cover for an open take) and `beats_per_bar`. The .mid
  has one note per hit at the measured time, pitch 36 + pad (C1 upward, the
  GM pad layout), 100 ms long, on channel 10, with the tempo and time
  signature meta. A note that would start before zero (an early one) lands
  at 0; its offset survives in the row's `notes` JSON. PPQ is 960 because
  `@tonejs/midi` rounds to whole ticks (0.69 ms at 90 BPM instead of 1.39).
- The `midi` row: kind `drums`, `notes = { notes: [{ pitch, start_s, end_s,
  velocity (1–127), pad, chop_file_id, bar, step, offset_ms }], meta: { bpm,
  source: "pads", beats_per_bar, bars, quantized: false }, hits }`. The
  `notes` entries mirror `chops/midi.py: NoteEvent.to_json`, so the piano
  roll can treat pads MIDI like drum MIDI from compute. `chop_file_id` is the
  library file the pad played: a chop, or the stem when the pads are bound
  to stems.

**MIDI extraction and the list**
- The four kinds queue the compute `midi` job with `{ kind }`; the route
  needs a report (tempo and grid) and the tab enables the buttons when the
  file is `ready`. The list refetches when a `midi` job for the file reaches
  `done`; a pads save prepends its row from the response. Download links
  are signed for 10 minutes with `download=`, since the storage host is
  another origin where an anchor's `download` attribute is ignored.

**Bundle**
- Built in memory with fflate and sent as one body (not chunk-streamed):
  chops stored (level 0; PCM barely deflates and a kit should open fast),
  `.mid` and `manifest.json` deflated. Chop WAVs go under `chops/` with the
  files rows' `original_filename`, MIDI under `midi/` with the object's
  basename; duplicate names get `-2`, `-3`. The cap is checked twice: from
  the stored `size_bytes` before any fetch, and as bytes arrive.
- `manifest.json`: `{ file: { id, name (original_filename), bpm, key: { tonic, mode } }, chops: [{ index, name, filename, start_s, end_s }], midi: [{ kind, filename }], generated_at }`.
  Chops whose file row is gone are skipped (listed in the plan, not in the
  zip). The client fetches the zip with `fetch` so a 409/413 `{ error }`
  shows inline, then hands the Blob to an anchor.

**General**
- The three client modules share one `apiFetch` (in `lib/api/stems.ts`)
  with the same conventions as `lib/api/client.ts: call` (JSON in and out,
  `ApiError` from `{ error }`), because `call` is not exported; see below.
- Loading and empty states say what to do; errors say what happened and
  offer Retry; job rows show queued / running N% / failed with Retry
  (`api.jobs.retry`), like the Loops tab. Numerals are in the mono face;
  no cards; amber only for the lit pad, the live record readout and the
  one primary action per view; focus rings are the global amber outline.

## Things needed in shared files (not edited; for the lead)

- `lib/api/client.ts`: export `call` (or move `apiFetch` from
  `lib/api/stems.ts` into it and delete mine). Optionally fold the three
  modules into `api.stems / api.chops / api.midi`.
- `lib/api/types.ts`: the response types now live in the three client
  modules; move them here if the single-place rule matters.
- `components/shell/Workspace.tsx`: the `onPad` handler that shows "pads
  fill with chops in Phase 3" in the top bar fires on every pad key; it can
  go now (the pads consume the same events).
- `lib/keys/commands.ts`: the two KEYMAP rows still read "(chops, Phase 3)".
- `docs/CONTRACTS.md` section 7: the routes table above.
- `lib/keys/commands.ts` could also put `e.repeat` on `PadDetail`, which
  would remove the capture-phase listener in `usePads`.

## Notes for the compute side

- Nothing new is required. The web sends exactly the params `jobs/stems.py`,
  `jobs/chop.py` and `jobs/midi.py` read. A `stems` rerun with the same
  model upserts on `(file_id, model, stem)` (compute), so the group is
  replaced, not duplicated; a different model adds a group.
- `midi` rows written by the web (pads) carry `notes.meta.source = "pads"`
  and `notes.hits`; compute-written rows have neither. Both share the
  `notes.notes[]` entry shape.
- Pads .mid objects sit next to compute's at `derived/{user}/{file}/midi/`
  as `pads-{unix ms}.mid`, never colliding with `{kind}.mid`.

## Not exercised here

No Supabase session, storage or compute in the sandbox, and no browser, so
the signed-in flows were not run end to end: the joined lists under RLS,
the admin upload of the .mid, `storage.download` in the bundle route, and
Web Audio timing (count-in, fades, the capture-order assumption for key
repeats). The pure logic (writer round-trip through `@tonejs/midi`, grid
placement, folding, binding order, keymap, manifest, zip round-trip through
`unzipSync`) is unit-tested. First signed-in run, watch for: the pad keys
double-triggering if the shell's listener ever moves to the capture phase
(then drop my capture listener and use `e.repeat` in the shell), and
`createSignedUrls` with `{ download: true }` on an older storage-js
(the option exists in 2.116).

## Proposals (PROPOSALS.md template; not appended there to avoid clashing with concurrent edits)

## Velocity from touch or MIDI input on the pads
**What it does for a producer:** Tap harder, get a louder chop, and have that land in the MIDI: pads read pointer pressure where the device reports it and note-on velocity from a USB pad controller (Web MIDI), instead of a flat 1.0 from the keyboard.
**Principle it serves:** 4, every output is editable; 2, the measured feel includes dynamics.
**Principle it risks:** None.
**What it takes:** `PointerEvent.pressure` on the pad buttons; a Web MIDI listener mapping notes 36–51 to pads; the engine and recorder already take a velocity. Half a day.
**Where it belongs:** Phase 3.
**Status:** proposed.

## Markers on the waveform for manual chops
**What it does for a producer:** Place and drag chop markers on the waveform itself, snapped to the grid like loop edges, instead of adding them at the playhead one by one.
**Principle it serves:** 4.
**Principle it risks:** None.
**What it takes:** wavesurfer markers (zero-length regions) driven from `ChopControls`' marker list; the snap helper exists (`snapTime`). A day.
**Where it belongs:** Phase 3.
**Status:** proposed.

## Quantize toggle on the pads take
**What it does for a producer:** Hear the tapped pattern back on the grid or with its feel, and choose which one the .mid keeps (the offsets are stored either way).
**Principle it serves:** 4; 7, the correction is explicit.
**Principle it risks:** 1, only if a "humanize" generator were added; keeping it to the measured offsets or zero avoids that.
**What it takes:** a `quantize` flag in `POST /api/midi/pads` (compute's `drum_midi` has the same flag), playback of the take through the engine at the placed or measured times. Half a day.
**Where it belongs:** Phase 3.
**Status:** proposed.

## Stems, chops and midi in the Realtime publication
**What it does for a producer:** Stems and chops appear on the surface the moment compute writes them, and a chat-made chop shows up without the tab watching job status.
**Principle it serves:** 5, the library is the product.
**Principle it risks:** None; RLS applies to Realtime.
**What it takes:** `alter publication supabase_realtime add table public.stems, public.chops, public.midi`; three small subscriptions replacing `useJobDone`.
**Where it belongs:** Phase 2/3 hardening.
**Status:** proposed.

## Streamed bundle for large kits
**What it does for a producer:** A 40-chop kit from a 24-bit stem set downloads as it is built instead of waiting for the whole zip in memory, and the 200 MB cap can go.
**Principle it serves:** Handoff to the DAW.
**Principle it risks:** None.
**What it takes:** fflate's streaming `Zip` with `ZipPassThrough` piped into a `ReadableStream` response; objects fetched one at a time. Half a day.
**Where it belongs:** Phase 3 hardening or Phase 10.
**Status:** proposed.
