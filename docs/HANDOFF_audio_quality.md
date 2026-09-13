# HANDOFF: audio quality (separation, stretch, source fidelity)

Owner of this seam: the quality agent. Scope: make it impossible for the
pipeline to quietly destroy audio the way it did in the second real session.

A producer got three layered results back and said they sounded muddy and
muffled. Measured, the cause was ours, and it was one stage:

| Stage | 8-20 kHz, relative to the whole signal |
|---|---|
| source as uploaded | -19.5 dB |
| after separation with a low-SDR model | **-37.1 dB** |
| after a 0.83 stretch and +6 semitones | -23.3 dB |
| a reference-tier separator on the same source | **-19.5 dB, untouched** |

17.6 dB of air, gone at the one irreversible step, inherited by everything
after it. Three things follow, and this branch does all three: choose the
separator on quality and record what ran, replace the stretcher, and measure
what the file had in the first place so the product can say whose fault a dark
flip is.

Nothing outside the files below was touched. No commits, no push, no PR.

## Files

| Path | What |
|---|---|
| `analysis/lockedgroove/quality/metrics.py` | **new.** `band_ratio_db` / `air_db`, `transient_concentration` / `transient_retention`, `StageLoss`, `measure_stage`. The measurements that found the bug. |
| `analysis/lockedgroove/quality/bandwidth.py` | **new.** `measure_bandwidth` -> `Bandwidth(hz, confidence, method, notes, lowpassed, nyquist_limited)`. |
| `analysis/lockedgroove/quality/chain.py` | **new.** `run_chain` + `Budget`/`ChainReport`: source -> separation -> stretch, measured at each step against a budget. |
| `analysis/lockedgroove/quality/fixtures.py` | **new.** `transient_bed` (broadband hits over a tonal bed, with exact onsets) and `lossy_copy` (brickwall lowpass). |
| `analysis/lockedgroove/quality/__init__.py` | **new.** Re-exports. |
| `analysis/lockedgroove/combine/vocoder.py` | **new.** Identity-phase-locked vocoder with transient reset. NumPy only; the floor under every engine. |
| `analysis/lockedgroove/combine/align.py` | Engine registry and ordering, `stretch_and_shift` (one pass), `varispeed`, `is_coupled`, `available_engines`, `engine_installed`, `reset_engine_cache`. The Signalsmith binding was broken and is fixed. |
| `analysis/lockedgroove/stems/separate.py` | Quality-ordered registry with tier / family / published SDR, `quality_of`, `models_for`, `best_model`, `resolve_model`, `backend_available_models`; `DEFAULT_MODEL` is now derived from the ordering. |
| `analysis/lockedgroove/jobs/stems.py` | Resolves the best available separator, refuses any fast-mode parameter, writes the quality columns on every `stems` row. |
| `analysis/lockedgroove/analysis/spectral.py` | `Spectral.bandwidth`, measured on the native signal, hedged when the native signal is missing. |
| `analysis/lockedgroove/report.py` | `Estimate` moved above `Spectral`; `Spectral.bandwidth: Optional[Estimate]`. |
| `analysis/lockedgroove/breakdown/words.py` | `bandwidth_text`, `khz`, `FULL_BANDWIDTH_HZ`, `LIMITED_BANDWIDTH_HZ`. |
| `analysis/lockedgroove/breakdown/compose.py` | The mix section states the file's bandwidth, hedged by its confidence. |
| `analysis/lockedgroove/jobs/layer.py` | The render result records which stretch engine ran. |
| `analysis/lockedgroove/jobs/breakdown.py` | Queues `stems` with no model named, so the best available is resolved. |
| `analysis/lockedgroove/modal_app.py` | `PIP_BASE` mirrors the new dependency (`tests/test_dispatch.py` asserts it). |
| `analysis/pyproject.toml`, `analysis/uv.lock` | `python-stretch>=0.3.1` as a base dependency. |
| `scripts/quality_chain.py` | **new.** CLI: run the chain on a file, or `--self-test`, or `--engines` to compare every stretcher. Exits non-zero on a budget violation. |
| `docs/analysis_report.schema.json`, `web/lib/types/report.ts` | **generated**, by `scripts/gen_report_types.py`. One added line each. |
| `analysis/tests/test_quality_metrics.py` | **new.** 10 tests. |
| `analysis/tests/test_quality_bandwidth.py` | **new.** 9 tests. |
| `analysis/tests/test_quality_chain.py` | **new.** 6 tests. |
| `analysis/tests/test_stretch_engines.py` | **new.** 16 tests. |
| `analysis/tests/test_stems_quality.py` | **new.** 20 tests. |
| `supabase/migrations/20260913000800_stem_quality.sql` | **written, NOT applied.** Quality columns on `stems`, a partial index for trustworthy stems, a bandwidth index on `files`. |

