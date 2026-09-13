# Handoff: accuracy harness and CI (seam h)

Owner of this seam built: the synthetic evaluation set, the public-dataset
fetcher, the eval CLI with the six section-16 metrics and gates, the metric
module and its tests, the CI workflow, dependabot, and `scripts/README.md`.
No contract file was modified (`report.py`, `pipeline.py`, `ingest.py`,
`testing/synth.py`, `pyproject.toml`); nothing was committed.

## Files

| path | what |
|---|---|
| `analysis/lockedgroove/eval/__init__.py` | package doc |
| `analysis/lockedgroove/eval/metrics.py` | the six metrics as pure functions, key spelling normalization, `Prediction` from a report, per-item scoring, summaries, gates |
| `analysis/lockedgroove/eval/harness.py` | dataset loaders (synthetic, giantsteps_tempo, giantsteps_key, ballroom, corrections), pipeline runner with spawn-based multiprocessing, results document, text/markdown rendering, result storage |
| `analysis/tests/test_eval_metrics.py` | 39 tests: every metric on hand-made cases, report→prediction, skip/miss semantics, summaries and gates, the harness on an in-memory dataset with a stub analyzer (no disk), the real pipeline surviving missing stages, Ballroom `.beats` parsing, corrections truth derivation, the synthetic loader, the three public-dataset loaders on fake layouts |
| `scripts/build_synthetic_dataset.py` | 48-item deterministic synthetic set into `data/synthetic/` |
| `scripts/fetch_public_datasets.py` | GiantSteps Tempo / Key and Ballroom fetcher: `--list`, `--dataset`, `--limit`, `--jobs`, `--no-audio`, resumable, md5-verified, `data/SOURCES.md` log, per-dataset `manifest.json` |
| `scripts/datasets/{giantsteps_key,giantsteps_tempo,ballroom}.json` | item lists (names + audio md5) copied from the annotation repos at pinned commits, so `--list` and checksums need no network |
| `scripts/eval_accuracy.py` | the CLI: `--dataset`, `--limit`, `--workers`, `--stages`, `--json`, `--markdown`, `--gates`, `--no-gate`, `--no-save`, `-v`; writes `data/eval/<timestamp>.json`, `latest.json`, `latest.md`; exit 1 on a failed gate |
| `scripts/gates.json` | section-16 thresholds keyed per dataset (all six under every dataset; n/a where a metric does not apply) |
| `scripts/README.md` | how to build the synthetic set, fetch datasets, run the eval, raise gates, what CI does |
| `.github/workflows/ci.yml` | jobs `python`, `web`, `schema`, `changes` + `harness` |
| `.github/dependabot.yml` | pip (`/analysis`), npm (`/web`), github-actions, weekly |
| `docs/HANDOFF_harness.md` | this file |

Also: `ruff` was installed into `/home/user/crateai-venv` (it is in the `dev`
extra but was missing from the venv). No dependency was added to
`pyproject.toml`; the scripts use the standard library for HTTP.

## Commands and results

```
python scripts/build_synthetic_dataset.py
  48 items, 44.1 min of audio, 198 MB, 23 s (0.4–0.7 s per item)
  24 keys, 43 distinct tempi in 65–175 (incl. 70/140, 75/150, 80/160, 87.5/175),
  33 stereo + 15 mono, 3 items at 44.1 kHz, 6 without drums, byte-identical across runs

python scripts/eval_accuracy.py --dataset synthetic --no-gate --workers 4
  48 items in 3.2 s, exit 0 (see the table below)
python scripts/eval_accuracy.py --dataset synthetic --gates scripts/gates.json
  same table, "gate verdict: FAIL", exit 1

cd analysis && pytest -q tests/test_eval_metrics.py
  39 passed

python scripts/eval_accuracy.py --dataset all --no-gate --no-save
  synthetic scored; giantsteps_key "annotations present but no audio"; giantsteps_tempo and
  ballroom "not found"; corrections "skipped: SUPABASE_URL, ... not set"; exit 0

python scripts/fetch_public_datasets.py --list
  works offline: 664 / 604 / 698 items with every source URL, pinned commits, license notes
python scripts/fetch_public_datasets.py --dataset giantsteps_key --limit 3
  annotations: codeload tarball 403 (this session's GitHub proxy) -> per-file fallback fetched 3/3
  audio: both hosts (www.cp.jku.at, geo-samples.beatport.com) denied by the session's egress policy
  -> 3 items "missing_audio", every attempted URL logged in data/SOURCES.md, exit 1; re-run is idempotent

ruff check --config analysis/pyproject.toml <my files>
  clean
```

