# HANDOFF: loops (Phase 1 core: finder, renderer, naming, client port)

Owner of this seam: the loops agent. Scope: BUILD_PACKET section 7, OPEN_QUESTIONS
C.16 and D.18–20. Nothing outside the files below was touched (no analysis stages,
no jobs, no web files other than the two named ones, no git).

## Files

| Path | What |
|---|---|
| `analysis/lockedgroove/loops/__init__.py` | public surface: `find_loops`, `LoopCandidate`, `render_loop`, `export_wav`, `loop_filename`, helpers, constants |
| `analysis/lockedgroove/loops/finder.py` | `find_loops(y, sr, report, bars=(1, 2, 4, 8), top_k=12) -> list[LoopCandidate]` |
| `analysis/lockedgroove/loops/render.py` | `render_loop(...) -> (out, meta)`, `export_wav(...)`, `snap_to_zero_crossing`, `equal_power_curve` |
| `analysis/lockedgroove/loops/naming.py` | `loop_filename(...)`, `key_token`, `bpm_token`, `sanitize_base` |
| `analysis/tests/test_loop_finder.py` | 22 tests on `synth.loop_based_track` and purpose-built signals (reports built from truth, never from the stages) |
| `analysis/tests/test_loop_render.py` | 20 tests: seam click, snap bound, self fallback, WAV round trip, shared vector, vector freshness |
| `analysis/tests/test_loop_naming.py` | 43 parametrized cases |
| `analysis/tests/fixtures/loop_render_vector.json` | shared vector, 121.5 KB, generated (do not edit by hand) |
| `scripts/gen_loop_vector.py` | vector generator; `--check` exits 1 when stale (a test runs it) |
| `web/lib/audio/renderLoop.ts` | sample-exact TypeScript port; no dependencies; browser and Node |
| `web/lib/audio/renderLoop.test.ts` | vitest; loads the vector via `new URL(..., import.meta.url)` |

`docs/PROPOSALS.md` was **not** edited (other agents append to it concurrently);
the proposals are at the bottom of this file in the template, ready to paste.

## Commands and results

```
cd analysis && /home/user/crateai-venv/bin/python -m pytest tests/test_loop_finder.py tests/test_loop_render.py tests/test_loop_naming.py -q
  85 passed

cd analysis && /home/user/crateai-venv/bin/python -m pytest tests/test_report_schema.py tests/test_ingest_pipeline.py -q
  pre-existing suites still pass

cd analysis && /home/user/crateai-venv/bin/python -m pytest tests/test_job_render_loop.py tests/test_job_analyze.py -q
  18 passed, 1 skipped  (the jobs agent's render_loop and find_loops tasks, run against these modules,
                         including test_render_loop_with_the_real_renderer and the naming expectation
                         "Soul-Sample-#2_88bpm_Bb_4bar.wav")

python scripts/gen_loop_vector.py --check
  up to date

ruff check lockedgroove/loops tests/test_loop_*.py ../scripts/gen_loop_vector.py
  clean (repo config: E, F, I, W, B, UP; line length 110)

tsc --strict --noEmit (ES2020 + DOM libs) on web/lib/audio/renderLoop.ts
  clean (tsc 6.0.2)

cd web && node_modules/.bin/vitest run lib/audio/renderLoop.test.ts   (the web package's own
                                               vitest.config.ts, environment node, once the web
                                               agent's package.json and node_modules had landed)
  10 passed
  (also 10 passed earlier under a scratch-directory vitest 3.2.7 mirror of the web/ + analysis/ layout)

esbuild bundle of a verify script + node against the vector (the fallback the lead suggested)
  primary / self_mode_end_of_file / no_snap / mono_short_crossfade / whole_file_raw:
  exact meta, worst |diff| 5.0e-8 (the 7-decimal rounding of the stored values)
```

The TypeScript port is float32-exact with Python on every vector case, not merely
within 1e-4.

## API for the compute (jobs) side

### `find_loops(y, sr, report, bars=(1, 2, 4, 8), top_k=12) -> list[LoopCandidate]`

- `y`: mono `(n,)` or stereo `(2, n)` (also `(n, channels)`) float; pass the native
  audio, the finder mixes to mono and resamples to 22050 Hz internally for features.
