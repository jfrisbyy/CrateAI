# HANDOFF: Layers tab, Re-voice tab, Beatbox page (web, Phases 7 and 9)

The combine surface (stacked lanes), the re-voice surface (render plus an
editable piano roll), and `/beatbox` (enrollment, transcription, corrections),
with their routes and client modules. Everything sits on the compute handlers
in `analysis/lockedgroove/jobs/{layer,revoice,beatbox_train,beatbox_transcribe}.py`
and the conventions in `docs/HANDOFF_web.md` (tokens, `lib/http`, `lib/api/client`
fetch shape, jobs live in `LibraryProvider`).

## Files

| File | What it is |
|---|---|
| `web/lib/pianoroll/time.ts` (+ `.test.ts`, 12 tests) | Tempo-grid arithmetic shared by the lanes and the roll: `stepSeconds` / `snapSeconds` / `floorSeconds` for bar, beat, 16th, free at 60 / bpm; `toBarsBeats` / `formatBarsBeats` ("1.2.3", "-0.1.0", "+" marks a free remainder); signed seconds; ruler labels. |
| `web/lib/pianoroll/model.ts` (+ `.test.ts`, 15 tests) | The note editing model: `fromNotesJson` (the compute's `midi.notes.notes`), `toNotesJson` (exactly what `params.notes` carries back: pitch, start_s, end_s, velocity), `moveNote`, `resizeNote`, `addNote`, `deleteNotes`, `setVelocity`, `pitchBounds`, `totalBeats`, `noteName`. |
| `web/lib/beatbox/wav.ts` (+ `.test.ts`, 6 tests) | PCM16 WAV encoder/decoder, mono mixdown, `blobToWav(blob, decode)`. |
| `web/lib/beatbox/onsets.ts` (+ `.test.ts`, 8 tests) | `OnsetCounter`: the hit counter behind the recorder (fast rise above a floor, 60 ms gap, re-arm after a 10 dB fall); `rmsOf`, `dbOf`. |
| `web/lib/beatbox/stepview.ts` (+ `.test.ts`, 6 tests) | Step view built from `notes.hits` so every cell keeps its `hit_index`; `setCorrection`, `hitsOf`, `correctionsOf`, `classLabel`. |
| `web/lib/beatbox/recorder.ts` | MediaRecorder session with an AnalyserNode (`startRecording`, `pickMimeType`, `levelOf`, `describeMicError`). Browser only. |
| `web/lib/beatbox/upload.ts` | `uploadRecording`: decode the recording with the AudioContext, write 16-bit mono WAV, ask for the signed URL, upload with `uploadToSignedUrl`. Falls back to the webm bytes only when the browser cannot decode its own recording. |
| `web/lib/api/layers.ts` | Client for `/api/layers/**`, request/response types, `layerIdOf(job)`, `layerJobResult(job)` (plan + applied), `itemAtDefaults`. |
| `web/lib/api/revoice.ts` | Client for `/api/revoices/**` and `/api/files/[id]/revoices`; `INSTRUMENTS` (mirrors `revoice/symbolic.py`), `NEURAL_REASON` (mirrors `revoice/neural.py`), `ACCURACY_NOTE`, notes-JSON helpers. |
| `web/lib/api/beatbox.ts` | Client for `/api/beatbox/**` including `uploadToSigned`; `trainResultOf`, `transcribeResultOf`, `transcriptionMetaOf`. |
| `web/app/api/layers/route.ts`, `[id]/route.ts`, `[id]/items/route.ts`, `[id]/items/[itemId]/route.ts`, `[id]/render/route.ts`, `vitals.ts`, `load.ts` | Layers routes (below) plus the lane-vitals and load helpers (non-route files: Next refuses extra exports from `route.ts`). |
| `web/app/api/revoices/route.ts`, `[id]/route.ts`, `web/app/api/files/[id]/revoices/route.ts` | Re-voice routes. |
| `web/app/api/beatbox/profile`, `upload-url`, `train`, `transcribe`, `transcriptions`, `transcriptions/[midiId]` (`route.ts` each), `paths.ts` | Beatbox routes and the recording-path helpers. |
| `web/components/layers/shared.tsx` | `jobText`, `isActive`, `useJobDone` (refetch when a matching job reaches done), `PlayButton` (signed URL, one playing at a time), `OpenButton`, `DownloadButton`, `RetryButton`, `ProgressLine`. Used by all three surfaces; candidates for `components/ui`. |
| `web/components/layers/fields.tsx` | `NumberField` (commits on blur/Enter, blank = null when allowed) and `NameField` (inline rename). |
| `web/components/layers/plan.ts` | `predictPlan`: `plan_alignment` from `combine/align.py` ported, so a lane at its defaults shows what the render will do. |
| `web/components/layers/LaneTimeline.tsx` | Ruler and the draggable lane block (bar/beat grid at the target tempo, peaks inside, the part before zero dimmed, keyboard nudge, `role="slider"`). |
| `web/components/layers/LaneRow.tsx` | One lane: vitals with confidence dots, block, offset readout (bars.beats.16ths and seconds), gain −/+, stretch mode, ratio, pitch, HP/LP, mute, reset to auto, remove. |
| `web/components/layers/AddLanePicker.tsx` | Ready library files (open file first), filtered by name, with BPM and key. |
| `web/components/layers/LayerEditor.tsx` | The layer: name, target tempo and key (blank = first lane's), snap, Add lane, Render, job status with retry, render file (play, Open, Download), the applied plan, lanes. |
| `web/components/surface/LayersTab.tsx` (replaced stub) | Layers containing the open file, New layer with this file, the editor for the selected one. |
| `web/components/revoice/PianoRoll.tsx` | SVG roll: pitch rows, beats and 16ths at the file's tempo, notes as blocks; drag to move (16th snap or free) and change pitch, right-edge resize, click to add, Delete, arrows. |
| `web/components/revoice/NotesEditor.tsx` | Roll plus the selected note's readouts and velocity field, snap toggle, revert, instrument and keep-groove for the re-render, "Re-render with these notes". |
| `web/components/surface/RevoiceTab.tsx` (replaced stub) | Instrument select, path radios (neural disabled with the compute's reason), keep groove, Re-voice, the accuracy note shown until dismissed, the results list with renders and editors. |
| `web/components/beatbox/Recorder.tsx`, `Enrollment.tsx`, `Transcription.tsx`, `StepView.tsx`, `BeatboxPage.tsx` | The page: level meter and hit counter, three enrollment steps with takes and Train, free-tempo or file-grid transcription, step view with corrections and MIDI download. |
| `web/app/(app)/beatbox/page.tsx` | `/beatbox` inside the workspace shell. |
| `web/components/shell/TopBar.tsx` (one edit) | A "Beatbox" link to `/beatbox` before the `?` button. Nothing else in the file changed. |

## Commands run and results

| Command (from `web/`) | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0, no warnings |
| `pnpm test` | 36 files, 322 tests passed (47 of them in `lib/pianoroll` and `lib/beatbox`) |
| `pnpm build` | exit 0; `/beatbox` 10.7 kB (204 kB first load); every route under `/api/layers`, `/api/revoices`, `/api/files/[id]/revoices`, `/api/beatbox` compiled |

Not exercised here (no browser, Supabase session or compute in the sandbox):
the pointer interactions, MediaRecorder, the signed upload, and the three job
kinds end to end. The pure logic (grid math, the note model, WAV, onset
counting, the step view and corrections) is unit-tested; the routes are typed
against the real client and follow `api/loops` line for line. First signed-in
run, watch for: the drag scale after a window resize (a ResizeObserver on the
ruler cell drives `pxPerSec`), `decodeAudioData` on the browser's own webm/opus
recording (Chrome, Firefox and Safari decode their own output; the fallback
uploads webm as recorded), and the profile refetch after a train job (via
Realtime on `jobs`).

## Routes (for CONTRACTS.md section 7)

| Route | Method | Does |
|---|---|---|
| `/api/layers?file_id=` | GET | the caller's layers that contain the file, each with its items |
| `/api/layers` | POST `{ name?, file_ids[] }` | a layer with one lane per file, in order, at the defaults (stretch 1, pitch 0, offset 0, gain 0); default name from the file names; returns `{ layer, items, files }` where `files` are the lanes' vitals from `effective()` |
| `/api/layers/[id]` | GET, PATCH `{ name?, tempo_bpm?, key? }`, DELETE | one layer with items and vitals; the target tempo and key (null = the first lane's); delete (the render stays in the library) |
| `/api/layers/[id]/items` | POST `{ file_id }` | add a lane at the end (max 16) |
| `/api/layers/[id]/items/[itemId]` | PATCH, DELETE | `offset_s` (±3600), `gain_db` (−60..24), `stretch_ratio` (0.25..4), `pitch_semitones` (±24), `muted`, `stretch_mode`, `filter { highpass_hz, lowpass_hz }` (null or both blank clears it; HP must sit below LP), `position` |
| `/api/layers/[id]/render` | POST | jobs row `kind='layer'`, `file_id=null`, `params { layer_id }`, dispatched; 409 with no lanes or every lane muted |
| `/api/files/[id]/revoices` | GET | the file's revoices, newest first, each with its `midi` row and render file (`id, original_filename, status, duration_s, kind`) |
| `/api/revoices` | POST `{ file_id, instrument, path, keep_groove?, notes? }` | jobs row `kind='revoice'` with `params { instrument, path: "symbolic", keep_groove, notes? }`; `instrument` must be in `INSTRUMENTS`; `path: "neural"` answers 400 with `neural.REASON`; 409 unless the file is `ready` |
| `/api/revoices/[id]` | GET | one revoice with midi and render |
| `/api/beatbox/profile` | GET | `{ profile }` or `{ profile: null }` |
| `/api/beatbox/upload-url` | POST `{ name }` | `{ storage_path, signed_url, token }` for `library/{uid}/beatbox/{safe}.wav|webm` (admin client; falls back to the caller's client, which the storage insert policy on `library/{uid}/` allows) |
| `/api/beatbox/train` | POST `{ examples: [{ class, storage_path }] }` | jobs row `kind='beatbox_train'`; every path must be under the caller's `library/{uid}/beatbox/`; at least two classes |
| `/api/beatbox/transcribe` | POST `{ recording_path, grid_file_id?, bpm? }` | jobs row `kind='beatbox_transcribe'` (`file_id=null`); one of `grid_file_id` / `bpm` required; 409 without an enabled profile or when the grid file has no report |
| `/api/beatbox/transcriptions` | GET | midi rows of kind `beatbox`, newest first, each with a 10-minute signed download URL (`download: true`) |
| `/api/beatbox/transcriptions/[midiId]` | PATCH `{ corrections: [{ hit_index, corrected_class }] }` | replaces `notes.corrections` (and sets `notes.corrected_at`) on the caller's midi row; `hit_index` must address an existing hit |

## Interpretation choices

- **Auto lanes and the first hand edit.** The compute applies its plan only to
  items still at the defaults (stretch 1, pitch 0, offset 0) and writes the
  plan back to the row. A lane at the defaults is shown as "auto" with the
  predicted plan (`components/layers/plan.ts`, a port of `plan_alignment`);
  its block sits where the plan will put it. The first drag of the offset or
  edit of the pitch on such a lane sends the predicted stretch and pitch
  along with the change, so a nudge never turns tempo matching off. "Reset
  to auto" sends the three defaults so the next render plans the lane again
  (the way to pick up a changed target tempo on an already-rendered lane).
- **Non-tonal detection** in the vitals uses the report's `tags` and the
  "drums" stem name, the same terms as `align.py NON_TONAL_TAGS` but read from
  `files.report` rather than the `tags` table; the applied plan in the job
  result is shown once a render exists and wins over the prediction.
- **Stretch ratio is derived, not typed.** The packet's per-lane controls
  are offset, gain, stretch mode, pitch, mute (plus the filters); the ratio
  follows the target tempo and is shown read-only with the plan's reason.
- **Layer jobs carry `file_id = null`** (they belong to the layer, not to
  one of its files); the tab finds them by `params.layer_id`. Beatbox jobs
  also carry `file_id = null` (`grid_file_id` stays in params) so a file's
  library row does not show a transcription as its own progress.
- **Negative offsets** are drawn left of the layer's zero line with the
  cropped part dimmed, matching `render_layer` (lanes before t = 0 are cut).
- **The timeline scale** is the target tempo (`layer.tempo_bpm`, else the
  first lane's BPM, else 120), 4 beats per bar (layers have no meter column).
  Snap offers bar / beat / 16th / free; arrows nudge by the snap step, Shift
  by a bar, Home to zero.
- **Piano roll units.** Beats come from the midi row's `bpm` (the compute
  writes it), falling back to the file's effective tempo. Snap is 16ths or
  free; the drawn pitch range and length only widen while editing so the
  roll does not jump under the pointer. Re-render posts a new revoice (a new
  row and render); the previous one stays in the list.
- **Neural path** is offered as a disabled radio with "evaluated in Phase 7,
  not shipped" and the compute's full reason in the title; the route refuses
  it with the same text instead of queueing a job that would fail with it.
- **The accuracy note** (BUILD_PACKET section 10) shows until dismissed,
  remembered per browser in `localStorage`.
- **Recording format.** MediaRecorder gives webm/opus in Chrome, Firefox and
  Edge and mp4 in Safari; `audio/wav` is supported nowhere. Every take is
  decoded with the AudioContext and uploaded as 16-bit mono WAV so the
  compute reads it with libsndfile and the local runner needs no ffmpeg; if
  decoding fails and the recording is webm, the webm goes up as is (the
  compute image has ffmpeg). Gain control, echo cancellation and noise
  suppression are off on the microphone so hits keep their transients.
- **The hit counter is feedback, not the dataset.** The compute segments the
  uploaded recording itself (`beatbox/features.py detect_onsets`); the
  browser's counter (`OnsetCounter`) exists so the user sees 1…20.
- **Corrections** are stored on the transcription's midi row as
  `notes.corrections = [{ hit_index, corrected_class }]` (the whole list
  replaces the previous one; `corrected_class === predicted` removes the
  entry). The step view is rebuilt from `notes.hits` so indices are exact.
  Retraining from them is compute work (below).
- **Enrollment takes** are per session: the page does not list earlier
  uploads under `library/{uid}/beatbox/`; a new Train replaces the profile
  (the compute upserts on `user_id`). Classes come from the profile when one
  exists, else kick, snare, hat (OPEN_QUESTIONS I.30).

## For the compute side

- `revoice` receives `params.notes` as `[{ pitch, start_s, end_s, velocity }]`
  (nothing else), `keep_groove` always present, `path` always `"symbolic"`.
- `layer` jobs have no `file_id`; `result.plan` and `result.applied` are
  read by the tab (shapes as written today).
- **Retraining hook (packet: "corrections feed the next enrollment").**
  `beatbox_train` could add, for the user's transcriptions that carry
  `notes.corrections`, the corrected hit segments (from `notes.hits[i].time_s`
  in the recording at `params.recording_path` of that transcribe job) as
  examples of `corrected_class`. Nothing on the web side needs to change for
  it: the rows are already there. Proposed below.

## For shared files (not edited here)

- `docs/CONTRACTS.md` section 7: the route table above. Section 5: the
  `revoice` params gained `notes?` and the `layer` job's `result.applied`.
- `components/layers/shared.tsx` (`PlayButton`, `jobText`, `useJobDone`,
  `RetryButton`) duplicates what LoopsTab keeps privately; both could move to
  `components/ui` when the lead wants one copy.
- `KeymapSheet` could list the roll and lane keys (Delete, arrows, Home).

## Proposals (PROPOSALS.md template)

## Corrections retrain the beatbox profile
**What it does for a producer:** Fixing a mis-heard hit in the step view makes the next enrollment better without recording anything new: the hits you corrected become examples of what you meant.
**Principle it serves:** 7, user corrections are ground truth; 2.
**Principle it risks:** None; the corrections stay with the user's own profile.
**What it takes:** In `jobs/beatbox_train.py`, read the user's `midi` rows of kind `beatbox` with `notes.corrections`, cut the corrected hits from the recording named in the transcribe job's `params.recording_path`, and append them as `Example`s before `train()`. Half a day plus a test with a synthetic correction.
**Where it belongs:** Phase 9.
**Status:** proposed.

## Audition the edited MIDI in the browser
**What it does for a producer:** Hear the fixed notes at once, with a plain tone, before spending a render on them.
**Principle it serves:** 4, every output is editable.
**Principle it risks:** None; it is a preview of the user's own notes.
**What it takes:** A small Web Audio synth (oscillator plus envelope, the shape of `render_simple` in `symbolic.py`) scheduled from `toNotesJson`, a play button and a playhead line on the roll. A day.
**Where it belongs:** Phase 7 hardening.
**Status:** proposed.

## Preview mix of a layer before rendering
**What it does for a producer:** Drag a lane and hear the result now: the lanes summed in the browser at their offsets and gains (unstretched, or stretched with the loop preview's engine when the ratio is near 1), before the compute renders the real thing.
**Principle it serves:** 4.
**Principle it risks:** None.
**What it takes:** `decodeFromUrl` per lane, a scheduler over `AudioBufferSourceNode`s with `playbackRate` for small ratios, mute and gain live. Two days; the honest preview for large ratios needs a client stretch.
**Where it belongs:** Phase 7 hardening.
**Status:** proposed.

## A loop region as a lane
**What it does for a producer:** "The drums from this" is usually two bars, not the whole record. Pick a loop from the Loops tab as the lane instead of the file.
**Principle it serves:** 5, the library is the product; 4.
**Principle it risks:** None.
**What it takes:** Today: export the loop (a `loop_render` file) and add it as a lane, which works. Direct: `layer_items.start_s` / `end_s` (one migration), the compute slicing before `apply_plan`, a loop picker next to the file picker. A day.
**Where it belongs:** Phase 7 hardening.
**Status:** proposed.

## More beatbox classes
**What it does for a producer:** Open hat, clap, rim, tom as extra sounds to enroll; the class list already lives on the profile.
**Principle it serves:** 2.
**Principle it risks:** Accuracy drops with more classes; mitigated by the 85 % gate and per-class counts in the result.
**What it takes:** An "add a sound" control on the enrollment (a name, lowercase), `GM_DRUMS` already maps the names. Hours.
**Where it belongs:** Phase 9+ (OPEN_QUESTIONS I.30).
**Status:** proposed.