Sanity check of the synthetic truth against the rendered audio (librosa onset
detection vs. truth beats on the 40 items with leading silence or a pickup):
median |onset − beat| 6–19 ms on every item (the onset frame is 11.6 ms), so
first-downbeat offsets and pickups are encoded correctly.

## Scores

The Phase 0 stage modules (`tempo`, `beats`, `key`, `structure`, …) had not
landed when this ran (the other agent has `chords`, `drums`, `effects`,
`instrumentation`, `sampleuse` in place). The harness therefore reports
zeros with reasons, which is the required behaviour:

| dataset | items | bpm_exact | bpm_octave | key_exact | key_relative | downbeat | structure_f |
|---|---:|---:|---:|---:|---:|---:|---:|
| synthetic | 48 | 0.000 (48) | 0.000 (48) | 0.000 (48) | 0.000 (48) | 0.000 (48) | 0.000 (48) |

```
misses by reason:
  synthetic.bpm_exact:   tempo: stage not available: No module named 'lockedgroove.analysis.tempo' x48
  synthetic.key_exact:   key: stage not available: No module named 'lockedgroove.analysis.key' x48
  synthetic.downbeat:    beats: stage not available: No module named 'lockedgroove.analysis.beats' x48
  synthetic.structure_f: structure: stage not available: No module named 'lockedgroove.analysis.structure' x48
```

Once the stages exist, the same command gives the real numbers; `-v` prints
one line per item with the stage errors, and `data/eval/latest.json` carries
per-item predictions, scores, reasons, and per-stage timings.

## Interpretation choices

1. **Downbeat metric.** For each true downbeat, the signed offset to the
   nearest predicted downbeat is wrapped into `[-bar/2, bar/2)`; the item
   passes when the median absolute wrapped offset is ≤ 60 ms. A grid that
   starts a whole bar late passes (same phase), a grid one beat off fails
   (quarter-bar offset). The bar length comes from the truth: median spacing
   of annotated downbeats (Ballroom waltzes get 3-beat bars), else
   `4 × 60 / bpm`.
2. **Structure F.** Boundaries are every section start and end, duplicates
   merged, first and last trimmed (mir_eval convention); tolerance is one
   true bar; one-to-one greedy matching in time order; the dataset score is
   the mean per-item F. An item whose truth has fewer than two sections is
   skipped ("where labels exist").
3. **BPM octave-tolerant** only credits values the report lists in
   `alternates_bpm`; it never derives half/double itself, so it measures what
   the UI offers to click.
4. **Key spelling.** Flats, `♯/♭`, `Bbm`/`Abmaj`, and the GiantSteps `Eb minor`
   form all normalize to the sharp convention; relative keys via ±3 semitones.
5. **Skip vs. miss.** Truth without the field → skipped (not counted).
   Pipeline without the value (stage absent, raised, or `None`) → miss, with
   the reason from `Context.errors`. Items with annotations but no audio are
   listed separately and never scored.
6. **Gates.** A gate applies only where the metric applied to ≥ 1 item of
   that dataset; `gates.json` lists all six under every dataset for
   uniformity. `--dataset all` skips datasets that are not on disk;
   explicitly naming a missing dataset fails a gated run, so CI cannot pass
   by evaluating nothing. Gates for datasets that were not run are ignored.