`web/lib/types/report.ts` is the only file under `web/` that changed. It is
generated from the Pydantic models and `tests/test_report_schema.py` fails if it
is stale, so it could not be left alone; if it conflicts, re-run
`python scripts/gen_report_types.py` and the conflict is gone.

## Commands and results

```
cd analysis && uv run pytest
  564 passed, 2 skipped in 159.61s     (503 passed, 2 skipped before this work;
                                        the 61 new tests are mine)

cd analysis && uv run ruff check .
  All checks passed!

python scripts/quality_chain.py --engines      # the stretcher measurement
python scripts/quality_chain.py --self-test    # the chain, no file needed
```

`ruff check analysis scripts` (what CI runs) reports one B007 in
`scripts/gen_report_types.py`. It is on `main` already and is not mine; left
alone deliberately rather than editing another seam's file.

---

## 1. Separation: the ordering, and why

Five quality tiers, in `stems/separate.py`. The registry is the only place in
the code where a checkpoint identifier appears; everything else reasons in
tiers.

| Tier | What is in it | Confidence written on the row |
|---|---|---|
| `reference` | band-split / spectro-temporal transformers (BS-RoFormer, MDX23C class) | 0.90 |
| `strong` | the fine-tuned hybrid time-frequency family (Demucs v4), the best full four- and six-stem split | 0.75 |
| `baseline` | earlier spectrogram U-nets (MDX-Net class) | 0.55 |
| `weak` | the low-SDR members of that family (the `kuielab` set) | 0.35 |
| `stand_in` | the band-split fake in this repo | 0.10 |

The order is the measurement, not taste: the reference tier preserved the
source's 8-20 kHz ratio **exactly** on the real upload where the weak tier lost
17.6 dB of it. Inside a tier the higher published SDR wins; a model with no
published figure sorts last within its tier and its row says so rather than
carrying a number nobody can source.

Those confidences are not decoration. They land in `stems.quality_confidence`
and feed `report.hedge_word` directly: >= 0.8 states a claim plainly, 0.6-0.8 is
"likely", 0.4-0.6 is "roughly", below 0.4 is "I can't tell". A claim built on a
weak-tier stem therefore cannot be stated plainly, by construction.

**What the default does.** `resolve_model()` takes the stems you want and the
models the image can actually load, and returns the best that covers them:

- a four-stem ask resolves to the strong tier, because no reference-tier model
  in the registry returns four stems;
- a vocals/instrumental ask resolves to the reference tier;
- `DEFAULT_MODEL` is *computed* as `best_model(DEFAULT_STEMS)` rather than
  written down, so adding a better four-stem model changes the default with no
  other edit.

**What it refuses.** The `stems` job rejects `fast`, `fast_mode`, `quality`,
`preset` and `speed` outright, with a message saying separation always uses the
best available model. There is no code path that trades separation quality for
compute. An explicitly named weak model still runs - a producer may know exactly
what they want - but the choice records `downgraded: true`, names the better
model it skipped, and the row carries the weak tier.

**When only something bad is installed**, the answer is a worse *label*, never a
quieter one: the tier, the confidence and a plain-English note go onto every
row. When nothing installed produces the stems asked for, the job fails rather
than silently substituting.

**Every `stems` row now records** `model`, `model_family`, `model_tier`,
`model_sdr`, `model_sdr_basis`, `is_stand_in`, `quality_confidence`,
`quality_note`. Rows written before the migration have nulls, which mean
"unknown, treat as untrusted" - that is in the migration's comments.

**The stand-in is still clearly labelled**: `model` gets a `-fake` suffix,
`is_stand_in` is true, the tier is `stand_in`, the confidence is 0.1 and the
note says "not a separation model; nothing measured from it is a real stem".

## 2. The stretcher, and the measurement that chose it

Tried in the order the brief asked for:

| Candidate | Result here |
|---|---|
| `signalsmith-stretch` | **not on the index under that name.** The binding that exists is `python-stretch` (module `python_stretch`), MIT, wheels for cp38-cp312 on macOS x86_64/arm64, manylinux, musllinux and Windows. Installed and used. |
| `pyrubberband` | installs, but the `rubberband` CLI is not on this image and there is no package manager to add it. Kept as an engine, reported as "not installed here". Still GPL, so still needs a licence decision (OPEN_QUESTIONS 27). |
| `soxr` resampling for pitch-coupled cases | in, as the `varispeed` engine. |
| a properly phase-locked vocoder | in, as `combine/vocoder.py`, and it is the floor. |

