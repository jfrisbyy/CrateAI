# HANDOFF: sample-ready loops (stem-aware loop scoring)

Owner of this seam: the loops agent. Scope: score every loop candidate by **what
is and is not playing inside it, per stem**, so "show me the vocal-free 4 bar
loops in this record" is a query instead of an afternoon of scrubbing.

The two halves already existed and had never been introduced: `find_loops`
ranked candidates on seam, stability, novelty and onset lock but never looked at
the stems; the `stems` job split a file into drums, bass, vocals and other but
nothing read the result back into the loop list. This is the join.

Nothing outside the files below was touched. No commits, no push, no PR.

## Files

| Path | What |
|---|---|
| `analysis/lockedgroove/loops/sample_ready.py` | **new.** Pure functions over arrays: per-stem energy per span, presence bands, the four claims, the selection helpers. No I/O, no database, no report. |
| `analysis/lockedgroove/loops/finder.py` | `find_loops(..., stems=None, stem_source=None)`; `components["sample_ready"]`; stem-aware repeat folding; ordering by `score * ranking_factor` |
| `analysis/lockedgroove/loops/__init__.py` | re-exports `StemSource`, `Claim`, `SampleReady`, `StemSpan`, `filter_loops`, `sort_loops`, `holds`, `claim_of`, `span_profile`, `stem_energies`, `CLAIM_NAMES`, `FLAG_CLAIM_NAMES` |
| `analysis/lockedgroove/jobs/analyze.py` | the `find_loops` task loads the file's stems and passes them through; `loop_stems()`, `params.use_stems`, new result fields |
| `analysis/lockedgroove/testing/synth.py` | **new fixture** `stem_track(...)`: a track rendered as four separate stems with a bar-exact arrangement, a vocal release tail, and ad-libs |
| `analysis/tests/test_loops_sample_ready.py` | **new.** 44 tests: the bands, the near miss, the shapes, bleed, withholding, the finder, the job path |
| `supabase/migrations/20260913000620_loops_sample_ready.sql` | **not applied.** No new column (the flags live in the existing `loops.components` jsonb); a GIN index plus three partial indexes for the filter queries |

## Commands and results

```
cd analysis && uv run pytest
  458 passed, 2 skipped in 98.60s          (414 passed, 2 skipped before this work;
                                            the 44 new tests are mine)

cd analysis && uv run pytest tests/test_loops_sample_ready.py
  44 passed

cd analysis && uv run pytest tests/test_loop_finder.py tests/test_loop_render.py \
                             tests/test_loop_naming.py tests/test_job_analyze.py tests/test_jobs_more.py
  108 passed          (the existing loop and job suites, unchanged, including
                       test_find_loops_replaces_finder_rows_and_returns_ids whose
                       fake finder has no `stems` parameter)

cd analysis && uv run ruff check .
  All checks passed!
```

No existing test was changed, skipped or deleted.

## What a loop now carries

`components["sample_ready"]`, only when the file has stems:

```json
{"source":  {"model": "<label>", "trusted": true, "note": null},
 "claims":  {"vocal_free": {"value": true, "confidence": 0.95, "why": "...",
                            "stem": "vocals", "presence": "absent"},
             "drums_free": {"value": false, "confidence": 0.95, "why": "..."},
             "drums_only": {"value": false, "confidence": 0.95, "why": "..."},
             "fullness":   {"value": 3, "confidence": 0.95, "of": 4,
                            "stems_present": ["bass", "drums", "other"],
                            "stems_faint": [], "why": "..."}},
 "profile": {"vocals": {"presence": "absent", "mean_db": -120.0, "peak_db": -120.0,
                        "rel_mean_db": -101.5, "rel_peak_db": -101.5, "rel_mix_db": -108.2,
                        "audible_fraction": 0.0, "loudest_at_s": null, "isolation_db": 101.5,
                        "leakage_correlation": null, "leaks_from": null}, "...": {}},
 "caveats": ["separation leaks: this describes the separated stem, not proof the record has nothing there"],
 "ranking_factor": 1.0}
```

`components["reasons"]` gains chip texts from the same reading: *"no vocal in
this span"*, *"a quiet vocal is still in here around 6.7s"*, *"drums only: this
is the break"*, *"no drums: chop it and lay your own under it"*, *"only the bass
is playing"*. About 2.6 KB of `components` per loop with stems (1.9 KB of it the
stem block), against 0.7 KB without.

