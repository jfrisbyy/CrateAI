# Handoff: sample pairs, the evaluation set that measures the product

Built: a hand-written pair format, a `sample_pairs` dataset in the accuracy
harness, six metrics that ask whether the loop finder surfaces the section a
producer actually flipped, and a synthetic pair set so the whole path runs
before any real audio arrives. Answers OPEN_QUESTIONS 42.

Nothing was committed. No contract file was touched (`report.py`,
`pipeline.py`, `ingest.py`, `testing/synth.py`, `loops/finder.py`,
`combine/align.py`, `pyproject.toml`); the finder and the alignment planner are
imported and measured, never modified.

**Why this set exists.** Every accuracy number in the project so far comes from
synthetic audio or from beat-annotated pop. Both measure whether we can read a
record. Neither measures whether we can find *the bit worth taking* — which is
the product. A pair is the only ground truth for that, because the answer was
decided by a professional producer and is on a record.

## Files

| path | what |
|---|---|
| `analysis/lockedgroove/eval/pairs.py` | the manifest format: timestamp and span parsing, truth building, file resolution, the transform measurement, the synthetic pair builder |
| `analysis/lockedgroove/eval/metrics.py` | + `PAIR_METRICS`, `span_iou`, `flip_ranks`, `best_overlap`, `mark_rank`, `covered_seconds`, `semitone_error`, `score_pair`; `Prediction` gained `loops`, `tempo_ratio`, `pitch_semitones`, `transform` |
| `analysis/lockedgroove/eval/harness.py` | + `load_sample_pairs`, registered in `DATASETS` and `LOADERS`; `analyze_item` runs the finder and the song analysis for a pair; the report prints the pair family as a second table |
| `analysis/tests/test_eval_pairs.py` | 51 tests: parsing everything a human might write, the six metrics on fabricated racks, the loader (including broken manifests and privacy), the shipped template, and the whole path on synthetic audio |
| `scripts/datasets/sample_pairs.example.json` | the template the owner copies; documents every field inline |
| `scripts/eval_accuracy.py` | `--dataset sample_pairs`, `--make-synthetic-pairs [DIR]`, gates may now name a pair metric |
| `scripts/README.md` | §3, in plain language: what a pair is, where files go, the manifest, the least you can get away with |
| `scripts/gates.json` | a note saying why `sample_pairs` is ungated and what would earn it a gate |
| `docs/HANDOFF_sample_pairs.md` | this file |

## For the owner: what to send, and how to lay it out

You do not need to send anything to anyone. The audio stays on the machine that
runs the harness; only scores are shareable, and they carry no file paths, no
titles and no artist names (see "Privacy" below).

**1. Put the files here.** Any format the app takes (wav, aiff, flac, mp3, m4a,
ogg). `data/` is gitignored, so nothing here can be committed by accident.

```
data/sample_pairs/
  pairs.json
  audio/
    original_01.wav      the record that was sampled
    song_01.wav          the song that sampled it
    original_02.wav
```

**2. Write the manifest.** Copy `scripts/datasets/sample_pairs.example.json` to
`data/sample_pairs/pairs.json` and fill in one entry per pair:

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

**3. The least you can get away with** is `original` and one timestamp:

```json
{ "id": "pair09", "original": "some_record.wav", "flip": "1:04" }
```

That is a real, usable pair. It scores one metric instead of six. A field you
leave out removes a metric; it never breaks the load. The same is true of a
field you get wrong: an unreadable key or a negative tempo ratio is dropped
with a note, and the rest of the pair still scores.

**4. Run it.**

```
python scripts/eval_accuracy.py --dataset sample_pairs --no-gate -v
```

**What is worth the effort, in order.** If you only have time for one thing per
pair, write the timestamp. If you have time for two, make it a span (`from` and
`to`) — that is what turns one metric into four. The tempo and pitch are worth
adding when you know them offhand; do not go and measure them. Twenty pairs
with a span each beat two hundred with a shrug.

| field | what it buys |
|---|---|
| `original` + `flip` timestamp | `flip_mark` |
| `flip` as a span (`from`/`to`) | `flip_top1`, `flip_topk`, `flip_mrr` as well — the headline numbers |
| `song` + `tempo_ratio` | `tempo_ratio` |
| `song` + `pitch_semitones` | `pitch_shift` |
| `original_bpm`, `original_key` | the ordinary tempo and key metrics, on a record we have no annotation for |
| `filtered`, `notes` | nothing yet; they are the record of what a future metric should measure |