7. **Corrections.** Needs `EVAL_CORRECTIONS_USER_ID` in addition to the two
   Supabase variables, per OPEN_QUESTIONS L.36 ("your own account only");
   without it the dataset is skipped with a message that says so. Truth comes
   only from corrected fields: `tempo_bpm` → bpm, `key` → key,
   `downbeat_phase` / `first_downbeat_s` / `meter` → the downbeat grid that
   `effective()` produces from the stored report plus the edits;
   `section_labels` carry no boundary truth and are ignored. Audio is cached
   under `data/corrections/<file_id>.<ext>` and never leaves the machine;
   storage paths and user ids are not printed.
8. **Ballroom BPM** is derived from the median inter-beat interval of the
   CPJKU beat annotations (the annotated metrical level follows the dance
   style, per their README), because the ISMIR 2004 tempo files are not part
   of the audio tarball. Recorded in item `meta`.
9. **GiantSteps.** `annotations_v2/tempo` (Schreiber & Müller 2018) is the
   truth, v1 kept in `meta`; the three files with `0.0` in v2 are skipped.
   Audio is fetched in the order the dataset's own `audio_dl.sh` (v0.3,
   2025-03) uses: the JKU backup mirror first, then the documented Beatport
   preview URL; each file is md5-checked against the repo's `md5/` entries.
   Annotation repos are pinned to a commit (recorded in `scripts/datasets/`
   and `data/SOURCES.md`) as the CPJKU README asks.
10. **Stages.** The harness runs the pipeline's `DEFAULT_STAGES` (the Phase 0
    set) unless `--stages` is given; it uses `spawn` workers and no per-item
    timeout (the CI job has a 60-minute limit).
11. **Synthetic design.** An explicit spec table rather than random sampling:
    24 key items, 8 octave-pair items, 6 swing items (3 programmed, 3 with
    6 ms jitter and spectral variation), 4 eight-bar-loop items, 6 drum-less
    items. A pickup is the last *k* beats of bar 0 prepended before the first
    full bar; truth `beats_s` includes the pickup beats, `downbeats_s` only
    full bars, sections start at the first full bar. Drum-less items keep
    tempo and downbeat truth (harmonic rhythm is the only cue) and will be
    the hardest 6 of 48.
12. **CI.** `ruff` runs with `--config analysis/pyproject.toml` over
    `analysis/` and `scripts/` so both trees get the same rules. The `web`
    job detects `web/package.json` and skips itself until the app lands
    (`pnpm run --if-present` for typecheck/lint/test, `pnpm run build`
    required). The `harness` job runs when `analysis/**` or `scripts/**`
    change (dorny/paths-filter) and always on `workflow_dispatch`; public
    datasets come from `actions/cache` keyed on the fetcher and index files,
    and are fetched in CI only on a cache miss **and** when the repository
    variable `HARNESS_FETCH_PUBLIC_DATASETS` is `true` (opt-in, ~2 GB). The
    markdown report goes to the job summary; `latest.json` + `latest.md` are
    uploaded as an artifact.
13. **No git on the repo.** To learn the annotation repos' layouts and pin
    commits I shallow-cloned the three public dataset repos into the session
    scratchpad (anonymous read through the session proxy); nothing touched
    the crateai working tree's git state.

## Things for the lead

- **`ruff check` in the `python` job will be red until other files are
  fixed.** Under the project rules, 204 findings remain outside my files:
  `report.py` 50 (all `UP045` `Optional[X]` → `X | None` and `I001`),
  `pipeline.py` 11, and the other agent's modules/tests (`breakdown/compose.py`
  26, `loops/finder.py` 15, …). 186 are auto-fixable (`ruff check --fix
  --config analysis/pyproject.toml analysis scripts`); the rest are `B905`
  (`zip` without `strict`), `B023`, `B007`, `F841`. Alternatively one line in
  `[tool.ruff.lint] ignore` (`"UP045"`, `"UP037"`) removes 150 of them. I
  did not touch the contract files.
