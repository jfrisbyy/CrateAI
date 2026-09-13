# HANDOFF_export.md

Getting the song out — step 7 of the build order in `docs/PRODUCT_DIRECTION.md`
("Export to stems and a DAW-importable session"), and the answer to
OPEN_QUESTIONS 40.

Before this, a producer could get a zip of chops and MIDI out of a single
*file*. They could not get a **song** out: everything arranged on the timeline
was trapped in the app. No producer commits real projects to a tool they
cannot leave, and the direction document is explicit that this is not where the
record gets finished — the export goes to Ableton, FL or Logic and that is
correct. So the export is not a feature on top of the timeline; it is what
makes the timeline safe to use.

**What lands in the zip:** one stem per lane, rendered across the whole song
and sample-aligned; a tempo map as a MIDI conductor track and as text; a README
whose lineage section says which record each lane came from, which bars, what
was done to it and which separator made it; a `song.json` saying the same thing
as data; and every MIDI the session references. A producer drags the contents
of `stems/` onto tracks, drops them all at zero, and has their arrangement.

## Files

```
analysis/lockedgroove/export/          the render, pure: no storage, no db, no GPU
  song.py         the arrangement as it arrives, validated into dataclasses   (+ test, 19)
  render.py       one lane across the whole song, sample-aligned              (+ test, 20)
  tempo_map.py    the grid as a MIDI conductor track and as text              (+ test, in 29)
  naming.py       what the files are called                                   (+ test, in 29)
  readme.py       README.txt and song.json                                    (+ test, in 29)
  bundle.py       the zip's layout, the size cap, writing it                  (+ test, in 29)
analysis/lockedgroove/jobs/
  export.py       the only part that touches storage                          (+ test, 24)
  runner.py       KIND_PHASE gained `export` (edited, one line)
analysis/lockedgroove/db.py            JOB_KINDS gained `export` (edited, one line)
analysis/tests/
  test_export_song.py  test_export_render.py  test_export_bundle.py  test_export_job.py

web/lib/export/
  types.ts        the wire shapes and the caps both sides share
  request.ts      the zod schema the route validates
  song.ts         timeline -> request, the estimate, the naming               (+ test, 29)
  client.ts       queue one, watch it, where the zip lives
web/app/api/export/
  song/route.ts             POST: resolve ownership under RLS, queue, dispatch (+ test, 14)
  [id]/download/route.ts    GET: the zip, fetched with the caller's client     (+ test, 7)
web/components/export/
  ExportPanel.tsx  the surface: what is about to leave, and the two choices    (+ test, 12)
  useExport.ts     queue and watch
  SongExport.tsx   the two of them as one tag, so mounting it is one line
web/lib/types/db.ts   JobKind / JOB_KINDS gained `export` (edited, two lines)
supabase/migrations/
  20260913001300_song_export.sql   written, NOT applied
docs/CONTRACTS.md     section 2 (the prefix), section 5 (the kind, and its own
                      paragraph), section 7 (the two routes)
```

Nothing else was touched. `web/lib/session/**`, `web/components/timeline/**`,
`analysis/lockedgroove/{loops,stems,combine,analysis}/**` and every existing
API route are untouched; `loops/render.py` and `loops/naming.py` are imported,
not edited, so the product rounds seconds to samples and spells a key one way.

## 1. Where the song comes from, and why it is in the request

The arrangement lives in browser memory. `20260913001000_song_arrangement.sql`
is written and not applied, and `docs/HANDOFF_timeline.md` section 12 says
plainly that nothing is persisted. So the export could either wait for
persistence or carry the song itself.

**It carries the song.** `POST /api/export/song` takes the arrangement in its
body, and it lands in `jobs.params.song`. Three consequences, all deliberate:

- The export ships before persistence does, which matters because persistence
  belongs to another seam and the thing that makes the timeline safe to adopt
  should not wait on it.