`flip` is deliberately loose — `"1:04"`, `"1:04-1:12"`, `[64, 72]`,
`{"from": "1:04", "to": "1:12"}`, `{"at": "1:04", "length_s": 8}` and
`{"at": "1:04", "bars": 4, "source_bpm": 93}` all parse. Bars build a span only
with your own BPM beside them: deriving the length from *our* tempo estimate
would let a tempo error move the ground truth.

## The metrics, and why each is defined that way

Six, printed in their own table under the usual one. Every one is skipped (not
counted) when the pair does not carry what it needs, and counted as a miss with
a reason when the pair carries it but the pipeline produced nothing.

### Did we find the flip?

The loop finder runs on the **original record** with its own default settings
(`bars = 1, 2, 4, 8`), and returns a ranked list. It is never told where the
flip is, and never told how long it is.

| metric | definition |
|---|---|
| `flip_top1` | the **top** candidate overlaps the used section at IoU ≥ 0.5 |
| `flip_topk` | any of the **top 10** does |
| `flip_mrr` | mean of 1 / rank of the first candidate that does, over a depth of 50; 0 if none |
| `flip_mark` | a top-10 candidate covers the producer's timestamp, widened by the pair's `tolerance_s` |

**Why IoU, and why 0.5.** Overlap has to be symmetric in a way that punishes
both kinds of wrongness — a candidate in the wrong place, and a candidate the
wrong length — so intersection over union of the two spans is the measure. The
threshold is set by the two ways the finder can be right without being exact:

| the finder returns | IoU | verdict |
|---|---|---|
| exactly the used section | 1.00 | hit |
| the section, in a candidate twice as long | 0.50 | hit — it is the right part of the record, with an edge to drag (principle 4) |
| half the section, inside it | 0.50 | hit — same reason |
| the right length, one bar early (of four) | 0.60 | hit |
| the right length, half of it elsewhere | 0.33 | miss |
| the bar next door | 0.00 | miss |

0.5 is the lowest threshold that keeps the two containment cases and rejects
the half-overlap. It is a bar about *the record*, not about the edges: a
candidate that passes is one a producer would recognise as the right spot.

**Why both strict and lenient.** A rack of ten and a single automatic pick are
different products with different bars (PRODUCT_DIRECTION, surface 1). The
product shows a rack, so `flip_topk` is the number that says whether the
feature works; `flip_top1` is the number that says whether the ranking is good
enough to ever act without the human. Reporting only one would flatter or
condemn the wrong thing.

**Why MRR for the ranking.** "Where did the real answer appear" is a rank, and
a mean of ranks is dominated by the misses. The reciprocal rank is bounded,
averages honestly, and reads directly: 1.0 = always first, 0.5 = second on
average, 0.1 = tenth. The literal rank is in every item's `detail` and in the
miss reason ("the flip is rank 14"), which is what you actually debug from.

**Why `flip_mark` exists, and how to read it.** It is the only metric a pair
with nothing but "around 1:04" can score, and without it half the pairs the
owner can write down would be unusable. It is also the weakest bar in the set:
a rack of ten candidates covers a good fraction of a short record, so covering
one instant is not hard. Every `flip_mark` result therefore carries
`covered_s` — the seconds of the record the rack covers between them — and the
score only means something next to it. On a three-minute record a rack
covering 40 s has a ~22 % chance of covering any given instant by luck; on the
synthetic pairs the rack covers 69 % of the record, so `flip_mark = 1.0` there
says almost nothing. Read it as a floor: failing it means the rack is actively
avoiding the part of the record the producer used.

### Did we measure the transform right?

| metric | definition |
|---|---|
| `tempo_ratio` | the stretch `combine.align.plan_alignment` would compute, within 2 % of the ratio the producer used |
| `pitch_shift` | the shift it would compute, within 0.5 semitones of the producer's, modulo an octave |

Both come from the shipped planner, not a second implementation: the record's
report and the song's report become two `AlignItem`s with the song as the
target, and the plan's `stretch_ratio` and `pitch_semitones` are the
prediction. That is exactly what the product would do if the user dropped both
files in and asked to fit one to the other. The song is analysed with `tempo`
and `key` only.

**2 % on the ratio** is `BPM_TOLERANCE` (2 BPM) expressed as a ratio at the
~95 BPM this product centres on, so the tempo bar is the same bar as
everywhere else. A ratio wrong by a factor of two is reported as `tempo
octave` rather than as a percentage, because it is one estimate in the wrong
octave rather than a bad measurement, and the fix is different.