- `report`: the **raw** `AnalysisReport`; `effective()` is applied inside, so user
  edits to tempo, downbeat phase, first downbeat and meter drive the grid.
- Needs `report.beats` (else `[]`). Uses `report.structure` (novelty; no penalty when
  null), `report.onsets` (detects locally when null), `report.tempo` (only as a
  fallback period).
- `top_k=None` returns every candidate. Results are sorted by score descending, no
  duplicates.
- Runtime: ~0.5 s per 90 s track once librosa is warm (first call ~2 s for numba
  JIT). Memory: one 64-band log-mel of the track.

`LoopCandidate` fields: `start_s`, `end_s`, `bars`, `score` (in [0, 1], 4 decimals),
`components`, `origin="finder"`, `name`. `duration_s` property.

`LoopCandidate.to_row()` returns exactly the finder-owned `loops` columns:

```python
{"start_s": float, "end_s": float, "bars": int, "score": float, "origin": "finder",
 "components": {...jsonb-safe...}, "name": "4 bars from bar 9"}
```

Add `user_id`, `file_id` and insert. `render_file_id` is filled by the `render_loop` job.

`components` (all JSON-serializable):

| key | meaning |
|---|---|
| `seam`, `stability`, `novelty`, `onset_lock` | the four scored terms, each in [0, 1] |
| `weights` | `{"seam": 0.4, "stability": 0.25, "novelty": 0.25, "onset_lock": 0.1}` so the UI can show the formula |
| `seam_raw` | tail -> head similarity: what **raw** (uncrossfaded) playback wraps |
| `seam_wrap` | what the **rendered** wrap plays (post-end audio -> head; pre-start -> tail at end of file) |
| `seam_mel`, `seam_rms` | the mel-cosine half and the RMS-continuity half of `seam` |
| `onset_distance_ms` | nearest onset to the start (null when there are no onsets) |
| `interior_boundaries` | structure boundaries strictly inside the loop |
| `repeats` | how many contiguous repeats of the same content were folded onto this one |
| `grid` | `"downbeats"` or `"beats"` (OPEN_QUESTIONS C.16, threshold `DOWNBEAT_CONFIDENCE_THRESHOLD = 0.5`) |
| `bar_index` | 0-based index of the start downbeat (null in beats mode) |
| `extrapolated_end` | true when the end is the one extrapolated bar past the last measured anchor |
| `matches_loop_period` | `bars == structure.loop_period_bars` |
| `reasons` | short strings for chips and chat: "starts on a downbeat", "tail flows into the head", "crosses 1 section boundary", "repeats 1x right after", ... |

### `render_loop(y, sr, start_s, end_s, crossfade_ms=12.0, snap_zero_crossing=True) -> (out, meta)`

- `out`: `(channels, end - start)` float32, same channel count as the input; mono
  `(n,)` comes back as `(1, n)`.
- `meta`: `start_s`, `end_s` (after snapping), `start_sample`, `end_sample`,
  `crossfade_ms` (requested), `crossfade_samples` (effective), `mode` (`"tail"` |
  `"self"`), `snapped_start_ms`, `snapped_end_ms` (signed shift each edge moved),
  plus `sample_rate`, `channels`, `length_samples`. Put it in `jobs.result`.
- Raises `ValueError` on `end_s <= start_s`, empty audio, or a loop that is empty
  after rounding to samples.

### `export_wav(path, y, sr, bit_depth=24) -> str`

PCM_24 default, PCM_16 allowed, anything else `ValueError`. Accepts `(channels, n)` or
`(n,)`. Source sample rate only (D.19).

### `loop_filename(base_name, bpm, tonic, mode, bars, stem=None, ext="wav") -> str`

`{base}[_{stem}]_{bpm}bpm_{key}_{bars}bar.wav`. Suggested call from the job:
`loop_filename(file.original_filename, effective.tempo.bpm, effective.key.tonic,
effective.key.mode, loop.bars, stem=<stem type when file.kind == "stem">)`.
`bpm` and the key may be `None` (token omitted rather than invented). The base's
audio extension is stripped, spaces become `-`, only `[A-Za-z0-9._#-]` survives,
paths reduce to their basename, length capped at 80.

