# scripts/

Developer tooling. Nothing here is imported by the app; the harness only
touches the analysis package through `lockedgroove.pipeline.analyze_array` and
`lockedgroove.report.effective`, so it keeps working while stages come and go.

| script | does |
|---|---|
| `build_synthetic_dataset.py` | renders the deterministic synthetic evaluation set into `data/synthetic/` |
| `fetch_public_datasets.py` | downloads GiantSteps Tempo, GiantSteps Key, and Ballroom into `data/<dataset>/`, resumably, with a provenance log |
| `eval_accuracy.py` | runs the pipeline over the datasets, computes the six section-16 metrics, checks the gates |
| `gates.json` | the gate thresholds, per dataset |
| `datasets/*.json` | item lists (file names, audio md5 sums) copied from the annotation repos at a pinned commit, so `--list` and md5 checks need no network |
| `gen_report_types.py` | regenerates the JSON Schema and TypeScript types from `report.py` (`--check` in CI) |

Everything under `data/` is gitignored. Run the scripts with the analysis
environment (`uv venv && uv pip install -e "./analysis[dev]"`, or the repo venv).

## 1. Build the synthetic set

```
python scripts/build_synthetic_dataset.py           # 48 items into data/synthetic, ~25 s
python scripts/build_synthetic_dataset.py --list    # the spec table, no rendering
python scripts/build_synthetic_dataset.py --force   # re-render everything
```

Each item is a WAV plus a JSON truth file (`bpm`, `key`, `downbeats_s`,
`beats_s`, `sections`, `loop_period_bars`, plus the generation parameters).
The set covers all 24 keys, 65-175 BPM including half/double pairs (70/140,
75/150, 80/160, 87.5/175), leading silence and pickups before the first
downbeat, four swing settings, ABAB / AABA / ABCB with 4- and 8-bar loops,
mono and two stereo widths, 22.05 and 44.1 kHz, three drum patterns, and six
items without drums. It is byte-identical across runs for the same
`lockedgroove/testing/synth.py`; `manifest.json` records the seed and a hash
of that file.

## 2. Fetch the public datasets

```
python scripts/fetch_public_datasets.py --list                       # sources and URLs, no network
python scripts/fetch_public_datasets.py --dataset giantsteps_key --limit 5
python scripts/fetch_public_datasets.py --dataset all                # ~2 GB, resumable
```