**Modulo an octave on the pitch** because a key-derived shift only ever claims
a pitch class. Scoring +2 against a truth of −10 as a miss would punish us for
a claim we never made. 0.5 semitones is the rounding bar: our claim is an
integer, so the question is only whether it lands on the right semitone.

One useful property fell out of this: both metrics measure a *relationship*, so
a key estimate that is wrong the same way on both files still scores. On the
synthetic pair the key stage reads the record as C minor when it is F minor,
reads the song as D minor, and `pitch_shift` is correctly +2.

### The ordinary six, for free

If a pair carries `original_bpm` or `original_key`, those become truth for
`bpm_exact`, `bpm_octave`, `key_exact` and `key_relative` on the record. The
owner's knowledge of a record they have flipped is annotation as good as any
dataset's, and it costs nothing to score it.

## What the synthetic pairs prove — and what they do not

```
python scripts/eval_accuracy.py --make-synthetic-pairs
python scripts/eval_accuracy.py --dataset sample_pairs --no-gate
```

Two pairs are written into `data/sample_pairs/`:

- **`synthetic_01`** — a 16-bar loop-based "record" at 96 BPM, and a "song"
  built by cutting bars 4–8 out of it and playing them 12.25 % faster with new
  drums over the top. Resampling moves tempo and pitch together, the way a
  sampler or a turntable does, so the truth (`tempo_ratio` 1.1225,
  `pitch_semitones` +2) is one physical operation seen two ways rather than two
  independent claims.
- **`synthetic_02`** — a different record, with no song file and nothing but a
  rough timestamp (`"flip": "0:11.4"`, `tolerance_s: 2`).

They prove the path end to end: manifest → loader → pipeline → loop finder →
alignment → metrics → both tables → results JSON. They prove the degradation
rule too: `synthetic_02` scores exactly one metric and skips five, with a
reason on each skip, rather than erroring.

They prove **nothing about accuracy**. The material is four chords and a drum
machine; the beat grid is exact by construction; the record is 40 seconds long,
so the rack covers most of it. No number from this set should ever be quoted as
a result, and the set is ungated for that reason.

The run, on 2026-09-13 (2 pairs, 16 s):

```
dataset       items  flip_top1  flip_topk  flip_mrr   flip_mark  tempo_ratio  pitch_shift
sample_pairs  2      0.000 (1)  1.000 (1)  0.100 (1)  1.000 (2)  1.000 (1)    1.000 (1)
misses by reason:
  sample_pairs.flip_top1: the flip is rank 10 x1
```

One real finding already, and it is about the finder rather than the harness:
the used section is found at **rank 10**, and the candidate that matches it
almost exactly (IoU 0.998) is ranked **50th of 50**. The finder's top ranks
fill with one-bar candidates, which score well on seam and stability because
the material is uniform. On this material, `flip_top1` cannot pass and
`flip_topk` only passes because a four-bar candidate one bar early slips in at
rank 10. Whether that survives contact with real records is exactly what the
owner's pairs will tell us — and it is the first thing to look at if
`flip_topk` comes back low.

## What counts as good

The number to watch is **`flip_topk`**, on ten or more real pairs.

First, the floor. A rack of ten drawn at random from a three-minute record
contains something meeting IoU ≥ 0.5 against a given four-bar flip roughly a
quarter of the time (≈ 250 enumerable candidates at 1/2/4/8 bars, of which ≈ 7
clear the threshold; ten draws ⇒ ~24 %). Treat 0.25 as chance, and remember it
is an estimate from arithmetic, not a measurement.

| `flip_topk` | what it means |
|---|---|
| **≥ 0.70** | genuinely useful. Seven times in ten, the rack a producer scrolls contains the spot a professional chose. The feature ships and the rack is the product. |
| 0.45–0.70 | real signal, not yet a feature you would put first. The rack is worth showing; the ranking needs work before it is trusted. |
| 0.25–0.45 | at or near chance. The finder is finding loops, not *the* loop; whatever makes a section worth sampling is not in the score. |
| **≤ 0.25** | not useful. We are no better than handing the producer a scrub bar, and the scoring terms need rethinking rather than tuning. |

The rest, with the same sample:

- **`flip_top1` ≥ 0.40** would mean the single automatic pick is worth acting on
  (chance is ~3 %). Below ~0.15 the ranking is noise: the product must show a
  rack and must never present one answer as the answer.
- **`flip_mrr` ≥ 0.40** means the flip is typically in the top two or three —
  the difference between scrolling and glancing.
- **`flip_mark`** below `covered_s / duration_s` is a red flag at any value: the
  rack is covering the record but avoiding the part that mattered.