Storage path per CONTRACTS.md: `derived/{user_id}/{file_id}/loops/{loop_id}.wav`;
the filename above is the download name.

## API for the web side

`web/lib/audio/renderLoop.ts` exports:

```ts
renderLoopPreview(channels: Float32Array[], sampleRate: number, startS: number, endS: number,
                  opts?: { crossfadeMs?: number; snapZeroCrossing?: boolean })
  -> { channels: Float32Array[]; startS: number; endS: number; meta: RenderLoopMeta }
snapToZeroCrossing(channels: Float32Array[], sampleRate: number, sampleIndex: number, maxMs?: number) -> number
equalPowerCurve(n: number) -> { fadeIn: Float64Array; fadeOut: Float64Array }
monoSum(channels), snapMonoToZeroCrossing(mono, sampleRate, sampleIndex, maxMs?), roundHalfUp(x)
DEFAULT_CROSSFADE_MS = 12, ZERO_CROSSING_MAX_MS = 2
types RenderLoopOptions, RenderLoopMeta, RenderLoopResult, LoopRenderMode
```

- The stub signature is honoured exactly; `meta` is an addition (camelCase mirror of
  the Python `meta`: `startSample`, `endSample`, `crossfadeMs`, `crossfadeSamples`,
  `mode`, `snappedStartMs`, `snappedEndMs`, `sampleRate`, `channels`, `lengthSamples`).
- Feed it `audioBuffer.getChannelData(c)` for each channel; build the preview
  `AudioBuffer` from the returned `channels`. With the same `crossfadeMs` and
  `snapZeroCrossing` the server export is sample-identical to the preview.
- `startS` / `endS` in the result are the **snapped** edges; show the shift
  (`meta.snappedStartMs`) so a drag that moved 0.3 ms is not a mystery.
- Raw playback: `renderLoopPreview(..., { crossfadeMs: 0 })` (snapping still applies)
  or a plain slice when snapping is off too.
- `mode === "self"` means the loop ends at the end of the file and the blend sits at
  the tail (see interpretation 10); `crossfadeSamples === 0` with `mode === "self"`
  means the loop is the whole file and the cut is raw.
- The vitest file resolves the fixture with
  `new URL("../../../analysis/tests/fixtures/loop_render_vector.json", import.meta.url)`
  and reads it with `node:fs`; it runs under the default node environment (and under
  jsdom, which is node underneath).
- `components.reasons` are ready-made chip texts; `components.seam_raw` vs
  `components.seam_wrap` say whether a loop needs the crossfade to sound right.
- `name` is pre-filled ("4 bars from bar 9" / "2 bars at 12.34s"); the UI may rename.

## Interpretation choices (numbered for PR descriptions)

1. **Seam averages raw and rendered wrap.** The packet's seam is "mel cosine between
   the last 100 ms and the first 100 ms plus RMS continuity". Implemented verbatim
   as `seam_raw`, that measure prefers loops that cut mid-sustain (tail and head are
   the same chord) and scores the true 4-bar loop of `loop_based_track` at ~0.26
   because Cm -> Fm across the loop point is anti-correlated; the packet's own
   acceptance test (a 4-bar loop on a true downbeat, high seam, in the top
   candidates) could not pass. The renderer's wrap is not tail -> head: it plays the
   audio *after* `end` crossfaded into the head. So `seam_wrap` measures exactly that
   pair (post-end 100 ms -> head; at end of file, tail -> pre-start 100 ms, which is
   what self mode plays) with the same two measures, and `seam = mean(seam_raw,
   seam_wrap)`. Raw playback and rendered playback are both in the Loops tab, so both
   count. Result on the synthetic: true 4-bar loops have `seam_wrap` 1.00, seam
   0.62–0.64, and two of them sit in the top 12 alongside 1- and 2-bar loops of the
   same material (which are also legitimate loops). Weights are unchanged.
2. **Mel cosine on mean-removed log-mel.** Plain log-mel vectors share a large dB
   floor and every pair scores ~0.95. The per-bin track mean is removed (CMN-style),
   cosine is then in [-1, 1] and mapped to [0, 1]. Features: 22050 Hz, n_fft 1024,
   hop 256, 64 mels, top_db 80.