**The existing Signalsmith path had never run.** It imported `stretch` (the
module is `python_stretch`), called `stretch.Signalsmith()` (that is a module,
the class is `Signalsmith.Stretch`), set `timeFactor = 1/ratio` (the binding's
`timeFactor` is the speed-up, so that was backwards) and assigned a
`pitchShift` attribute that does not exist. Every one of those was a silent
`except: fall back to librosa`, so the product has been running the phase
vocoder the whole time. Fixed, and the fallback now logs which engine failed.

### The measurement

`scripts/quality_chain.py --engines`, on `transient_bed`: broadband hits every
eighth over a sustained bed reaching 11 kHz - a break under a melodic sample,
which is the case this product hits all day and the hardest case for a vocoder.
Onsets are known exactly, not detected, so the number is not an onset
detector's opinion. "Transients kept" is the fraction of the source's onset
energy concentration (+-2 ms of the local peak against +-30 ms) that survived.

```
engine          ratio  air delta  transients kept
signalsmith      0.73     +0.06 dB           0.868
signalsmith      0.83     +0.06 dB           0.858
signalsmith      1.18     +0.04 dB           0.935
rubberband          -          not installed here
phase_locked     0.73     -0.18 dB           0.764
phase_locked     0.83     -0.14 dB           0.727
phase_locked     1.18     -0.25 dB           0.711
librosa          0.73     -0.18 dB           0.568
librosa          0.83     +0.33 dB           0.621
librosa          1.18     +0.11 dB           0.665
```

Read it as: at the 0.83 ratio the product uses constantly, the phase vocoder
throws away **38% of every onset's sharpness**; the chosen engine throws away
14%; the in-repo floor throws away 27%. The vocoder also moves the 8-20 kHz
ratio by up to +0.33 dB - it is not adding air, it is spraying phase-smear
artefacts into the top octave, which is the "washy" part of what "muffled"
meant.

`tests/test_stretch_engines.py` gates this: the default engine must beat
librosa by at least 0.05, **and the in-repo vocoder alone must too**, so the
guarantee does not depend on an optional dependency being present.

### What the engines are, best first

- **`varispeed`** - a soxr resample and nothing else. Only defined when the
  pitch change is exactly the one the speed change implies (the turntable
  move), but then it is exact: measured transient retention > 0.9 and no
  reconstruction at all. `stretch_and_shift` detects that case automatically,
  so "pitch this record up a tone" never goes through a stretcher again.
- **`signalsmith`** - one pass for stretch and shift together, latency already
  compensated by the binding, output length exactly `n / ratio`.
- **`rubberband`** - kept, needs the CLI, two passes (the Python wrapper has no
  combined call).