- **`tempo_ratio` and `pitch_shift` ≥ 0.80** and the alignment can fit a sample
  automatically and say so. Below 0.50 the UI must offer the fit as a
  suggestion with the alternate, never apply it silently.

**Sample size.** These numbers are binomial: at 10 pairs one standard error is
±15 points, at 20 pairs ±10. Do not read a 5-point move between runs as a
change, and do not gate on a number measured once. Twenty documented pairs is
the right target (OPEN_QUESTIONS 42), and a pair with a span is worth several
with only a timestamp.

**When to gate.** Once ten or more pairs have scored the same `flip_topk`
twice, put a gate a couple of points under it in `scripts/gates.json` and say
so in the PR. Leave `flip_top1` ungated until the ranking is worth defending.
Until then `sample_pairs` has no entry at all, on purpose.

## Decisions made while building (no one to ask)

1. **The manifest lives in `data/sample_pairs/pairs.json`, not in
   `scripts/datasets/`.** The other dataset files are generated lists of public
   annotations; this one names the owner's records, so it belongs with the
   audio, under the gitignore. The template ships in the repo as
   `sample_pairs.example.json`. A manifest at `scripts/datasets/sample_pairs.json`
   is also read, for the case where the ids are codenames and the owner wants
   the pairs in version control.
2. **The item's audio is the original record.** That is what the finder is
   pointed at, so that is what the harness analyses, times and reports. The
   song is a second, cheaper analysis (`tempo`, `key`) inside the pair
   measurement.
3. **A pair runs `tempo, beats, onsets, key, structure`**, not the full default
   stage set: those five are what the finder and the alignment read. Loudness,
   groove and spectral would change nothing and cost time. `--stages` still
   overrides.
4. **The finder is scored as it ships** — default bars, default weights, no hint
   about the flip's length. Handing it the answer's length would measure a
   product we do not sell.
5. **Depth 50, rack 10.** `flip_topk` is the rack a producer scrolls;
   the ranking is scored 50 deep so "ranked badly" and "not found" are
   distinguishable in the detail. Past 50, "we did not find it" is the honest
   summary.
6. **`sample_pairs` is in `DATASETS` but not in `PUBLIC_DATASETS`** — `--dataset
   all` picks it up when it exists and prints a note when it does not, and the
   fetcher never touches it. There is nothing to fetch; there never will be.
7. **Ungated**, per the brief and per §5 of `scripts/README.md`. A threshold
   invented before the first measurement is a number with nothing behind it.

## Privacy

The pair audio and the manifest are under `data/`, which is gitignored, and the
loader never copies a path into the results document. What reaches
`data/eval/latest.json` (the one file that is committed) for a pair is: the
`id` the owner chose, the truth numbers, the candidate spans in seconds, the
scores and the miss reasons. `title`, `artist`, `notes` and `filtered` stay in
the manifest on the machine, and so does the text of any field the loader could
not read: a diagnostic names the field ("flip timestamp unreadable", "the song
is not in the audio folder") and never quotes it, so a filename cannot reach
the results through an error message either. A test asserts this. If a pair's id would itself give away a record,
call it `pair07` — the harness does not care.

This keeps the rule the rest of the harness keeps: the audio never leaves the
machine, only scores are shareable. It also means a pair set of uncleared
flips can be scored without publishing what it is made of.

## Things for the lead

- **The finder's ranking prefers one-bar candidates.** On the synthetic pair
  the exact four-bar match of the used section ranks 50th of 50 while one-bar
  candidates take the top five. If the owner's pairs show the same, the fix is
  in the finder's scoring (a term for the phrase length a flip actually uses,
  or ranking within bar counts rather than across them), not in this harness.
  Worth a `PROPOSALS.md` entry once there is real data behind it; I have not
  written one, because right now the only evidence is a drum machine.
- **`filtered` is recorded and not scored.** "Drums removed, low-passed at 8 k"
  is exactly the claim `sample_ready` makes about a candidate
  (`vocal_free`, `drums_free`), so a seventh metric — does our stem profile
  agree with what the producer actually stripped — is available as soon as
  pairs with that field exist and separation runs in the harness.
- **A pair also contains the answer to "what did they change".** Chop count and
  reordering (`analysis/sampleuse.py`) are measurable against a pair the same
  way, if the owner is willing to write down "chopped into 4, played 1-3-2-4".
  The manifest ignores unknown fields, so that can be added without a format
  change.
- **The harness now imports `loops.finder` and `combine.align`.** That is a
  deliberate widening of the "only the public pipeline" rule in
  `eval/__init__.py`, limited to this dataset: those two modules are the thing
  being measured.
