# HANDOFF: loop ranking — what it ranks, and whose ranking it is

Two halves of one thing. The finder ranked the wrong property, and the
corrections table that knows what this producer actually wants was read by
nothing. Both are now closed for loop ranking.

Nothing was committed, pushed, or opened as a PR. The migration is **written
and not applied**.

| path | what |
|---|---|
| `analysis/lockedgroove/loops/finder.py` | two new scored terms (`phrase`, `recurrence`), re-balanced weights, new components |
| `analysis/lockedgroove/learn/__init__.py` | new package: what the product learns from one producer's corrections |
| `analysis/lockedgroove/learn/loop_prefs.py` | the read path, the bounded per-user adjustment, and the sentences that explain it |
| `analysis/lockedgroove/jobs/analyze.py` | `personalize_ranking()`; `find_loops` applies the file owner's preference and reports it |
| `analysis/tests/test_loops_ranking.py` | 23 tests: the bug, the prior's shape, phrase alignment, period agreement, recurrence |
| `analysis/tests/test_loop_prefs.py` | 19 tests: cold start, bounds, legibility, the switch, and never across accounts |
| `analysis/tests/test_loop_finder.py` | the assertions that pinned the old four terms and weights, re-pinned to the new six |
| `supabase/migrations/20260913001200_loop_ranking_personalization.sql` | the switch, the read index, the correction payload shapes. **Not applied.** |

`scripts/gates.json` is **unchanged**. Its own note says `sample_pairs` stays
ungated until ten or more real pairs have scored the same `flip_topk` twice.
One synthetic pair scoring 1.000 is not that, and a gate written on it would be
a number with nothing behind it.

---

## Half one: why short candidates won

### The cause, measured