- Every id in the song is **caller input**, and is treated as such (section 5).
- When the song tables land, the route grows a `{ session_id }` form that reads
  the same shape out of them. `web/lib/export/song.ts` produces the shape and
  `analysis/lockedgroove/export/song.py` consumes it; neither changes.

`web/app/api/songs/**` was left unbuilt for the same reason: there is no song
to GET yet, and a route that invents one would be a second persistence model
racing the migration that already exists.

## 2. The zip, with a worked example

One folder, so unzipping into a DAW's project directory does not scatter files
across it. Real output from `analysis/tests/test_export_job.py`'s fixture song
— three lanes (Drums from *Masquerade*, Horns from *Moonlight Highlife*, Bass
from *In The Shade* and muted), 92 BPM, F minor:

```
Midnight-Flip_92bpm_Fm/
  README.txt                          5,256 B
  song.json                           5,505 B
  tempo_map.mid                          75 B
  tempo_map.txt                         214 B
  stems/
    01_Drums_92bpm_Fm.flac          2,838,470 B
    02_Horns_92bpm_Fm.flac          1,441,443 B
  midi/
    01_Drums_drums.mid
```

Bass is not there, and the README says so by name and by its place in the song
(section 4).

### Naming

```
{position}_{lane}_{bpm}bpm_{key}.{ext}        01_Drums_92bpm_Fm.flac
```

- **Position first, zero-padded**, so an alphabetical listing — which is what
  every file browser and every DAW import dialog gives you — *is* the lane
  order the producer stacked them in. Sorting is the affordance; this is the
  cheapest way to get it.
- **The lane's name**, sanitized. "Horns / Trumpet (take 2)" becomes
  `Horns-Trumpet-take-2`: path separators become dashes rather than being
  stripped with everything before them, so a name is never silently halved,
  and leading dots and dashes are trimmed so nothing that arrives looking like
  a path leaves looking like one.
- **Tempo and key**, because these files end up in a folder with other samples
  six months from now and a stem with no tempo in its name is a stem nobody
  uses again. This is the loop renderer's rule (OPEN_QUESTIONS D.18) applied to
  a song; `bpm_token` and `key_token` are *imported from*
  `lockedgroove/loops/naming.py`, so `D#` major is `Eb` here exactly as it is
  there.
- A token the session has not measured is **omitted**, never invented: a song
  with no tempo is `Sketch/`, not `Sketch_0bpm/` (principle 2).
- Two lanes with the same name get `-2`, `-3`; nothing overwrites anything.

## 3. The format and the cap, and why

### FLAC, 24-bit, 44.1 kHz, stereo — with WAV one click away

| | FLAC | WAV |
|---|---|---|
| lossless | yes | yes |
| size, measured on the example above | **51 % of PCM** | 100 % |
| read by | Live 9+, Logic 10.4+, Reaper, Studio One, Bitwig, Cubase, FL 12+ | everything, including old hardware |
| 4 GB file ceiling | no | yes |

The decision is FLAC by default because it is lossless — so it cannot be the
lossy step the direction document warns about, the one that "everything
downstream inherits and cannot recover" — and because it roughly halves a
number that is genuinely large. The example's Drums lane is 2.84 MB where PCM
would be 5.52 MB, 51 %; the estimator uses a deliberately pessimistic 62 %,
because a cap should under-promise.

WAV is a segmented control away, because "most DAWs read FLAC" is not "every
sampler and every 2009 project does", and being unable to open your own export
is the worst possible failure for a feature whose entire purpose is leaving.
Bit depth is 16 or 24, defaulting to 24 (the loop renderer's default,
OPEN_QUESTIONS D.19); 16-bit exists mostly as a way under the cap.

Sample rate is 44.1 kHz or 48 kHz, chosen for the export, not per source: every
lane is resampled to it on load, which is what makes "every stem is the same
number of samples" true.

### The cap: 1 GiB of finished zip, refused before anything is rendered

