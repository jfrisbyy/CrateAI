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
| `datasets/sample_pairs.example.json` | the template for the one dataset a human writes by hand: an original record and the song that sampled it (§3) |
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

## 3. Sample pairs: an original record and the song that flipped it

This is the only set that measures what the product is actually for. The others
score the pipeline against annotations; a pair asks the question a producer
would: **point the loop finder at the record, does it hand back the section the
producer used?** Nothing downloads it and nothing generates it -- you supply it,
from records you know (OPEN_QUESTIONS 42).

### What a pair is

Three things:

1. **the original record**, as an audio file -- the one that was sampled;
2. **the finished song**, as an audio file -- optional, and only needed to
   score the tempo stretch and the pitch shift;
3. **what you know**: roughly where in the original the loop came from, and,
   if you know them, the tempo ratio, the pitch shift and what was filtered out.

Approximate is fine. "The loop is somewhere around 1:04" is a usable pair. The
more you write down, the more metrics it scores; a field you leave out removes a
metric rather than breaking anything.

### Where the files go

```
data/sample_pairs/
  pairs.json                 the manifest you write
  audio/
    original_01.wav          the record
    song_01.wav              the song that sampled it
    original_02.wav
```

Any format the app takes works (wav, aiff, flac, mp3, m4a, ogg). Everything
under `data/` is gitignored: the audio and the manifest never leave your
machine, and never enter the repository.

### The manifest

Copy `scripts/datasets/sample_pairs.example.json` to `data/sample_pairs/pairs.json`
and edit it. One entry per pair:

```json
{
  "dataset": "sample_pairs",
  "audio_dir": "audio",
  "items": [
    {
      "id": "pair01",
      "original": "original_01.wav",
      "song": "song_01.wav",
      "flip": {"from": "1:04", "to": "1:12"},
      "tempo_ratio": 1.08,
      "pitch_semitones": "+2",
      "original_bpm": 86,
      "original_key": "Bbm",
      "filtered": "low-passed at 8 k, the drums on the record are gone",
      "notes": "four bars of the horn line; he chops it on the 2"
    },
    { "id": "pair02", "original": "original_02.wav", "flip": "2:31", "tolerance_s": 5 }
  ]
}
```

`original` and one timestamp are the only things required. `pair02` above is a
complete, usable pair.

| field | what it does | if you leave it out |
|---|---|---|
| `original` | the record the finder is pointed at | the pair is skipped |
| `flip` | where in the record the loop came from | nothing to find; skipped unless a tempo or pitch is given |
| `song` | the finished track | `tempo_ratio` and `pitch_shift` are not scored |
| `tempo_ratio` | song tempo ÷ record tempo (1.08 = sped up 8 %) | not scored; `original_bpm` + `song_bpm` gives the same thing |
| `pitch_semitones` | how far it was pitched: `"+2"`, `-5` (`pitch_cents` also works) | not scored |
| `tolerance_s` | how far off your timestamp might be (default 1 s) | 1 s is assumed |
| `original_bpm`, `original_key` | what you know about the record itself | the ordinary tempo and key metrics are not scored for it |
| `filtered`, `notes`, `title` | free text, for you | nothing; they are never written to the results file |

`flip` is deliberately loose. All of these parse:

```
"flip": "1:04"                                     a timestamp: scores flip_mark only
"flip": "1:04-1:12"                                a span: scores everything
"flip": [64, 72]                                   the same, in seconds
"flip": {"from": "1:04", "to": "1:12"}
"flip": {"at": "1:04", "length_s": 8}
"flip": {"at": "1:04", "bars": 4, "source_bpm": 93}   bars need your BPM, not ours
```

### Running it

```
python scripts/eval_accuracy.py --dataset sample_pairs --no-gate
python scripts/eval_accuracy.py --dataset sample_pairs --no-gate -v      # one line per pair
```

`--no-gate` because the set is ungated on purpose: nobody has measured these
metrics on a real pair yet, so there is no threshold worth failing a build on
(see §5 and `docs/HANDOFF_sample_pairs.md`). The pair metrics print as their own
table under the usual one.