| dataset | truth | annotations | audio |
|---|---|---|---|
| `giantsteps_tempo` | BPM (annotations_v2, Schreiber & Müller 2018; v1 kept alongside) | github.com/GiantSteps/giantsteps-tempo-dataset, pinned commit | 664 two-minute Beatport previews, from the JKU mirror then Beatport (the order the dataset's own `audio_dl.sh` uses), md5-checked |
| `giantsteps_key` | key | github.com/GiantSteps/giantsteps-key-dataset, pinned commit | 604 previews, same sources |
| `ballroom` | beats, downbeats, meter; BPM derived from the median inter-beat interval | github.com/CPJKU/BallroomAnnotations, pinned commit | one 1.5 GB tarball from mtg.upf.edu (ISMIR 2004), md5-checked, then extracted |

Annotations come from the repository tarball at the pinned commit when that
is reachable and file by file from raw.githubusercontent.com otherwise.
Downloads resume (`.part` files, HTTP Range) and are skipped when the file is
present and valid, so re-running after a failure just fills the gaps.
`--limit N` takes the first N items of each dataset (Ballroom still needs the
whole archive). Every run appends to `data/SOURCES.md`: the URLs fetched, the
license notes, the pinned commits, and the fetch date; `data/<dataset>/manifest.json`
lists per-item status.

The audio is used locally for evaluation only. This script is the one place
in the repository that turns a URL into audio bytes, and it lives outside the
package on purpose (principle 3 concerns the app; see OPEN_QUESTIONS L.35).

### The Harmonix Set (the hip-hop one)

912 tracks of Western popular music with human beat, downbeat, functional
segment and tempo annotations, of which **140 are Hip-Hop, 25 R&B and 14
Funk/Disco**. It is the closest thing to a hip-hop evaluation set that exists,
and its annotations are exactly the four things the harness scores.

The set distributes **no audio**. The fetcher pulls the annotations and then
tells you where to drop your own copies of the tracks you already hold:

```
python scripts/fetch_public_datasets.py --dataset harmonix       # annotations only
# put your files in data/harmonix/audio/<track>.mp3  (or .wav/.m4a/.flac)
python scripts/eval_accuracy.py --dataset harmonix --genres hiphop
```

`scripts/datasets/harmonix.json` maps every track id to its artist, title,
BPM and genre, so you can see what to look for. A partial set works: the
loader scores what it finds and lists the rest as skipped. `--genres` takes
`hiphop` for the Hip-Hop, R&B and Funk/Disco subset, or a comma-separated
list of genre names.

Harmonix has no key annotations, so its key gates report `n/a`. Its tempo
gates carry the packet's numbers, because unlike the synthetic set the octave
is a fact about the record rather than a convention.

## 3. Run the eval

```
python scripts/eval_accuracy.py --dataset synthetic --no-gate
python scripts/eval_accuracy.py --dataset all --workers 4            # gates from scripts/gates.json
python scripts/eval_accuracy.py --dataset giantsteps_key,ballroom --limit 100 --json out.json --markdown out.md
python scripts/eval_accuracy.py --dataset synthetic -v                # one line per item, with stage errors
```

Metrics (BUILD_PACKET section 16), per dataset and pooled overall:

| metric | counts as a hit when |
|---|---|
| `bpm_exact` | predicted BPM within 2 of the truth |
| `bpm_octave` | exact, or the truth within 2 BPM of a value the report lists in `alternates_bpm` |
| `key_exact` | tonic and mode agree (flat spellings normalized to sharps) |
| `key_relative` | exact, or the report's `alternate` is exact, or the truth is the relative major/minor of the prediction |
| `downbeat` | median absolute offset from each true downbeat to the nearest predicted one, wrapped modulo the true bar length, within ±60 ms |
| `structure_f` | boundary F-measure at ±1 bar, one-to-one matching, first and last boundary trimmed; the dataset score is the mean F |

A metric is skipped for an item whose truth lacks the field (GiantSteps Tempo
has no key; Ballroom has no sections) and counted as a **miss with a reason**
when the pipeline produced nothing for it (stage missing, stage raised,
analysis failed). The table's "misses by reason" block is where to look
first when a number drops.

`corrections` reads the corrections table with the service role and pulls
the audio through signed URLs. It needs `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, and `EVAL_CORRECTIONS_USER_ID` (the one account
whose corrections may be used, per OPEN_QUESTIONS L.36); without them it is
skipped with a message. Only corrected fields become truth: a corrected tempo
scores `bpm_*`, a corrected key scores `key_*`, a downbeat/meter correction
scores `downbeat` with the grid `effective()` produces from the stored
report. Audio is cached under `data/corrections/` and never leaves the machine.

Results are written to `data/eval/<timestamp>.json`, `data/eval/latest.json`,
and `data/eval/latest.md` (per-item scores, predictions, stage errors and
timings, gate results). `--json` / `--markdown` write extra copies.

Exit status: `0` when every applicable gate passes, `1` when one fails or a
named dataset could not be scored, `2` on usage errors. `--no-gate` reports
the gates without failing.

## 4. Gates

`scripts/gates.json` holds the thresholds keyed per dataset: the section-16
numbers everywhere, except `synthetic.bpm_exact` at 0.50 (the reason is in
the file's notes and in OPEN_QUESTIONS 37: the set's tempos are uniform over
65–175 BPM, so the exact octave is the hip-hop prior's call, and
`bpm_octave` is the gate that says the grid is right). A gate applies only
when the metric applied to at least one item of that dataset; the rest show
as `n/a`.
`--dataset all` skips datasets that are not on disk; naming one that is
missing fails the run so a CI job cannot pass by evaluating nothing.

To raise a gate: run the eval on the full datasets, look at
`data/eval/latest.json`, and raise the number to a value the pipeline clears
with margin (a couple of points below what it scores, never above). Raise in
the same PR as the stage change that earned it, and say so in the PR
description. The packet expects the gates to rise when neural beat tracking
(Phase 2) and the corrections set come online. Never lower a gate to make a
PR green; if a regression is intended, write the reason in the PR and in
`docs/BACKLOG.md`.

## 5. Sharing results without sharing audio

`data/` is gitignored except `data/eval/latest.json`, `data/eval/*.md` and
`data/SOURCES.md`. Those are scores and provenance, never audio, so a run on
a machine that holds the datasets can be committed and read anywhere:

```
python scripts/fetch_public_datasets.py --dataset all
python scripts/eval_accuracy.py --dataset all --workers 4 --no-gate
git add data/eval/latest.json data/eval/latest.md data/SOURCES.md && git commit
```

`latest.json` carries per-item predictions, truths, miss reasons and stage
timings, which is everything needed to work on accuracy. The audio stays on
the machine that fetched it, as the datasets' terms require.

## 6. CI

`.github/workflows/ci.yml`:

- `python`: `uv` install of `analysis[dev]`, `pytest -q`, `ruff check` (the
  project rules from `analysis/pyproject.toml`, applied to `analysis/` and `scripts/`).
- `web`: pnpm install, typecheck, lint, test, build with placeholder Supabase
  env; skipped while `web/package.json` does not exist.
- `schema`: `gen_report_types.py --check`.
- `harness`: runs when `analysis/**` or `scripts/**` changed (or on manual
  dispatch): builds the synthetic set, restores the public datasets from
  `actions/cache` (key: hash of `fetch_public_datasets.py` and
  `scripts/datasets/*.json`), runs `eval_accuracy.py --dataset all` with the
  gates, prints the report into the job summary, and uploads
  `data/eval/latest.json` + `latest.md` as an artifact. The public datasets
  are fetched in CI only on a cache miss and only when the repository variable
  `HARNESS_FETCH_PUBLIC_DATASETS` is `true`; otherwise the harness gates on
  the synthetic set alone until the cache has been populated once.