The brief's hard case, priced out:

```
10 lanes x 240 s x 44100 Hz x 2 ch x 3 bytes = 635,040,000 B of PCM
                                      as FLAC  ~ 394 MB      fits
                                      as WAV   ~ 606 MB      fits
24 lanes x 900 s x 48000 Hz x 2 ch x 3 bytes  ~ 5.8 GB       refused
```

1 GiB clears the named case in either format with room, and refuses the shapes
that are a batch job rather than a request. Three things make the cap humane:

1. **It is checked from arithmetic first.** `estimate_bytes(lanes, length,
   rate, channels, depth, format)` runs before a single sample is downloaded,
   so a too-big song fails in about a second with the number in the message,
   not after ten minutes of rendering.
2. **The same arithmetic runs in the browser.** `web/lib/export/song.ts`
   carries the identical constants and ratios, so the panel greys the button
   and says why *before* the request is made, and the route and the job can
   never disagree with it. There is a test on each side asserting the same
   `635,040,000`.
3. **The refusal says what to do**: "Try: export as FLAC (about 40 % smaller,
   and lossless); drop to 16-bit; mute the lanes you do not need yet, or export
   a shorter section." It never suggests what the caller already did.

Two secondary ceilings are checked at parse time for the same reason: at most
24 lanes and at most 15 minutes.

**Memory, which is the other size problem.** Ten lanes of a four-minute song
held as float32 stereo at once is 847 MB resident. So the renderer works **one
lane at a time**, writes it straight to disk, drops it, and the zip is built
from files rather than in memory. A source file is downloaded once and decoded
per lane. This is why the export does not reuse `web/lib/midi/bundle.ts`, which
holds every byte of the kit in memory with fflate: at song scale that approach
is the bug.

## 4. Mute, solo and gain — the decision, and the argument for it

The requirement is that dropping every stem at zero reconstructs exactly what
the producer heard. That settles most of it.

| | what happens | why |
|---|---|---|
| **lane gain** | **baked into the stem** | Faders are lost at import. Baked, the stems sum to the mix with every fader at unity — the stated contract. The README prints each lane's dB so a producer who wants them at unity can undo it exactly. |
| **region gain** | **baked in** | Same, and a region's trim is a mix decision inside a lane that a DAW has nowhere to put. |
| **master gain** | **not baked; reported** | A master fader here is a monitoring level, not a mix decision. Baking it would make every stem quieter than its source for a reason that is not about the song. The README says the dB and says it is not applied. |
| **mute** | the lane is **not exported**, and is **named in the README** with its lineage and its place in the song | A lane you cannot hear is a decision the producer already made; a stem of pure silence is worse than no stem, because someone drags ten files in and finds one does nothing. Naming it is what stops it being a silent loss. `include_muted` renders it anyway, at its own fader. |
| **solo** | solo mode decides what is in the zip; the rest are held back and named | Same rule, and it is `mix.ts`'s rule: solo is exclusive across the session and mute wins on its own lane. |
| **limiter** | **none** | `combine/layer.py` soft-limits a *layer* because a layer is one file. Stems must sum linearly or they are not stems: the sum of limited stems is not the limited sum. |
| **normalisation** | **none** | It would silently change the balance the producer set. |
| **clipping** | **measured and shouted about** | A lane whose region gains push it over 0 dBFS is clipped by the integer encoder. The README says `*** CLIPPED: lower this lane and export again ***` with the peak, and the note reaches `jobs.result` and the panel. Quietly normalising it would be making a mix decision. |

Mute and solo are read by calling `anySoloed` / `audible` from
`web/lib/session/mix.ts` on the web side and by mirroring them in `Song.audible`
on the compute side, with tests on both, so the zip can never disagree with the
transport about what was audible.