The score was `0.40 seam + 0.25 stability + 0.25 novelty + 0.10 onset_lock`.
All four are measures of *how little goes wrong inside the span*, and a short
span has less inside it. On the sample-pair record (40 s, 16 bars, the
pipeline's own grid), the mean of each term by bar count:

| bars | n | seam | stability | novelty | onset_lock | score |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 16 | 0.599 | 0.950 | 1.000 | 1.000 | **0.827** |
| 2 | 15 | 0.564 | 0.949 | 0.972 | 1.000 | 0.806 |
| 4 | 13 | 0.531 | 0.948 | 0.904 | 1.000 | 0.776 |
| 8 | 8 | 0.615 | 0.947 | 0.741 | 0.999 | 0.768 |

Read it term by term, because they do not all misbehave the same way and the
fix has to account for that:

- **`novelty` is a pure length penalty.** `1/(1+Σ confidence)` over interior
  section boundaries. A one-bar span essentially never contains one; an
  eight-bar span usually does. 1.000 → 0.741 with nothing musical said.
- **`seam` decays with length.** It compares two 100 ms windows. At one bar
  they are 2.5 s apart; at eight bars, 20 s apart. Local self-similarity falls
  with distance, so seam falls with length — 0.599 → 0.531 from one bar to
  four. (Eight recovers to 0.615 on this record because eight bars *is* its
  measured repeat period, which is the signal the new terms make explicit.)
- **`stability` measured nothing**: 0.947 to 0.950 across every bar count. It
  still costs a musically interesting phrase points whenever there is a fill in
  it, which is the wrong way round.
- **`onset_lock` was the only clean term.** It looks at the start alone, so it
  never had a length bias, and it is unchanged.

So 0.65 of the weight fell with length, another 0.25 measured nothing, and the
0.10 that was clean looked only at the start. Nothing scored being a musically
useful length, so the ranking was decided by construction. The exact match for
the section the producer flipped (IoU 0.998) ranked **50 of 52**; the top five
were all one-bar cells of uniform material. Two independent findings, one cause.

### What was added

Not a bonus for being long — that would put every eight-bar candidate on top,
and a two-bar break is sometimes exactly right. Two terms that say what makes a
span a loop rather than a fragment, both from measurements the pipeline already
makes.

**`phrase` (weight 0.22)** — `0.6 * phrase_length + 0.4 * phrase_alignment`.

- `phrase_length` = `BAR_PRIOR[bars] * period_agreement`.
  - `BAR_PRIOR = {1: 0.25, 2: 0.70, 4: 1.00, 8: 0.85}`, default 0.45. The
    musical claim, stated plainly: **four bars is the default unit of a sampled
    loop in this music; two bars is the break; eight bars is a long phrase you
    chop down; one bar is a one-shot, not something to rap over.** It is a peak
    at four, not a ramp, which is what stops it from being a length bonus. One
    bar keeps a non-zero prior because a one-bar candidate is still worth
    offering — just not first.
  - `period_agreement` reads `structure.loop_period_bars`:
    `bars == P` → 1.00 (the record's own repeating unit), `2*bars == P` → 0.90
    (one of the two phrases in it — an ABAB record measures a period of 8 bars
    and the producer takes 4, which is the single most common flip there is),
    `bars == 2P` → 0.80, a quarter or four times → 0.45, anything else → 0.35.
    The whole table is faded in by `loop_period_confidence`, so **a record that
    measured no period changes nothing** (principle 2). The record can pull the
    prior down where its own structure contradicts it and can never invent a
    preference the measurement does not support.
- `phrase_alignment` asks whether the start sits on a phrase line: the offset of
  the start anchor from a phrase origin, modulo the candidate's *own* length,
  scaled so a whole-phrase start is 1.0 and a start half a phrase late is 0.0.
  Phrase origins are the first anchor plus every measured section start within
  half a beat of an anchor, best origin wins — so a record with a two-bar intro
  still has its phrases found. This is the term that separates "bars 5–8" from
  "the window that happens to start in the middle of bar 6", and on the
  measurements below it is the single biggest contributor.

**`recurrence` (weight 0.08)** — the number of *other* candidates of the same
length whose mel fingerprint matches this one (cosine ≥ `REPEAT_SIMILARITY`),
saturating at 2. The main loop of a record comes back; the intro, the bridge and
the outro do not. It is counted on the deduped set **before** the repeat
collapse, which is what makes it (a) a statement about the record rather than
about which candidates survived, and (b) blind to stems — the collapse is the
one pass stems change, and `test_stems_do_not_change_a_single_loop_score` still
holds bit for bit. Nothing here favours length: a one-bar cell recurs as readily
as a four-bar phrase, which is exactly why it is separate from `phrase`.

**Weights.** `seam 0.30, phrase 0.22, stability 0.15, novelty 0.15,
onset_lock 0.10, recurrence 0.08` — still summing to 1, so `score` is still in
[0, 1] and `loops.score` means what it meant.

The three terms that carry the bias went from 0.90 of the weight to 0.60
(0.30 + 0.15 + 0.15), and the 0.30 freed went to the two that measure length
musically (0.22 + 0.08). Within that: `seam`
keeps the largest single weight because it is the only term that measures what
the loop point actually sounds like; `stability` lost the most because it
measured almost nothing while still penalizing a phrase with a fill in it;
`novelty` keeps real veto power (a boundary at confidence 0.9 still costs
0.07); `onset_lock` is untouched because it never had the bias.

`components` gains `phrase`, `recurrence`, `phrase_length`,
`phrase_alignment`, `period_agreement`, `recurs_elsewhere`, `loop_period_bars`,
and new `reasons` strings ("lands on a 4-bar phrase line", "the same 4 bars
come back 3x in the record", "half the measured loop period (8 bars)", "1 bar
is short for a loop to play under"). `weights` still carries the formula, now
with six entries.

---

## The numbers, before and after

Two harness datasets, plus one measurement of my own, because neither harness
dataset scores the finder on more than one item.

### `python scripts/eval_accuracy.py --dataset sample_pairs --no-gate`

Two pairs; the flip family applies to the one that carries a span.

| metric | before | after |
|---|---:|---:|
| **`flip_topk`** | 1.000 (1) | **1.000 (1)** |
| **`flip_mrr`** | 0.100 (1) | **1.000 (1)** |
| `flip_top1` | 0.000 (1) | 1.000 (1) |
| `flip_mark` | 1.000 (2) | 1.000 (2) |
| `tempo_ratio` | 1.000 (1) | 1.000 (1) |
| `pitch_shift` | 1.000 (1) | 1.000 (1) |
| `bpm_exact` | 1.000 (1) | 1.000 (1) |
| `bpm_octave` | 1.000 (1) | 1.000 (1) |
| `key_exact` | 0.000 (1) | 0.000 (1) |
| `key_relative` | 0.000 (1) | 0.000 (1) |

The rank of the candidate that matches the used section almost exactly
(IoU 0.998) went from **50 of 52 to 7 of 52**; the first candidate clearing
IoU ≥ 0.5 went from rank 10 to rank 1; the top ten went from
`[1,1,1,1,1,2,2,1,1,4]` bars to `[4,4,4,8,4,4,4,4,4,4]`.

**This is one item.** `flip_top1 = 1.000` on n=1 is a fact about one synthetic
record built from a drum machine and four chords, and it is worth exactly what
`docs/HANDOFF_sample_pairs.md` says it is worth: nothing about accuracy. It is
reported because it is the number the brief asked for and because the *cause*
it exposed was real. The owner's real pairs are what decide whether this holds.

### `python scripts/eval_accuracy.py --dataset synthetic --no-gate`

48 items. **Every metric identical, to three decimals.**

| metric | before | after | gate |
|---|---:|---:|---:|
| `bpm_exact` | 0.562 | 0.562 | 0.50 PASS |
| `bpm_octave` | 1.000 | 1.000 | 0.95 PASS |
| `key_exact` | 0.833 | 0.833 | 0.65 PASS |
| `key_relative` | 1.000 | 1.000 | 0.85 PASS |
| `downbeat` | 0.792 | 0.792 | 0.75 PASS |
| `structure_f` | 0.931 | 0.931 | 0.60 PASS |

That is expected rather than reassuring: the six section-16 metrics score the
analysis stages, and the loop finder is not on their path. It is worth stating
because it is the honest answer to "did anything else move" — no, and it could
not have.

### Synthetic loop-truth: 48 items, my own measurement

The public harness scores the finder on exactly one item, which is not enough
to change weights against. Every item in `data/synthetic` is built from an
explicit loop (`params.loop_bars`) repeated through each section, so the set
carries a known true loop the way a sample pair carries a known flip. Truth for
an item is every aligned `loop_bars` window inside a section; a candidate counts
when it reaches IoU ≥ 0.5 against any of them — the harness's own
`span_iou` / `flip_ranks` / `FLIP_IOU_THRESHOLD`, not a second implementation.

This measurement is **not in the repo**: `eval/**` is another agent's, and a
seventh metric invented here would be a fork of the harness. "For the next
person" below says how to rebuild it in ten minutes, and the two claims it
turns on are pinned as unit tests on one fixture in `test_loops_ranking.py`:
`test_the_records_own_loop_is_near_the_top` (rank <= 3 against the same
`span_iou` / `FLIP_IOU_THRESHOLD`) and `test_the_top_of_the_rack_is_not_one_bar_cells`.

| | before | after |
|---|---:|---:|
| top-1 is the record's loop (IoU ≥ 0.5) | 0.500 | **0.979** |
| in the top 10 | 0.979 | **1.000** |
| MRR | 0.654 | **0.986** |
| mean top-1 IoU | 0.527 | **0.845** |
| top-1 at IoU ≥ 0.8 (nearly exact) | 0.125 | **0.583** |
| top-1 has the record's bar count | 0.250 | **0.646** |
| one-bar rows in the top 10, over 480 rows | 175 | **3** |
| four-bar rows in the top 10 | 131 | **262** |

### What each piece is worth (same 48 items + the pair)

| variant | top-1 | MRR | IoU ≥ 0.8 | right length | 1-bar rows in top 10 | pair MRR |
|---|---:|---:|---:|---:|---:|---:|
| **shipped** | 0.979 | 0.986 | 0.583 | 0.646 | 3 | 1.000 |
| old weights (before) | 0.500 | 0.654 | 0.125 | 0.250 | 175 | 0.100 |
| no phrase alignment | 0.813 | 0.872 | 0.229 | 0.667 | 0 | 1.000 |
| no section-start origins | 0.938 | 0.965 | 0.604 | 0.646 | 3 | 0.333 |
| no recurrence (weight → seam) | 0.938 | 0.969 | 0.521 | 0.646 | 10 | 1.000 |
| flat bar prior | 0.979 | 0.984 | 0.583 | **0.500** | **54** | 1.000 |
| softer bar prior `{1:.6, 2:.85, 4:1, 8:.92}` | **1.000** | **1.000** | **0.646** | 0.563 | 5 | 1.000 |

Every piece earns its place except one, and that one needs saying plainly.

**The bar prior is the weakest-evidenced part of this change, and a softer
prior scores better on the headline metric.** A flat prior matches the shipped
one on top-1 and MRR; a softer prior beats it. Two reasons I kept the prior as
it is, both stated so the next person can overrule them with real pairs:

1. **The IoU ≥ 0.5 threshold cannot see what the prior is for.** A two-bar
   candidate sitting inside a four-bar loop scores exactly 0.5 and counts as a
   hit. Half the synthetic items have a four-bar loop, so softening the prior
   buys "hits" made of half-length candidates. On the metric that is not
   confounded — does the top candidate have the record's own bar count — the
   shipped prior wins (0.646 vs 0.563 soft, 0.500 flat).
2. **The rack is the product.** A flat prior puts 54 one-bar rows in the top ten
   across 48 records. A producer scrolling that rack is being handed fragments,
   and no IoU number on this set registers the difference. That is a product
   judgement, not a measured one, and it is labelled as such.

Two more rows where the shipped configuration is not the best on every column,
both left in the table rather than out of it:

- **`no phrase alignment` scores 0.667 on "right length", above the shipped
  0.646.** Alignment costs a little there while tripling near-exact top-1 hits
  (0.229 → 0.583) and lifting top-1 from 0.813 to 0.979, so it stays — but it is
  a small real regression on one measure, not a clean win.
- **`no section-start origins` scores 0.604 at IoU ≥ 0.8, above the shipped
  0.583.** Section starts as extra phrase origins are worth 0.04 of top-1 and
  0.02 of MRR across 48 items, and they are the difference between rank 1 and
  rank 3 on the pair (`flip_mrr` 1.000 vs 0.333) — on a record whose measured
  sections are *wrong*, which is the awkward part. They stay because a record
  with an odd-length intro has no other way to have its phrases found, but the
  evidence for them is thinner than for anything else here.

---

## Half two: the ranking learns from this producer

`corrections` has been written faithfully since the first migration and read by
nothing but the accuracy harness. A producer's edits improved our scoreboard and
never their next result. That is the moat left on the floor: a tool that gets
better at *this crate* is something a DAW cannot be.

`analysis/lockedgroove/learn/loop_prefs.py` is the read side. It is deliberately
small: no model, no audio, no training. It reads a few hundred rows for one
`user_id`, turns them into a handful of bounded numbers, and those numbers nudge
an ordering that was already computed and already explained.

### What a correction says

| `corrections.field` | `predicted` / `corrected` | what it is evidence of |
|---|---|---|
| `loop_edges` | `{start_s, end_s, bars?}` — the offered span and the kept one | a vote for the bar count they kept, against the one we offered; and a "longer/shorter" tally |
| `loop_bars` | the counts, or the same span shape | the same vote, said outright |
| `loop_pick` | the top row and the chosen row, each `{bars, rank?, components?}` | the same vote, **plus** which scored terms the chosen row beat the top row on |

An edge drag that names no bar count still counts when the duration ratio lands
within 2 % of a whole multiple. A row that does not carry what a signal needs is
skipped, never guessed at. The web does not write these three yet — the loop
PATCH route updates `loops` without logging a correction — so the payload shapes
are documented in the migration's `comment on column corrections.field`, which
is where the writer and the reader can agree in writing.

### What it learns, and how it is bounded

Two adjustments, both over numbers the finder already publishes, both printable
in a sentence:

- **`bar_prior_delta[bars]`** — a shift of `BAR_PRIOR`, the finder's default
  claim about length. This is the one the brief names: a producer who always
  drags the edges out moves their own four- or eight-bar prior up. Each entry is
  the account's net vote share for that bar count, times `BAR_DELTA_MAX` (0.5),
  times `strength`.
- **`term_delta[term]`** — a shift of one scored term's weight, learned only
  from `loop_pick` rows where the chosen row and the top row differed on that
  term. The whole vector is budgeted: `sum(|delta|) ≤ TERM_DELTA_BUDGET` (0.10),
  times `strength`.

`strength = min(0.6, n / (n + 8))`, so it is 0.5 at eight corrections and hits
the cap at twelve. Eight is about one session of real use: enough that a
producer would be annoyed to see the same wrong ranking again, few enough that
one unusual afternoon cannot rewrite their defaults. The climb is fast on
purpose — the conservative part is the 0.6 cap and the 0.15 score bound, not
how long it takes to get there.

Applied in closed form from `components`, because everything needed is already
there:

```
delta = W_phrase * PHRASE_LENGTH_SHARE * period_agreement * bar_prior_delta[bars]
      + Σ_term term_delta[term] * components[term]
delta = clip(delta, ±PERSONAL_SCORE_MAX)          # 0.15
score = clip(score_measured + delta, 0, 1)
```

**The one number to quote: a producer's own history can move a loop's score by
at most 0.15 of a score that runs 0 to 1.** Nothing measured is overwritten —
every term stays in `components` exactly as the finder wrote it, beside a
`components["personalization"]` entry carrying `score_measured`, `delta`, the
per-row `reasons`, the account-level `why`, and the cap. `score` becomes the
adjusted number because `loops` is read `order by score desc` and that is what
orders the rack.

`LoopPreference.explain()` returns the sentences, e.g.:

> Learned from your last 14 loop corrections, at 60% of the most this is
> allowed to count.
> You keep ending up on 4 bars, so 4-bar loops rank higher for you (+0.15 on
> their prior).
> You keep moving off 2 bars, so 2-bar loops rank lower for you (-0.15 on
> their prior).
> The loops you choose score higher on how the loop point sounds than the ones
> we put first, so it counts more for you (+0.060 of weight).
> You usually drag loop edges out (10 longer, 0 shorter).
> This comes from your corrections only, never anyone else's, it can move a
> loop's score by at most 0.15, and you can turn it off.

(real output, from ten `loop_edges` rows dragging two bars out to four and four
`loop_pick` rows taking a smoother seam over the top row)

They are on every loop row (`components.personalization.why`) and on the job
result (`jobs.result.personalization`), so the chat can answer "why is this one
first for me" from either without a new tool.

### How cross-user contamination is prevented

Four mechanisms, and each is asserted:

1. **Every read is filtered by one `user_id`.** `read_loop_corrections` passes
   `{"user_id": user_id, "field": [...]}` and then re-checks `user_id` on each
   returned row. A falsy `user_id` returns nothing rather than the table.
2. **The preference carries its owner.** `LoopPreference.user_id` is set at
   construction and the class is frozen.
3. **Mixed input is an error, not a merge.** `learn_loop_preference(user_id,
   rows)` raises `ValueError` the moment a row's `user_id` is anyone else's.
4. **Applying across accounts is an error.** `apply_preference(candidates, pref,
   user_id)` raises unless `pref.user_id == user_id`. The job passes
   `file["user_id"]` and raises a `JobError` if the file has no owner.

There is **no cache and no module-level state** anywhere in the module: with a
hundred accounts on one worker, a hundred separate reads happen. That is a
deliberate cost — it is one small indexed select per loop search — because a
shared cache is exactly the shape a leak takes.

`test_one_accounts_corrections_never_reach_anothers_ranking` gives two accounts
opposite histories (A drags 1 → 8 bars twenty times, B drags 8 → 1) in one
database and asserts: each reads only its own twenty rows; each learns the
opposite preference; B's preference from a database containing only B's rows is
identical to B's preference from the shared one; applying A's preference to B's
ranking raises; and learning A's preference from B's rows raises.

### Cold start

`learn_loop_preference(user, [])` returns `LoopPreference.neutral`, whose
`strength` is 0. `apply_preference` then returns the finder's own list **object
for object**, with nothing written on any candidate.
`test_a_new_account_gets_exactly_the_finders_ranking` asserts identity of the
objects and equality of every `to_row()`, so "a new account gets the tuned
defaults from half one and nothing personal" is a pinned property rather than
an intention.

### Seeing it and turning it off

- `profiles.loop_personalization boolean not null default true` (in the
  migration). Off means the measured ranking alone, which is also exactly what a
  new account gets. The existing `profiles_update_own` RLS policy already lets a
  producer set it; only `plan` is fenced.
- `params.personalize = false` on a single `find_loops` job, for the harness and
  for a support session.
- An unreadable profile or an unreadable corrections table means *on* and
  *neutral* respectively: the ranking degrades to the measurement, never fails.

### Cost

**In the finder** (half one): `phrase` is arithmetic per candidate and free.
`recurrence` is one normalized similarity matrix per bar count over fingerprints
the repeat collapse computes anyway — median **+0.3 to +0.5 s on a 5.5-minute
record with 453 candidates**, about 15 % of the finder's 2.4 s there. It is
O(n²) in candidates per bar count, so a 20-minute file (the `MAX_ANALYSIS_S`
ceiling) costs a few seconds rather than a fraction of one. That is inside the
budget of a job that downloads a file and runs librosa over it, and it is the
first thing to look at if the finder ever needs to be interactive.

**In the read path** (half two): one `select` of at most 300 rows for one user on
`corrections (user_id, created_at desc) where field in ('loop_edges',
'loop_bars', 'loop_pick')` — a partial index the migration adds — then
arithmetic over a few hundred dicts. It runs inside the `find_loops` job next to
a file download and a librosa feature pass, and it must never become a training
pipeline. `test_the_read_is_one_bounded_query` asserts the query count, the
filters, the limit and the ordering.

---

## What only real corrections from a real crate can confirm

Everything in half two is measured against fabricated corrections. Nobody has
dragged a loop edge in this product yet, so these are the open questions, in the
order they will be answered:

- **Whether the signals exist at the volume assumed.** `strength` reaching 0.5
  at eight corrections and its cap at twelve is a guess about how often a
  producer edits a loop. If real use produces two edits a week, the personalization is invisible;
  if it produces fifty a session, `STRENGTH_HALF` is too low and the first
  afternoon overwrites the defaults.
- **Whether a bar-count preference is even stable.** A producer may want four
  bars from soul records and one bar from drum breaks, in which case a single
  per-account prior is the wrong shape and the preference should be conditioned
  on something about the record. Nothing here would detect that; the symptom
  would be a preference that keeps flipping sign.
- **Whether `loop_pick` rows carry components.** The term-weight half is dead
  weight unless the web writes the finder's terms for both rows. The rack
  already holds `RankCorrection` in `web/lib/session/rack.ts` with
  `predictedRank` and `action` and no route to post it to — that is the missing
  write side, and it needs `components` on both rows to feed this.
- **Whether ±0.15 is the right authority.** It is enough to move one length
  class past another on the records measured here. On a real record where the
  measured scores are more spread out it may do nothing; on a flat one it may do
  too much.
- **Half one's bar prior.** As above: the synthetic set cannot separate the
  shipped prior from a softer one on the headline metric. Ten real pairs can,
  and the ablation table is there to be re-run against them.
- **Whether the phrase grid is right on real records.** `phrase_alignment`
  stands on the measured downbeat grid plus measured section starts. A record
  whose bar phase we get wrong gets its phrase lattice wrong too, and the term
  then costs accuracy instead of buying it. The 0.4 share inside `phrase` and
  the section-start origins are both hedges against that; whether they are
  enough is a question about real records.
- **`filtered` pairs.** A pair that says "drums removed, low-passed at 8k" is
  the claim `sample_ready` makes. Once those exist, a candidate's stem profile
  could join the ranking the same way — deliberately not done here, because the
  finder's contract is that a loop's score means the same thing with or without
  stems.

## Green

```
cd analysis && uv run pytest -q     659 passed (23 new in test_loops_ranking.py,
                                     19 new in test_loop_prefs.py)
cd analysis && uv run ruff check .  All checks passed
```

## For the next person

- **Reproducing the two harness numbers.** `python scripts/eval_accuracy.py
  --make-synthetic-pairs` then `--dataset sample_pairs --no-gate`;
  `python scripts/build_synthetic_dataset.py` then `--dataset synthetic
  --no-gate`. Both write under `data/`, which is gitignored.
- **Reproducing the 48-item loop-truth measurement.** Cache one analysis report
  per `data/synthetic` item (stages `tempo, beats, onsets, key, structure` —
  they do not depend on the finder, so cache once and re-score freely), run
  `find_loops(y, sr, report, top_k=50)`, build the truth spans as above, and
  score with `lockedgroove.eval.metrics.flip_ranks` / `span_iou` /
  `best_overlap`. About 4 minutes to cache, 1 minute per variant after that.
- **Every weight and threshold is a module constant** with the musical claim in
  its docstring. `BAR_PRIOR`, `PERIOD_AGREEMENT`, `PHRASE_LENGTH_SHARE`,
  `RECURRENCE_FULL`, `WEIGHTS` in `loops/finder.py`; `STRENGTH_HALF`,
  `STRENGTH_MAX`, `BAR_DELTA_MAX`, `TERM_DELTA_BUDGET`, `PERSONAL_SCORE_MAX`,
  `READ_LIMIT` in `learn/loop_prefs.py`. Tune against the harness, not by hand.
- **The web side that is missing**, in the order it is worth building: a route
  that logs `loop_edges` when `PATCH /api/loops/[id]` moves an edge (the
  prediction is the row's current span, the correction is the new one); a route
  for `RankCorrection` writing `loop_pick` with both rows' `components`; the
  account switch for `profiles.loop_personalization`; and a chip on a rack row
  reading `components.personalization.reasons`.

## Proposal (PROPOSALS.md template; not appended there — other agents edit it concurrently)

### Condition the loop preference on what kind of record it is
**What it does for a producer:** Four bars from a soul record and one bar from a
drum break stop fighting each other. The system learns "you take long loops from
melodic records and one-bar hits from breaks" instead of averaging the two into
a preference that is wrong for both.
**Principle it serves:** 7, and the crate thesis: the tool gets better at *this*
crate, not at crates in general.
**Principle it risks:** 2, mildly — a conditioned preference has less evidence
per bucket, so the confidence hedging has to get stricter, not looser.
**What it takes:** A coarse, measured bucket per file (the `drums_only` /
`vocal_free` profile `sample_ready` already computes, or a tempo band), one
preference per bucket with the same bounds, and a fall-back to the unconditioned
preference until a bucket has its own evidence. Real corrections first: without
them there is nothing to bucket.
**Where it belongs:** After the first ten real producers' corrections exist.
**Status:** proposed.