3. **RMS continuity** is `min/max` of the two window RMS values (a 6 dB step scores
   0.5), 0 when both windows are below −60 dBFS.
4. **Stability** is `1 − var/mean²` of per-beat RMS (beats from the effective grid
   inside the loop; even subdivision when fewer than two beats fall inside),
   clipped to [0, 1]; 0 for a loop with no energy.
5. **Novelty** is `1 / (1 + Σ confidence)` over structure section starts that lie
   more than half a beat inside both edges (a boundary at the loop's own edge is not
   interior). `structure` null -> 1.0. Confidence-weighted so a doubtful boundary
   penalizes less (principle 2).
6. **Onset lock** exactly as specified (1 at ≤20 ms, linear to 0 at 80 ms); onsets
   from `report.onsets` or `librosa.onset.onset_detect(backtrack=True)` at 22050 Hz
   when the section is null.
7. **Grid extension.** One bar's worth of anchors (one downbeat, or beats-per-bar
   beats) is extrapolated past the last measured anchor at the median period when it
   lands inside the file (tolerance 1 ms, clamped to the duration). Without it the
   last bar of a track can never be a loop. Flagged `extrapolated_end`.
8. **Beats mode** (downbeat confidence < 0.5, or no downbeats): every beat is a
   start, bars are `beats_per_bar(meter)` beats, same 6/8 -> 2 rule as `report.py`
   (reimplemented locally; the report's helper is private).
9. **Dedupe.** Near-identical: same bar count, starts within 30 ms and lengths
   within 30 ms -> higher score wins. Contiguous repeats: per bar count, a candidate
   whose start is within half a beat of an open chain's end and whose fingerprint
   (mean-removed log-mel on a 16-bins-per-bar grid, flattened, mean-subtracted)
   has cosine ≥ 0.90 with the chain head folds onto the head. Measured: identical
   repeats 1.00, humanized-drum repeats 0.99, same chord different bar 0.63, A vs B
   0.28. The two halves of the synthetic B section (a 3-note arpeggio that changes
   phase every 4 bars) score 0.63 and stay separate, which is right: they are
   different loops.
10. **Self mode is a pre-start blend at the tail, not the literal tail-into-head
    mix.** Mixing the loop's own last 12 ms into its head leaves a jump at the wrap
    from `y[end−1]` (near a zero crossing) to `y[end−cf]` (an arbitrary sample 12 ms
    earlier): for a 100 Hz bass at 0.5 amplitude that is a ~0.47 step every cycle,
    an audible click, in exactly the case the fallback exists for. Instead the
    crossfade moves to the tail and fades in the audio that *precedes* `start`
    (`n_pre = min(cf, start)` samples), so the wrap is `y[start−1] -> y[start]`,
    the recording's own continuity — the mirror image of tail mode and what samplers
    do for loop crossfades. `mode` is still `"self"` and the meta contract is
    unchanged. When there is no audio before `start` either (the loop is the whole
    file) the cut is raw with `crossfade_samples = 0`. Switching to the literal
    behaviour is a three-line change in each language plus regenerating the vector.
11. **Equal-power curve**: `θ_k = (π/2)·k/(n−1)`, `fade_in = sin θ`, `fade_out =
    cos θ`, endpoints inclusive so sample 0 is entirely outgoing material and sample
    `n−1` entirely incoming (no discontinuity at either end of the blend); `n = 1`
    uses π/4. Documented identically in both files.
12. **Zero-crossing rule**: decided on the float64 mono sum (channels added in
    order); index `j` is a crossing when `m[j−1]`, `m[j]` have opposite signs or
    either is zero; indices 0 and n always count (so an edge within 2 ms of the file
    boundary snaps onto it); search order d = 0, 1, … trying `j−d` before `j+d`;
    sample budget `floor(max_ms·sr/1000)` so the move can never exceed 2 ms.
13. **Rounding**: seconds -> samples is `floor(x·sr + 0.5)` in both languages
    (Python's `round` is banker's, JS's `Math.round` is not; this avoids both).
    Crossfade samples the same way, capped at half the loop.
14. **Arithmetic order** is identical in both languages (products and sums in
    float64, stored as float32), which is why the port is float32-exact.
15. **Naming**: F# major stays F# (Gb is no more conventional); minor keys keep
    sharps except Ebm and Bbm; flat input (`Bb`, `Eb`) and unicode accidentals are
    accepted; the base is reduced to its basename (no path traversal into export
    names), a known audio extension is stripped, length capped at 80; `bpm`/key may
    be `None` and are then omitted.
16. **Silence**: candidates whose RMS is below −60 dBFS are dropped rather than
    scored (a silent region would otherwise score 0.65 on a perfect seam).
17. **`name` is pre-filled** so chat and lists have something to say before the user
    renames.
18. **The vector carries `extra_cases`** (self mode, no snap, mono with a 5 ms
    crossfade, whole file) beyond the single case specified, all sharing the one
    input; the top-level shape is exactly as specified.

## Known limitations / backlog candidates

- In beats mode, `onset_lock` cannot separate downbeats from other beats on
  material with hats on every 8th (every beat has an onset), so mid-bar starts can
  outrank the downbeat when their seam is smoother. This is the packet's weighting;
  see proposal 2.
- The seam windows are fixed at 100 ms; very slow material may want beat-relative
  windows. Tune against the harness, not by hand.
- `loop_period_bars` from `structure` only adds a reason and a flag; it does not
  change the score (see proposal 1).
- The finder does not look at stems; "loop just the other stem" (Phase 2) is the
  same call on the stem file.

## Proposals (PROPOSALS.md template; not appended there to avoid concurrent edits)

## Loop-period bonus in the finder
**What it does for a producer:** When the analysis says the record repeats every 4 bars, the 4-bar loops rise to the top instead of tying with 1-bar cuts of the same material; the list reads the way the record is built.
**Principle it serves:** 2, measure don't guess; the loop period is already measured.
**Principle it risks:** None serious; a wrong period estimate is gated by `loop_period_confidence`, and the flag `matches_loop_period` is already in `components` so the UI can show it either way.
**What it takes:** One weight (e.g. 0.05 × `loop_period_confidence` when `bars == loop_period_bars`) folded into the score; harness cases from the synthetic set; a decision on whether the four packet weights shrink to keep the sum at 1.
**Where it belongs:** Phase 1 polish or Phase 2, tuned against the harness.
**Status:** proposed.

## Downbeat-likelihood term for beats-mode candidates
**What it does for a producer:** When downbeats are uncertain and the finder tries every beat, loops that start on a kick-heavy beat rank above loops that start mid-bar, so the fallback still lands on "the one".
**Principle it serves:** 2 and 4.
**Principle it risks:** None; it only reorders the fallback, and every edge is draggable.
**What it takes:** Reuse the low-band onset-energy phase score from `beats.py` per candidate start (already computed by the downbeat stage; expose it in `Beats.notes` or a small per-beat array), blended into `onset_lock` in beats mode only.
**Where it belongs:** Phase 2, with BeatNet.
**Status:** proposed.

## "Same loop elsewhere" grouping
**What it does for a producer:** The Loops tab shows "also at bar 17, 25" on a candidate instead of three near-identical rows, and chat can say "that loop comes back three times".
**Principle it serves:** 5, the library; understanding.
**Principle it risks:** None.
**What it takes:** The fingerprint and cosine used for contiguous repeats, applied to non-contiguous pairs; a `similar_to` list of start times in `components`; a small UI affordance.
**Where it belongs:** Phase 1 polish.
**Status:** proposed.

## Crossfade position control in the Loops tab
**What it does for a producer:** A switch between "blend at the head" (post-end audio wraps in, today's tail mode) and "blend at the tail" (pre-start audio wraps in, today's self fallback) for every loop, not only at end of file; some material sounds better one way (a decaying chord) than the other (a pickup into the one).
**Principle it serves:** 4, every output editable.
**Principle it risks:** None.
**What it takes:** A `position: "head" | "tail"` option in both renderers (the tail path already exists), a per-loop remembered setting next to `crossfade_ms` and snap (D.20), vector cases.
**Where it belongs:** Phase 1 polish.
**Status:** proposed.