### Trying it with no pairs at all

```
python scripts/eval_accuracy.py --make-synthetic-pairs
python scripts/eval_accuracy.py --dataset sample_pairs --no-gate
```

The first command writes two synthetic pairs into `data/sample_pairs/` -- a
made-up "record" and a "song" that sped one of its sections up by two
semitones, plus a second pair that carries nothing but a rough timestamp. They
prove the whole path runs (manifest → loader → loop finder → metrics → table);
they say nothing about accuracy on real music. Delete the folder before putting
real pairs in it, or pass a directory to `--make-synthetic-pairs` to keep them
apart.

## 4. Run the eval

```
python scripts/eval_accuracy.py --dataset synthetic --no-gate
python scripts/eval_accuracy.py --dataset all --workers 4            # gates from scripts/gates.json
python scripts/eval_accuracy.py --dataset giantsteps_key,ballroom --limit 100 --json out.json --markdown out.md
python scripts/eval_accuracy.py --dataset synthetic -v                # one line per item, with stage errors
python scripts/eval_accuracy.py --dataset sample_pairs --no-gate      # your pairs (§3)
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

`sample_pairs` scores six more, in a second table, because it asks a different
question (definitions and the reasoning in `docs/HANDOFF_sample_pairs.md`):

| metric | counts as a hit when |
|---|---|
| `flip_top1` | the finder's **top** candidate overlaps the section the producer used, IoU ≥ 0.5 |
| `flip_topk` | any of the **top 10** does — the rack a producer would scroll |
| `flip_mrr` | not a hit rate: the mean of 1/rank of the first candidate that does (1.0 = always first, 0.1 = tenth, 0 = never) |
| `flip_mark` | a top-10 candidate covers the timestamp you wrote down, widened by `tolerance_s`. The loosest bar, and the one a pair with only "around 1:04" can still score |
| `tempo_ratio` | the stretch our alignment would compute is within 2 % of the one you gave |
| `pitch_shift` | the shift our alignment would compute is within half a semitone of the one you gave, modulo an octave |

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

## 5. Gates

`scripts/gates.json` holds the thresholds keyed per dataset: the section-16
numbers everywhere, except `synthetic.bpm_exact` at 0.50 (the reason is in
the file's notes and in OPEN_QUESTIONS 37: the set's tempos are uniform over
65–175 BPM, so the exact octave is the hip-hop prior's call, and
`bpm_octave` is the gate that says the grid is right). A gate applies only
when the metric applied to at least one item of that dataset; the rest show
as `n/a`.
`--dataset all` skips datasets that are not on disk; naming one that is
missing fails the run so a CI job cannot pass by evaluating nothing.

`sample_pairs` has no entry at all, deliberately: its metrics have never been
measured on a real pair, so any threshold would be invented. Run it with
`--no-gate` until there are ten or more pairs scoring the same number twice;
then gate `flip_topk` a couple of points under what it holds, and leave
`flip_top1` alone until the ranking is worth defending.

To raise a gate: run the eval on the full datasets, look at
`data/eval/latest.json`, and raise the number to a value the pipeline clears
with margin (a couple of points below what it scores, never above). Raise in
the same PR as the stage change that earned it, and say so in the PR
description. The packet expects the gates to rise when neural beat tracking
(Phase 2) and the corrections set come online. Never lower a gate to make a
PR green; if a regression is intended, write the reason in the PR and in
`docs/BACKLOG.md`.

## 6. Sharing results without sharing audio

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

For sample pairs this cuts harder, because the material is yours rather than a
public dataset's: what reaches `latest.json` is the pair `id` you chose, the
timestamps and ratios you wrote, the candidate spans in seconds and the scores.
Your `title`, `artist`, `notes` and every file path stay on your machine, and
so does the text of anything the loader could not read — a diagnostic names the
field ("flip timestamp unreadable"), never what you wrote in it. If a pair's
`id` would itself give away a record you would rather not publish, call it
`pair07`.

## 7. CI

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