- **`phase_locked`** - `combine/vocoder.py`. Identity phase locking (every bin
  takes its peak's phase plus the offset it had in the source frame) plus a
  transient reset wherever the spectral flux stands out from its own
  distribution. NumPy only, ~90 ms for 4 seconds of mono at 44.1 kHz.
- **`librosa`** - never chosen automatically. Kept selectable *only* so the
  harness can keep measuring against it.

### One pass, not two

`apply_plan` used to time-stretch and then pitch-shift, running the signal
through the same smearing twice. `stretch_and_shift` does both in one call.
For the in-repo vocoder that is worth +0.16 of transient retention at
(0.83, +3 st) - it stretches once and resamples for the pitch instead of
vocoding twice. For the chosen engine it is a wash on this metric but halves
the work. `jobs/layer.py` now records `stretch_engine` in the render result, so
a region's lineage says which engine made it.

## 3. Source fidelity: how bandwidth is measured and surfaced

`quality/bandwidth.py`, four steps:

1. Average power spectrum over the **loud frames only** (silence and fade-outs
   have no top end and would drag the edge down), taking the per-bin 90th
   percentile across frames - one bright cymbal crash is enough to prove the
   band is there.
2. Smooth over ~100 Hz, express in dB relative to the in-band peak.
3. The edge is the highest frequency still above -60 dB of that peak.
4. Look for a **cliff** at the edge: a drop of >= 25 dB inside 8% of the edge
   frequency. That is an encoder lowpass, not a rolloff.

Accuracy on brickwalled fixtures at the cutoffs the real uploads had (12.0,
13.5, 15.7 kHz) is within +-60 Hz, which is the smoothing kernel's half-width.

Confidence says what it can and cannot see:

| Case | Value | Confidence | Note |
|---|---|---|---|
| sharp cut found | the cut | 0.90 | "the signature of a lossy encode" |
| gentle taper | the -60 dB point | 0.60 | "no encoder cut" |
| content runs to Nyquist | Nyquist | 0.50 | "the sample rate is the limit, not the record" |
| measured on a resampled copy | the edge | 0.20-0.30 | "re-measure on the upload" |
| silence or a scrap | `null` | 0.00 | "no measurable signal" |

**Where it lives.** `Spectral.bandwidth` is an `Estimate` - value, confidence,
method, notes - like every other estimated value in the report. The other three
spectral fields stay bare because they are deterministic; this one is not.
It is computed on `ctx.native`, which matters more than it looks: the analysis
rate is 22.05 kHz, its Nyquist is 11.025 kHz, and every real upload measured so
far sits above that, so measured on the working copy the answer would always be
the same wrong number. When the native signal is absent the estimate drops to
confidence 0.2-0.3 and the note says to re-measure on the upload.

**Where it shows up.** `breakdown/words.bandwidth_text` and the mix section of
the breakdown. Above 19 kHz: "the top end runs all the way to X, so there's
nothing missing up there." Between 16 and 19: a mild note. Below 16 kHz - where
every real upload was - it says the thing the product exists to say:

> The file itself stops at 15.7 kHz: there is no air above that to bring back,
> so anything cut from this will sound as dark as the record does. That's the
> source, not the processing.

Hedged by the estimate's own confidence, so a 0.6-confidence taper reads
"Likely the file itself stops at...".

`files_report_bandwidth_idx` in the migration makes "which of my records still
have their top end" a query.

## 4. What the quality harness checks

`quality/chain.py` + `scripts/quality_chain.py` + `tests/test_quality_chain.py`.

`run_chain(path, ...)` separates, carries one stem into a stretch, and measures
four rows:

```
stage              8-20 kHz    delta   transients   note
source               -6.86 dB        -        -     bandwidth 22.1 kHz (confidence 0.50)
separation:sum       -6.86 dB    +0.00      1.000   every stem added back together
separation:other     -7.60 dB    -0.74      0.565   stand_in tier, htdemucs_ft-fake
stretch              -7.55 dB    +0.05      0.794   x0.83, +0 st, signalsmith
```

Budgets, and why each is where it is:

| Stage | Air | Transients | Reasoning |
|---|---|---|---|
| `separation:<stem>` | 6.0 dB | 0.35 | a real separator moves one stem's balance by a decibel or two; 17.6 dB is the failure |
| `separation:sum` | 3.0 dB | 0.60 | the stems added back together should be close to the source, which catches a separator that dulls everything even when no single stem looks wrong |
| `stretch` | 1.0 dB | 0.60 | a stretcher has no business touching the spectrum |

Both directions of the air number count as damage: dulling is a weak separator,
added energy is artefact fizz. A pitch shift is *not* counted as damage - the
band the measurement looks at is scaled by the transposition, so content that
was at 8 kHz is still compared at 8 kHz x 2^(st/12).

The test that matters is `test_the_harness_catches_a_separator_that_throws_away_the_top_end`:
a stand-in that brickwalls its outputs at 8 kHz - the original bug, on demand -
and the harness must fail on it. It does, on all three stages, loudly:

```
FAIL  separation:sum: 8-20 kHz moved -43.66 dB (budget 3.00 dB)
FAIL  separation:other: 8-20 kHz moved -95.24 dB (budget 6.00 dB)
FAIL  stretch: 8-20 kHz moved +6.48 dB (budget 1.00 dB)
```

The CLI exits non-zero on any violation, so it drops into a check as-is.
`--self-test` needs no file; `--engines` prints the stretcher table above;
`--real` uses the installed separator instead of the stand-in.

## 5. What only a real record on real hardware can confirm

Everything above ran on synthetic fixtures and the band-split stand-in. What
that genuinely establishes: the metrics detect the failure, the budgets bite,
the stretchers rank in the order claimed, the bandwidth measurement is accurate
on known cutoffs, the model ordering and the job's refusals behave. What it
does not:

1. **No real separator ran here.** No GPU, no `audio-separator`, no weights. The
   backend interface is built and tested against the stand-in only. Specifically
   unexercised: `AudioSeparatorBackend.separate`, and
   `AudioSeparatorBackend.available_models`, which reads the separator's own
   listing API. That listing's shape has changed between versions, so
   `_flatten_model_files` accepts several shapes and `available_models` returns
   `None` ("assume the registry") rather than an empty set on anything
   unexpected - a degraded read must not refuse to separate. **Run
   `scripts/quality_chain.py <record> --real` on the GPU image once and check
   the resolved model against the printed listing before trusting it.**
2. **The checkpoint filenames in the registry are unverified against the
   installed separator.** They are the well-known names, but nothing here could
   load one. A typo surfaces as a load failure on first real use.
3. **Two published SDR figures are recorded, four entries have `null`.** Every
   entry carries `sdr_basis` saying what the number is or that there isn't one,
   and the tier ordering does not depend on the figures. Before launch, check
   each against its model card and fill the nulls - a number a producer sees
   should be sourceable.
4. **The 17.6 dB in the bug report was measured on a real record; the harness
   has only ever seen a synthetic reproduction.** Re-run the chain on the same
   record with a reference-tier separator and confirm the air delta is within a
   decibel, which is the original claim.
5. **Whether it sounds good.** Transient retention 0.86 against 0.62 is a real
   difference and it should be audible on a break, but no measurement here says
   a producer will like the result. The 0.73-0.85 ratios need a listening pass.
6. **`rubberband` has never run.** The engine path is written and unexercised.
   If the licence question goes its way, measure it before preferring it.
7. **Bandwidth on real lossy files.** Tested against brickwalled synthetic
   fixtures. Real encoders shape the cut differently per bitrate and some use a
   variable lowpass; the 25 dB / 8% cliff rule may need adjusting once the real
   uploads are measured. The uploads in the sessions read 12.0-15.7 kHz, so
   those are the four files to check it against first.
8. **Timing.** The reference-tier separator took 4:15 for a 17-second clip on a
   CPU here. Nothing has confirmed the A10G numbers the plan assumes.

## Decisions made without asking

- **`python-stretch` is a base dependency, not an extra.** Putting the real
  stretcher behind an optional extra guarantees the product silently ships the
  worse engine, which is the exact failure this branch exists to stop. Wheels
  cover every platform the project targets and the package is small. Mirrored
  into `PIP_BASE` because `tests/test_dispatch.py` asserts the two agree.
  Its metadata says MIT, which matches the assumption in OPEN_QUESTIONS 27, but
  the licence should be confirmed from the project itself before launch.
- **The existing registry keys were kept.** `web/lib/api/stems.ts`,
  `web/lib/chat/tools.ts` and three route tests name `htdemucs_ft`,
  `htdemucs_6s` and `bs_roformer`; changing the keys would have broken a seam I
  do not own. New entries were added around them.
- **"No model identifiers in code or comments"** was read as: no identifier in
  prose, comments or docstrings, and no identifier anywhere outside the one
  registry that has to hold them for the product to function (the brief also
  requires recording *which model ran* on every row). Comments and docstrings
  reason in tiers and families throughout. No assistant or LLM model identifier
  appears anywhere.
- **`Estimate` was moved above `Spectral`** in `report.py` so `Spectral` can
  reference it. Pure reordering, no field changed.
- **`report.py`, `breakdown/*`, `jobs/layer.py`, `jobs/breakdown.py` and
  `modal_app.py` were edited** though they are outside the listed ownership.
  Each was a one- or two-line consequence of a required change and each is
  named in the Files table.
- **The transient metric works from onset positions** rather than a
  position-free measure. Crest factor over fixed windows was tried first and
  does not separate the engines at all - all five landed within 0.4 dB of each
  other on the same material - because a dense break puts an onset in nearly
  every window.

## Follow-ups for other seams

- **`web/`**: the stem picker (`web/lib/api/stems.ts`) hard-codes three models
  and defaults to a strong-tier one by name. It should send no model and let the
  backend resolve the best available, and it should show the tier, the published
  SDR and the quality note that now come back on every `stems` row and in the
  job result. The chat tool description in `web/lib/chat/tools.ts` names models
  too and should describe tiers instead.
- **Loops**: `loops/sample_ready.py` already distrusts stand-in stems. It can now
  read `stems.model_tier` and `stems.quality_confidence` instead of inferring
  trust from the model name, and scale `ranking_factor` by the separation's
  confidence.
- **A two-stage split** would get the reference tier onto a melodic stem -
  reference-tier vocal/instrumental first, then a strong-tier four-stem split of
  the instrumental. That is exactly the case that produced the bug (a melodic
  layer) and the registry cannot express it today. Worth a PROPOSALS entry.
- **The migration is written and not applied.** `supabase/migrations/20260913000800_stem_quality.sql`.