Selection, on `LoopCandidate` objects or on `loops` rows alike:

```python
from lockedgroove.loops import filter_loops, sort_loops, holds, claim_of

filter_loops(loops, vocal_free=True, bars=4)            # the query that saves the time
filter_loops(loops, drums_only=True)                    # the breaks
filter_loops(loops, drums_free=True, min_stems=2)       # chop it, lay your own drums under it
sort_loops(loops, prefer=("vocal_free",))               # measured vocal-free first, then by score
holds(loop, "vocal_free", min_confidence=0.6)           # one loop, one question
```

A **withheld** claim never matches a filter. "Show me the vocal-free loops" must
not answer with loops nobody measured.

**Cost.** The envelope is built once per stem in blocks, never as a whole-file
cumulative sum (which would be hundreds of megabytes per stem on a long file
for no more accuracy than a 25 ms grid gives). Four stems plus the mix of a
four-minute 44.1 kHz record: 0.13 s to measure, ~60 MB of working memory, and
0.14 s to score 200 candidates against it. Next to the finder's own mel
spectrogram this is free. The job's real cost is downloading the stems.

## Thresholds, and why they are where they are

Per stem, once per file, on 50 ms windows at a 25 ms hop (about one syllable and
about one drum hit: short enough that a single ad-lib shows as a peak, long
enough not to chase waveform cycles):

| Constant | Value | Why |
|---|---|---|
| `ACTIVE_RANGE_DB` | 40 dB | The stem's reference level is the **median of the frames within 40 dB of its loudest**, not a percentile of all frames: a singer who only appears in the hook must not read as a quiet stem. |
| `FLOOR_PERCENTILE` | 5 | The stem's own noise floor, and with the reference level its `isolation_db`. |
| `ABSENT_MEAN_REL_DB` | −38 dB | Span mean this far under the stem's own level is its noise floor. At a normal stem level near −20 dBFS that is about −58 dBFS: inaudible under anything. |
| `ABSENT_PEAK_REL_DB` | −26 dB | **The tighter gate, and the important one.** No 50 ms window inside the span may come nearer than this. One loud syllable ruins a loop. |
| `ABSENT_MEAN_ABS_DB` / `ABSENT_PEAK_ABS_DB` | −58 / −48 dBFS | Absolute back-stop for a stem that is quiet over the *whole* file, where its own reference level means nothing (a separation that found almost no vocal, a stem that is silence). |
| `PRESENT_MEAN_REL_DB` | −20 dB | Loud enough to be material you can use. |
| `PRESENT_PEAK_REL_DB` | −12 dB | ...with a peak to match. A stem under the absolute absence floor can never read as present however loud it is against its own (equally absent) reference. |
| `MARGIN_FULL_DB` | 12 dB | Distance past a threshold at which a claim earns its full confidence. |
| `ISOLATION_POOR_DB` / `ISOLATION_GOOD_DB` | 25 / 55 dB | Below 25 dB of range the stem never goes quiet anywhere in the file, so "quiet here" is weak evidence; above 55 dB the separation demonstrably produces silence. |
| `TRUST_FLOOR` | 0.50 | Worst case multiplier from separation quality: a claim on a smeared separation tops out near a coin flip. |
| `LEAKAGE_CORRELATION` | 0.85 | A quiet stem whose 50 ms envelope tracks a louder stem's this closely is showing that stem through. |
| `LEAKAGE_CONF_CAP` | 0.50 | What suspected leakage does to a "not clean" call. |
| `LONE_STEM_FACTOR` / `EMPTY_FACTOR` | 0.80 / 0.60 | Ranking factor for a span with one lone part in it / nothing in it. |

Between absent and present is **`faint`**: audible, not usable, and never
"clean". Every band decision is two statistics, not one, and they have to agree.

Levels are read twice, absolute (dBFS) and **relative to what that stem does
everywhere else in the file**. The relative reading is the honest one: a stem is
absent when it is far below what it does when it plays, not when it is below a
number that depends on how the record was mastered. The absolute reading is the
back-stop for when the relative reference is degenerate.

One known bias: the span **mean** is energy-based while the reference level is a
**median of frames**, so percussive stems read a few dB "above their own level"
in `rel_mean_db`. It is conservative in the direction that matters — it can only
make a present stem look louder, never make a quiet-but-present stem look
absent — so it is left alone rather than papered over.

## The near miss: a quiet vocal is not a clean loop