**The one thing that is baked in and might surprise:** the session's own 2 ms
declick. `webAudio.ts` ramps every scheduled piece in and out over
`DECLICK_S = 0.002` because a region cut mid-waveform clicks. The render
applies the identical linear ramp. Leaving it out would produce a file that is
*cleaner* than what played — including across a split, where the session has a
small dip and a raw render would not — and a file that is cleaner than the
session is not the session. It is stated in the README under WHAT IS BAKED IN
AND WHAT IS NOT so nobody has to guess where a soft edge came from.

## 5. Ownership, on every object

Principle 6 is not negotiable, and this repo has a live example of it being
broken: the kit export once fetched objects with the service role and trusted
the `storage_path` on the row, so a `files` row written by hand could be made
to serve another user's audio. The route test that now guards it
(`app/api/files/[id]/bundle/route.test.ts`, "never serves bytes from another
user's storage prefix") is the shape of the bug. This export is checked in
three places, and the middle one is the one the kit export did not have.

**1. The route, under RLS, before the job row exists.**
`POST /api/export/song` collects every distinct `file_id` in the song and every
`midi_id`, selects them with the **caller's** client, and 404s naming how many
came back short. A job is therefore never created against a record the caller
cannot read, and only the ids that survived the select reach `params`.

**2. The handler, on the row and on the path.** The handler runs with the
service role, like every job handler, so the RLS check above is not available
to it. It re-resolves each id and refuses when either:

- `files.user_id != jobs.user_id` — "the song references file X, which does not
  belong to this user", or
- `owner_path_ok(storage_path, user_id)` is false — "file X points outside this
  user's storage prefix and was not read".

The second is the important one. A `files` row is a *pointer*; the user column
and the path can disagree, and only checking the path closes it. The same pair
of checks runs on every `midi_id`. There are three tests: another user's
record, another user's MIDI, and the exact kit-export shape — a row that is the
caller's whose `storage_path` is user B's. Each asserts the job fails and
nothing is written.

**3. The download route, with the caller's client.**
`GET /api/export/[id]/download` loads the *job* under RLS (so another user's
export is a 404), refuses a `storage_path` that is not under
`derived/{caller}/`, and then fetches **with the caller's Supabase client**.
The storage policy — a user may read `derived/{their id}/` and nothing else —
is what actually decides, so this cannot regress into the kit export's bug even
if someone later removes the explicit prefix check. There is a test that puts
user B's bytes behind user A's job row and asserts they are not served.

The zip itself lives at `derived/{user_id}/bundles/{job_id}.zip`, which is
already the export-bundle prefix in CONTRACTS section 2. No new prefix, no new
policy, no public bucket.

**No `files` row.** An export is a derived artefact the producer downloads, not
a library entry: nobody analyses, searches, layers or chops a zip, and giving
it a row would put it in every kind filter in the product for no benefit. It
also means the export does not consume storage quota through `files.size_bytes`
— see section 10 for why that is a loose end rather than a decision.

## 6. The tempo map

Two files, because the second one costs nothing.

**`tempo_map.mid`** — a format-1 MIDI file, 480 ticks per beat, one track,
**no notes**: `track_name`, `time_signature`, `key_signature` when the session
has a key, `set_tempo`, and `end_of_track` at the song's length. A conductor
track and nothing else, so importing it cannot drop stray notes into a project.

Who reads a tempo track on MIDI import: Logic ("use tempo from MIDI file" in
the import dialog), Reaper, Cubase, Studio One, Bitwig, Pro Tools and FL Studio
all take it; **Ableton Live** takes it when the import dialog is told to, which
is the one worth stating out loud rather than promising. The README's first
instruction gives the tempo as a number as well, because typing `92` into a
tempo field always works.

**`tempo_map.txt`** — the same grid as a header plus one row per tempo event
(`position_s`, `bar`, `bpm`, `time_signature`), with the song's length and
sample rate. Readable by a human and parseable by a script with no MIDI
library.

**One tempo, honestly.** The session's grid is a single BPM (`SessionTempo`);
nothing in the pipeline measures a tempo *curve* for an arrangement, so the map
states one tempo and does not invent a drift it has not measured. The drift
that genuinely exists is in the **records**, and it is reported where it
belongs — per lane, in the README:

```
    record      Masquerade, drums, separated: separator-a
                record tempo 95.4 BPM; resampled x0.964 to sit at 92.0 BPM
                (pitch moves with it, -63 cents)
```

The writer takes a `list[TempoEvent]`, not a scalar, and there is a test that
writes a two-event curve and reads the tempos back, so the day something
measures a tempo curve it drops straight in.

**No tempo, no map.** A session with no measured tempo has no bars — `snap.ts`
and `loopForBars` already refuse to invent one — so no `tempo_map.mid` is
written, and the README says: *"This session has no measured tempo, so there is
no bar grid in this export and none was invented. The stems still line up
exactly."*

## 7. The README, which is the part only this product can write

Every DAW can hand a producer a folder of stems. None of them can say **what
the stems are**. That is the thing a normal DAW throws away at import and the
thing the direction document says this product cannot afford to lose.

Sections, in the order a producer needs them:

1. **How to import it** — four numbered steps ending in "Put all of them at bar
   1 / 00:00:00.000, with no snapping and no nudging. Every stem is exactly
   920367 samples long at 44100 Hz."
2. **The session** — tempo and metre; the key **and the record it was measured
   on**; length in both clock time and samples; the format; and the master
   level with "NOT baked into the stems" and the reason.
3. **What is baked in and what is not** — the table in section 4, in prose.
   Includes the lanes that were not exported, by name, by their position *in
   the song*, with their provenance and how to get them.
4. **The files** — every entry in the zip with a one-line description.
5. **The stems, and where each one came from** — per lane: the file, the gain
   (with "(baked in)"), the measured peak, the record, the record's own tempo
   and the resample that fits it, the separator that made it, what the machine
   said when it offered it and with what confidence, where the record's
   downbeat is; then one line per region:

   ```
       regions     2
         bar 1.00 -> 5.00  |  Masquerade · drums · bars 1–8 · 0:00.31–0:10.37 · ×0.964 · separated: separator-a
         bar 5.00 -> 9.00  |  Masquerade · drums · bars 1–8 · 0:00.31–0:10.37 · ×0.964 · separated: separator-a
   ```

   Where it sits in the **song**, then which bars of the **record** it is.
6. **The MIDI**, 7. **Notes on this render** (clipping, a missing grid),
   8. **Provenance** — "Every second of audio in this folder came out of a file
   you uploaded... Keep this file with the stems — it is the only thing that
   can tell you, six months from now, which record bar 33 of the drums is."

**The lineage line itself is derived in the browser.** `describeLineage` in
`web/lib/session/lineage.ts` is the one place in the product that knows how to
say what a region is, and the export uses it rather than growing a second
implementation in Python that would drift. The line travels with the region and
the README writes the document around it; the structured lineage travels too,
so `readme.py` can fall back to it and a README is never blank. The line is
caller input by the time compute sees it, so it is bounded to 400 characters
and every control character is turned into a space — a producer's own readme is
still a text file and cannot be made into two.

`song.json` carries the same facts as data — including `master_gain_baked:
false`, `limiter: false`, `normalised: false`, `declick_ms: 2.0`, each stem's
peak and clip flag, and every region's lineage — so a script can read an export
without parsing prose.

## 8. The MIDI in the zip

"If the session references them, they belong in the zip." The web route
resolves `midi_ids` under RLS and passes only what survived; the handler checks
each row's `user_id` and prefix again and downloads it. Names are
`{lane position}_{lane}_{kind}.mid` — `01_Drums_drums.mid` — so a MIDI file
sorts next to the stem it belongs to and says which lane it is for.

Nothing is *discovered* by compute: the route names the ids, so the ownership
check happens in the RLS path rather than in a service-role query that has to
remember to filter. The consequence is that the caller decides which MIDI goes
in, which is also the right product answer — a producer exporting a song does
not necessarily want every pad take they ever recorded on those records.

## 9. What is tested

`cd analysis && uv run pytest -q` — **709 passing** (617 before; 92 new across
four files). `uv run ruff check .` clean.

| file | what is asserted |
|---|---|
| `test_export_song.py` (19) | lanes and regions sorted into play order; the length as the furthest region on any lane; no tempo means no bars and nothing invents one; every refusal by its message (no lanes, no regions, no file id, a region shorter than a click, a non-finite number, too many lanes, too long); control characters turned into spaces and lines bounded; lineage surviving the wire with its separator and take; a resampled region eating the record faster; mute held back and named, `include_muted`, solo deciding and mute winning on its own lane |
| `test_export_render.py` (20) | **a split abutting exactly, no gap and no overlap**; every lane written at the same length whatever is on it; a region at its own sample with silence either side; playing from its offset not the file's zero; two overlapping regions on one lane both sounding; audio past the end of the record as silence rather than an error; never writing past the buffer; lane and region gain both baked; peak measured and nothing normalised; a resampled region filling its window; **resampling moving pitch with tempo (200 Hz at rate 2 comes back at 400 Hz)**; `resample_to` exact at five ratios; the interpolation fallback with no librosa; the 2 ms ramp's shape, its cap at half a short region, and zero leaving material alone; mono coming out stereo; a missing source as a loud failure; the source array never modified |
| `test_export_bundle.py` (29) | names sorting into lane order; the key spelled as the rest of the product spells it; a tempo or key nobody measured left out; a lane name that is not a filename becoming one and never a path; duplicate names; the cap arithmetic on the brief's hard case in both formats; a refusal carrying both numbers and advice that does not repeat what the caller did; the MIDI conductor track's tempo, metre, key and end, with **no notes**; a 3/4 session; **a two-event tempo curve**; the text map; a readme that carries the derived lineage line, the separator, the reason and confidence, the record's tempo, the bar positions, what is baked in and what is not, a muted lane by name, a clipped lane in capitals, a session with no tempo, and is plain ASCII and deterministic; the manifest as data; the zip's one folder with audio stored and text deflated; the cap re-checked against real bytes |
| `test_export_job.py` (24) | the zip's exact entry list; **every stem the same length, sample rate and channel count**; a lane silent where it is not sounding; the lineage in the readme and the manifest; WAV bigger than FLAC; 16-bit; a muted lane out of the zip, named in the result and the readme, at its place in the song; `include_muted`; no tempo, no tempo map, and the reason; MIDI in the zip; **another user's record refused**, **another user's MIDI refused**, **a row whose path points outside the prefix refused**; a missing record naming itself; the cap refusing before any sample is rendered and leaving no object behind; every lane muted; each bad format by name; a URL in params refused like every other job (principle 3); metered as `cpu_seconds` on success *and* on failure; **no `files` row written** |

`cd web && pnpm test` — **1217 passing in 126 files** (1155 in 122 before; 62
new). `pnpm typecheck`, `pnpm lint` and `pnpm build` clean. Nothing existing was
changed, skipped or deleted.

| file | what is asserted |
|---|---|
| `lib/export/song.test.ts` (29) | the lineage line derived by `lib/session/lineage`; the record's bars recomputed so a trim changes what the region claims; a region with no lineage saying so; the producer's lane order as the export's position; **the audition lane held out of the song entirely**; a missing rate travelling as 1; each record named once; mute held back and named; solo deciding, mute winning; `include_muted` at its own fader; lane gain clamped the way the fader clamps it; the key attributed to its record, null when unmeasured, and **never read off a lane that is not being exported**; folder, zip and key-token naming; a filename out of anything and never a path; the estimate agreeing with the compute side's arithmetic to the byte; the brief's hard case fitting; the block matching what the job would refuse; an empty timeline; all-muted; the length from the furthest region |
| `app/api/export/song/route.test.ts` (14) | the job queued with the song in its params and dispatched; the product's defaults; **a record the caller cannot open refusing the whole export with no job row written**; the same for MIDI; the caller's own MIDI kept; all-muted 409; the cap 413 with the arithmetic and the advice; too long; no lanes; a file id that is not a library id; a region too short; a format the renderer does not write; 401; the job still created when compute is unreachable so retry works |
| `app/api/export/[id]/download/route.test.ts` (7) | the zip streamed to the user who made it with the right headers; another user's export 404; **bytes from another user's prefix never served**; 409 while rendering; 409 with compute's own reason on a failure; a job of another kind 404; a malformed id and no session |
| `components/export/ExportPanel.test.tsx` (12) | what is in the zip and what it will be called; lanes, length, grid and size before compute is spent; the key attributed to its record; a session with no tempo saying so; both formats with the reason for each; the lanes that will not be in the zip and why; an export the job would refuse blocked with the same reason and the button disabled; an empty timeline; progress and no second render; the download and exactly what landed; a clipped lane shouted about; a failure's reason |

## 10. What only a real render can confirm

There is no GPU, no Modal, no Supabase and no browser here. The arithmetic is
asserted at exact sample indices in pytest and node; the following are the
things arithmetic cannot settle, in the order a first real session should walk
them.

1. **The reconstruction, by ear.** Export a song, drop every stem at zero in
   Ableton with the faders at unity, and A/B it against the session. It should
   be indistinguishable. If it is not, the first suspect is the declick
   (section 4) and the second is the resampler — the browser's `playbackRate`
   interpolator and `librosa.resample`'s `soxr_hq` are not the same filter, and
   the export is the cleaner of the two by design. Confirm that difference is
   inaudible rather than a different musical result.
2. **FLAC into each DAW, by hand.** Live 9+, Logic 10.4+, FL 12+ and Reaper are
   documented to read FLAC; that is not the same as having dragged one in.
   Confirm each opens a 24-bit stereo FLAC and reports the right length.
3. **The tempo map into each DAW.** Confirm the conductor track sets the tempo,
   and specifically what Ableton's MIDI import dialog does with a note-free
   file — the README currently hedges this and the hedge should be replaced
   with what actually happens.
4. **A real ten-lane four-minute song, end to end.** The estimator says ~394 MB
   as FLAC; confirm the real ratio (the fixture measured 51 %, but synthetic
   drums compress unlike a record) and confirm the whole job completes inside
   Modal's CPU function timeout, which is **900 s** (`CPU_SPEC` in
   `modal_app.py`). Ten lanes of decode plus resample plus encode may not fit;
   if it does not, the fix is a longer timeout for this kind, which is a one
   line change in a file this seam did not own.