- **The full test suite currently has failures in other seams** (at 07:35:
  `test_drums.py` ×3, `test_loop_finder.py` ×2, `test_loop_naming.py`,
  `test_loop_render.py` ×3, `test_sampleuse.py`); they are in flux with the
  other agent. Mine pass.
- **The harness gate will fail on `main` until the Phase 0 stages exist**;
  that is principle 9 working as designed. The first PR that adds `tempo`,
  `beats`, `key`, `structure` should include the synthetic scores in its
  description.
- **Network in this session** blocked the audio hosts (egress policy) and the
  GitHub tarball route (session proxy). The per-file annotation route and
  `--list` were validated; the tarball extraction, md5 verification, resume,
  and Ballroom extraction paths are exercised by code review only. The first
  full `--dataset all` run on the owner's machine is the real test; it is
  resumable, so a failure costs nothing.
- **Public datasets in CI**: set the repository variable
  `HARNESS_FETCH_PUBLIC_DATASETS=true` once to populate the cache (or upload
  a cache from a local fetch); until then the harness gates on the synthetic
  set alone.
- `data/eval/` is gitignored; results live only in CI artifacts and locally.
  A small committed history of scores per merged PR would let gates be
  raised with evidence (see proposal 1).

## Proposals

Not appended to `docs/PROPOSALS.md` to avoid concurrent edits with the other
agent; promote whichever fit.

```
## Accuracy history and regression diff
**What it does for a producer:** Nothing directly; it keeps the numbers behind the confidence dots honest. Every merge records the harness scores, and a PR shows which items flipped from hit to miss and why, not just the aggregate.
**Principle it serves:** 9 (the harness gates merges), 2 (measure, don't guess).
**Principle it risks:** None.
**What it takes:** A `--baseline latest.json` option in `eval_accuracy.py` that lists per-item flips with reasons; a small committed `docs/accuracy/` log written by the harness job on `main` (scores only, no audio, no user data). One day.
**Where it belongs:** Phase 0 tail or Phase 1.
**Status:** proposed.

## Confidence calibration report
**What it does for a producer:** When the app says "likely F minor", "likely" should mean about the same hit rate every time. The harness already has confidence and correctness per item; report hit rate per confidence band (the section-11 hedging bands) per metric, so a stage whose confidence is uninformative is caught before its words reach the chat.
**Principle it serves:** 2; the grounding contract in section 14.
**Principle it risks:** None.
**What it takes:** Keep `confidence` in `Prediction`, bucket by `HEDGE_BANDS`, add a table to the markdown report and an optional gate on the gap between bands. Half a day once the stages exist.
**Where it belongs:** Phase 2 (when gates are raised).
**Status:** proposed.

## Per-account opt-in for corrections in the harness
**What it does for a producer:** Lets a tester choose to donate their corrections to the accuracy set, in writing, in the app, instead of the harness being limited to the owner's account forever.
**Principle it serves:** 7 (user corrections are ground truth), 6 (private always).
**Principle it risks:** 6, mitigated by an explicit per-account flag, audio read only through short-lived signed URLs on the owner's machine, and nothing leaving it.
**What it takes:** A boolean on a `profiles` table with a settings toggle and copy explaining what is read; `load_corrections` accepts a list of opted-in user ids instead of one. Small.
**Where it belongs:** Phase 10 (product hardening), or earlier if testers ask.
**Status:** proposed.

## Ballroom waltz subset as the meter case
**What it does for a producer:** Waltz-time records stop getting a 4/4 grid. The Ballroom set already has 3/4 items with bar annotations; scoring `downbeat` per meter (the loader records `beats_per_bar`) gives the existing meter-detection proposal its harness case for free.
**Principle it serves:** 2.
**Principle it risks:** None.
**What it takes:** A per-genre/per-meter breakdown in the report (item `meta` already carries genre and beats_per_bar). Hours.
**Where it belongs:** Phase 2+, with meter detection.
**Status:** proposed.
```