This is the case the feature lives or dies on. A span where the vocal is quiet
but present — a held note tailing off into the bar after the singer stops, one
background ad-lib in four otherwise empty bars — **must not** be reported as
clean. Four things handle it:

1. **The peak gate.** `ABSENT_PEAK_REL_DB` is 12 dB tighter than the mean gate,
   and both have to pass. A 120 ms ad-lib 18 dB under the singer's normal level,
   in a 10.7 s span, pulls the span *mean* to −41 dB relative — below the mean
   gate, i.e. the mean alone says clean — while the loudest 50 ms sits at −18 dB
   relative, well above the peak gate. Not clean. `test_one_quiet_adlib_is_not_
   clean_even_where_the_mean_alone_would_pass` pins exactly that arithmetic.
2. **Frames never reach outside the span.** Only windows lying *entirely* inside
   `[start, end)` count. A window straddling the start would count the syllable
   just before the loop as if it were in it, and that edge is the one the
   producer is placing. `test_a_loud_hit_just_before_the_span_does_not_count_as_
   inside_it`: the same syllable is out at `start = 1.0 s` and in at `0.9 s`.
3. **The `faint` band is reported, not rounded away.** The claim comes back
   `value: false` with `presence: "faint"`, a `why` that says *"quiet but not
   gone: the vocal stem peaks 18 dB below its own level at 6.70 s"*, and
   `loudest_at_s`, so the producer can nudge the edge past it instead of
   wondering. The chip reads *"a quiet vocal is still in here around 6.7s"*.
4. **The confidence falls as the evidence gets thinner**, so a 6 dB-quieter
   ad-lib reads 0.57 rather than 0.95, and the UI hedges it.

Deliberately asymmetric: a false "not clean" costs a producer one loop out of a
list; a false "clean" costs them a beat built on a vocal they did not hear until
the thirtieth bar. Where the two are indistinguishable, the claim goes to "not
clean" and the confidence says it is a coin flip.

## Confidence, and when a claim is withheld

```
confidence = (0.50 + 0.45 * min(1, |margin_db| / 12))     # 0.50 at the threshold, 0.95 at 12 dB past
             * quality                                    # only on quiet readings
             capped at 0.50 when the quiet content looks like leakage
```

* **`margin_db`** is how far past its threshold the evidence sits, in dB: the
  binding one of the mean and peak gates. A claim sitting exactly on its
  threshold is a coin flip (0.50) and nothing here ever reaches 1.0 (principle
  2: these are measurements of a separation, not facts about a record).
* **`quality`** = `0.5 + 0.5 * clip((isolation_db − 25) / 30)`. A separation that
  produced real silence somewhere in the file can be believed when it says
  silence here; one whose quiet parts still carry the band cannot. It is applied
  **only to `absent` and `faint` readings**: "this stem is loud here" needs no
  proof that the separation can produce silence, "this stem is not here" does.
* **The leakage cap.** Leakage is a scaled copy of the stem it came from, so in
  dB it is the same shape with an offset. When a `faint` stem's envelope across
  the span correlates ≥ 0.85 with a louder stem's, what is in there is as likely
  to be that stem showing through as a real quiet part: the claim does **not**
  flip to clean (see the asymmetry above), its confidence is capped at 0.50, and
  the `why` and a caveat say which stem it follows. Measured on the fixtures:
  3 % of the drums mixed into the vocal stem correlates 0.993 and is capped; a
  real 120 ms ad-lib correlates 0.076 and keeps its 0.795.
* **Aggregates take the weakest link**: `drums_only` and `fullness` are the
  minimum of the per-stem band confidences, not an average.

**Withheld** (`value: null`, `confidence: 0`, plus `withheld: "<reason>"`):

| When | Reason |
|---|---|
| The stems came from the development stand-in (`LOCKEDGROOVE_FAKE_STEMS=1`, rows labelled `<model>-fake`) | It is a band split, not a separation: its "vocals" is a bandpass filter and a vocal-free claim off it would be fiction. All four claims withheld, `ranking_factor` forced to 1.0, the measured profile still reported and labelled, the chip reads *"stems are the development stand-in: no vocal-free claim"*. Detected generically by the `-fake` suffix on the model label — no model name appears in the code. |
| The separation has no vocal stem | `vocal_free` withheld; the rest still answered. A vocals/instrumental separation answers the vocal question; a drums-free one does not answer the drums question. |
| A stem named for what was taken **out** of it (`no_vocals`, `vocals_removed`, `instrumental`, `backing`, …) | Never matched as that stem: answering the vocal question from the instrumental would invert the answer. |
| No stems at all | No `sample_ready` block, and every filter returns nothing rather than guessing. |