5. **Peak memory on Modal.** The renderer holds one lane (four minutes stereo
   float32 = 85 MB) plus that lane's decoded sources. A lane built from three
   different four-minute records is ~340 MB on top of it, against `CPU_SPEC`'s
   8192 MB. Watch it on a real song; if a lane ever references many long
   records, the next step is decoding only the span each region needs.
6. **Download size through Vercel.** `/api/export/[id]/download` buffers the
   whole zip into memory and returns it as one body, which is what the kit
   export does and is fine at 200 MB but is a different proposition at 600 MB.
   Confirm it survives a large export; if it does not, the fix is a short-lived
   signed URL created with the caller's client and a redirect, which keeps the
   ownership property intact (the caller's client is still what signs).
7. **A clipped lane.** Push two overlapping regions on one lane past unity and
   confirm the README's `*** CLIPPED ***` line appears with the right peak and
   that the audio is what a producer would expect.
8. **A muted lane, both ways.** Confirm the README names it at the right
   position and that `include_muted` brings it back at its own fader.
9. **A session with no tempo.** Confirm no `tempo_map.mid` is written, the
   README says so, and the stems still line up.
10. **The panel, mounted.** It has never been rendered in a browser — see
    section 11.
11. **Quota.** An export passes `dispatchJob`, so `checkJobQuota` runs; it is
    not a GPU kind, so only the `past_due` branch can block it today. Confirm
    that is the intended behaviour before a free user renders twenty songs
    (section 11).

## 11. Decisions taken, and what is not done

- **The song travels in the request, not a table.** Section 1. The alternative
  was blocking on another seam's migration.
- **No `files` row for the zip, and therefore no storage metering for it.** The
  argument for no row is in section 5. The consequence is that exports do not
  count against `PLAN_LIMITS.storage_bytes`, which is derived from
  `sum(files.size_bytes)`. Exports are also never deleted. Both are loose ends
  rather than decisions: the cheapest fix is a scheduled cleanup of
  `derived/{uid}/bundles/` older than a few days, and the honest fix is a
  `usage_events` row for export bytes, which needs a new kind in a check
  constraint and therefore another migration.
- **Export is metered as `cpu_seconds`.** The runner already writes one row per
  finished job, success or failure, so no new metering code exists and no
  migration was needed for it. It is not a GPU kind and does not consume stem
  jobs. Whether a free user should be able to render unlimited four-minute
  songs is a product question this seam did not have the standing to answer;
  the number to add, if the answer is no, is a per-month export cap in
  `lib/billing/limits.ts` and a branch in `checkJobQuota`.
- **The panel is built but not mounted.** `web/components/shell/**` belongs to
  another seam and four agents are working in parallel; editing `Workspace.tsx`
  would be a merge conflict for no gain. `SongExport.tsx` exists so mounting it
  is exactly one tag:

  ```tsx
  <SongExport
    arrangement={{ tracks: session.tracks, regions: session.regions }}
    name={songName}
    bpm={session.tempo?.bpm ?? null}
    beatsPerBar={session.tempo?.beatsPerBar ?? 4}
    masterGain={session.masterGain}
    keyOf={(id) => vitalsOf(library.file(id)?.report ?? null)?.key ?? null}
  />
  ```

  plus a `"export"` entry in the surface stack and a button in the transport
  strip. `keyOf` is optional: without it the export has no key token and the
  README says the key was not measured, which is true rather than wrong.
- **The chat cannot export yet.** The direction document's rule is that
  everything the mouse does a sentence can do. "Export the song", "bounce the
  stems", "give me this as WAV" should reach the same `start()` the button
  calls. The parser lives in `web/lib/session/commands.ts`, which this seam was
  told not to touch, so the verbs are not there. They are a small addition to
  the same command bus.
- **Progress is polled, not subscribed.** `useExport` reads the job row every
  1.5 s. An export is a one-off a producer is sitting in front of, and this hook
  has no Supabase client of its own; the swap to the `jobs` Realtime channel the
  library already subscribes to is confined to one `useEffect`.
- **One tempo, no curve.** Section 6, with the writer already shaped for one.
- **No native session format.** OPEN_QUESTIONS 40's assumption — "stems, a
  tempo map and a readme first; native formats on request" — is what shipped.
  `song.json` is deliberately complete enough that an `.als` or `.flp` writer
  could be built on top of it without re-rendering anything.
- **No region-level fades and no per-lane processing in the export**, because
  there are none in the session. When per-track EQ lands (the phase after the
  timeline), it goes into `render_track` between the region sum and the lane
  gain, and the README's "what is baked in" section is where it has to be
  declared.
- **`beats_per_bar` is 4 unless the session says otherwise.** Nothing in the
  pipeline measures metre yet; the field is carried end to end and the tempo
  map writes a 3/4 time signature correctly, with a test.