Every claim, withheld or not, carries a plain `why` sentence, which is what the
chat is allowed to say (principle 2).

## What it does to ranking

**The loop score is untouched.** Seam, stability, novelty and onset lock are
what they always were, with or without stems, bit for bit
(`test_stems_do_not_change_a_single_loop_score`). A loop's score means the same
thing on a file that has been separated and one that has not, which keeps the
accuracy harness comparable.

Two things do change, and only when stems are present:

1. **Ordering.** Candidates are ordered by `score * ranking_factor`, which is
   1.0 for everything except a span with one lone part in it (0.80) or nothing
   (0.60). A drums-only break keeps 1.0: a break is a find, not a lone part —
   the distinction the packet's "fullness" line is really about. Without stems
   the factor is exactly 1.0 everywhere and the order is unchanged.
2. **Repeat folding is stem-aware.** Contiguous repeats of the same content fold
   onto the earliest candidate. With stems, they only fold when the *same stems
   are playing*: the intro and the identical bars with the singer over them are
   two different loops to anyone flipping them. On the fixture this takes the
   4-bar list from 4 candidates to 8, four of them clean and four not.

## The job path

`analyze` with `task: "find_loops"` now loads the file's stems (from the `stems`
rows and their `files`, resampled to the file's rate) and passes them to the
finder. Additions to `jobs.result`:

```json
{"stems_used": ["bass", "drums", "other", "vocals"],
 "stem_model": "<label>", "stems_trusted": true,
 "sample_ready_counts": {"vocal_free": 4, "drums_free": 0, "drums_only": 0}}
```

* `params.use_stems = false` skips the stem load entirely.
* A missing or unreadable stem **costs the claims, never the loops**: the job
  logs, falls back to `stems_used: []`, and writes the same rows it always did.
* The finder is called with `stems=` only when there are stems *and* the
  imported `find_loops` accepts the parameter, so an older or stubbed finder
  still runs (this is what keeps the existing job tests passing untouched).
* Nothing is written to a new column: the flags ride in the existing
  `components` jsonb. The migration adds indexes only, and is **not applied**.

## What the synthetic fixtures prove, and what they cannot

`synth.stem_track(bpm, sr, bars, arrangement, vocal_release_s, adlibs)` renders
drums, bass, chords and a vocal melody as **separate stems** with a bar-exact
arrangement, and the mix is exactly their sum scaled by one gain. It is a
*perfect* separation; every bleed case adds the leakage on purpose.

They prove:

* the arithmetic: bands, margins, confidences, the aggregation, the JSON shape;
* the arrangement questions are answered correctly bar by bar — vocal-free
  before the singer and not after, a span straddling the entry is not clean, the
  break is drums-only, the lone bass is not a find, `fullness` counts only what
  is usable;
* the near miss is handled, including the case where the mean alone would have
  said clean;
* withholding, for the stand-in, for a missing stem, for negated stem names;
* that confidence falls with bleed and that suspected leakage is capped;
* that the finder's existing scores are unchanged and that the existing loop and
  job suites pass untouched.

They cannot prove:

* **that the thresholds are right for real separated material.** The fixture's
  "absent" is digital silence (−120 dBFS); a real vocal stem's absent is
  residue, room, and breath at −40 to −60 dB. The margins that the fixture makes
  enormous are the ones a real record makes small, and those are exactly the
  ones that decide a claim.
* **what a real separation's `isolation_db` distribution looks like**, which is
  what `ISOLATION_POOR_DB` / `ISOLATION_GOOD_DB` were set against by reasoning,
  not measurement.
* **whether the leakage correlation threshold of 0.85 separates leakage from a
  quiet vocal on real material.** On the fixtures the two cases are 0.996 and
  0.08, which is not a hard test.
* **whether "faint" is the right verdict for a producer**, or whether some
  faint spans are perfectly usable (a breathy tail under a loud band is often
  inaudible in the loop).
* anything about a separation's *spectral* artefacts: this reads levels only.

## What a real record would be needed to confirm

1. **A separated record with a hand-marked truth track**: bar ranges that are
   genuinely vocal-free by ear, genuinely a break, genuinely drums-free. Run the
   claims against it and count. The near-miss bars (the bar after the last
   chorus, the bar with one ad-lib) are the ones that matter; a set of twenty
   such bars would settle the two peak thresholds.
2. **The residue level of a real separation**: the vocal stem's dB distribution
   over hand-marked instrumental sections, per model. That is the number
   `ABSENT_PEAK_REL_DB` should be set from, and it is per-model.
3. **A bled separation and a clean one of the same record** (two models), to see
   whether the isolation and leakage proxies actually track "how much should I
   believe this" or just track the material.
4. **Producer judgement on the `faint` band**: play twenty faint spans as loops
   and ask "would you use it". That decides whether `faint` should be reported
   as not-clean (today) or as clean-with-a-warning.
5. The accuracy harness (principle 9) is where 1–3 belong once there is a
   labelled set; none of this should be tuned by hand against one record.

## Interpretation choices (numbered for the PR description)

1. **The loop score is not touched by stems.** The packet's four weights stay.
   Content moves the *order* through an explicit `ranking_factor`, exposed in
   `components`, which is 1.0 whenever there are no stems. Alternative
   considered and rejected: folding fullness into `score` as a fifth term, which
   would make scores incomparable between separated and unseparated files and
   would quietly move the harness.
2. **A drums-only span is not penalised for being sparse.** "Fullness" as a
   plain stem count would sink exactly the breaks producers hunt for. The lone
   part penalty applies only when the one part is not the drums.
3. **Presence is three bands, not two.** `faint` exists so a near miss has
   somewhere to live other than "clean".
4. **Both statistics must agree.** Mean *and* peak, relative *or* absolute.
5. **Frames lie entirely inside the span.** See the near-miss section.
6. **Separation quality weighs only on quiet readings.**
7. **Suspected leakage caps confidence rather than flipping the claim.**
8. **The stand-in withholds rather than hedges.** A band-split "vocals" stem is
   a bandpass filter; hedging a claim derived from it would still be a claim.
   Detection is the generic `-fake` suffix (`FAKE_MODEL_SUFFIX`), so no model
   identifier appears anywhere in the code.
9. **Stem-aware repeat folding.** Same chords plus a singer is a different loop.
   Only active when stems are present.
10. **The flags live in `components`, not a new column.** The `loops` table
    already has a jsonb column, the whole block is 1.9 KB, and Postgres can
    index a jsonb path. The migration (indexes only) is written and **not
    applied**.
11. **A withheld claim never matches a filter.** `filter_loops(vocal_free=True)`
    returns measured, confident matches only; `min_confidence` defaults to 0.6.
12. **`loop_stems` never fails a job.** Stems are an enrichment of a loop
    search, not a precondition for one.
13. **`sample_ready` the function is not re-exported from the package**, so
    `lockedgroove.loops.sample_ready` keeps pointing at the module. The per-span
    entry point is `lockedgroove.loops.sample_ready.sample_ready`.
14. **Stem name matching is by alias with a negation guard** (`vocals`, `vocal`,
    `voice`, `lead_vocals`; `drums`, `drum`, `percussion`), skipping anything
    named for what was removed from it. A six-stem separation's `guitar` and
    `piano` need no special casing: they count toward fullness and toward
    "everything else is out" for free.

## Known limitations / backlog candidates

* **Transient leakage is invisible to `isolation_db`.** A drum leaking into the
  vocal stem still leaves silence between the hits, so the stem's dynamic range
  stays wide and the quality factor stays high. The envelope-correlation check
  is what catches that case; the two together are not a complete story.
* **A vocal that sings through the whole file** has a high `floor_db`, so any
  absence claim about it is (correctly) low confidence — but the reason shown is
  the generic "never drops near silence" caveat, which reads oddly when the
  truth is "the singer never stops".
* **Level only.** A vocal buried under a loud band can be at −20 dB relative and
  still be inaudible in the loop; a solo vocal at the same level is glaring. A
  masking-aware reading (`rel_mix_db` is already measured and stored, and is the
  obvious input) would be better than a pure per-stem level. See the proposal.
* **Fixed 50 ms window.** Very slow material, or a very short (1-bar at 60 BPM)
  loop, might want beat-relative windows. Tune against the harness.
* **`fullness` treats stems as equally important.** A missing `other` on a
  four-stem separation is not the same loss as a missing `drums`.
* The claims describe the **span**, not the loop *as rendered*: the tail
  crossfade wraps in audio from just after `end`, which `render.py` plays and
  this does not read. A vocal starting 20 ms after the loop point can be heard
  in the rendered loop and is not in the profile.
