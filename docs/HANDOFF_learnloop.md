# HANDOFF: the learning loop — the wire between the producer's hands and their ranking

`docs/HANDOFF_ranking.md` built both ends of this and left the middle empty. The
learner read three `corrections.field` values (`loop_edges`, `loop_bars`,
`loop_pick`); the web wrote six different ones (`tempo_bpm`, `downbeat_phase`,
`first_downbeat_s`, `key`, `meter`, `section_labels`). The overlap was empty, so
a producer could drag loop edges all day and their next search would rank
exactly the same. This pass is the wire.

Nothing was committed, pushed, or opened as a PR. **No migration was applied**;
`20260913001200_loop_ranking_personalization.sql` is still written-and-waiting,
and what that costs is spelled out under "the switch" below.

| path | what |
|---|---|
| `web/lib/report/edits.ts` | the loop-correction half: the payload builders, and what counts as a correction |
| `web/lib/report/loopCorrections.ts` | **new.** when a row is written, coalesced, or skipped; the only place that writes them |
| `web/app/api/loops/[id]/route.ts` | PATCH takes `via`, and logs `loop_edges` / `loop_bars` |
| `web/app/api/loops/[id]/render/route.ts` | exporting a candidate logs `loop_pick` |
| `web/app/api/loops/personalization/route.ts` | **new.** the switch: GET the state, PATCH it off |
| `web/components/surface/LoopPersonalization.tsx` | **new.** the note above the rack, the chip on a row |
| `web/components/surface/LoopsTab.tsx` | a bar-count control per row, the note, the chip |
| `web/components/surface/{Surface,surfaceState}.tsx` | `via` carried through the loop patch |
| `web/app/api/loops/corrections.test.ts` | **new.** drives the routes and writes the cross-language fixture |
| `analysis/tests/fixtures/loop_corrections_from_web.json` | **new.** the rows those routes actually insert |
| `analysis/tests/test_loop_learning_e2e.py` | **new.** 8 tests: empty database → replayed rows → real finder → the rack moves |
| `analysis/lockedgroove/jobs/analyze.py` | the preference is read before the search, and ranks a deeper pool |
| `docs/CONTRACTS.md` | the three loop routes say what they log |

`analysis/lockedgroove/learn/loop_prefs.py` is **unchanged**. So is
`loops/finder.py`, and so is every existing test.

---

## What the brief said was missing, and what was actually missing

One correction to the brief, because the next person will trip on it: **the
learner already ran.** `find_loops_task` has called `personalize_ranking` since
the ranking pass landed, and `test_the_job_ranks_for_the_files_owner_and_nobody_else`
pinned it. What was missing was everything upstream (nothing wrote a row it could
read) and one thing downstream (the rack it reordered was only twelve rows deep).
Both are closed here.

---

## The three signals: where each is written, and what counts

All three are written by `web/lib/report/loopCorrections.ts`, which is the only
module that writes a loop correction. The payloads are built by
`web/lib/report/edits.ts` and are exactly the shapes pinned in
`comment on column corrections.field` — not one key wider. The shapes were right;
nothing had to diverge.

### `loop_edges` — a drag, a keyboard edge set, a nudge

**Where:** `PATCH /api/loops/[id]`, which is what the waveform's region drag
(`Waveform.tsx`), the `[` / `]` edge keys and the arrow-key nudge all already
call through `Surface.updateLoop`.

**Payload:** `predicted` `{start_s, end_s, bars?}` — the span the system offered;
`corrected` — the span the producer kept.

**What counts:** an edge that moved by more than **1 ms** (`LOOP_EDGE_EPSILON_S`),
on a loop the system proposed — `origin` `finder` or `chat`.

### `loop_bars` — the bar count said outright

**Where:** the same route, with `via: "bars"`. The control is new: a bar-count
select on each loop row in the Loops tab (`BarsControl` in `LoopsTab.tsx`), which
sets the length in bars and moves the end to the bar line on the file's own grid.
This was the one of the three signals a producer had no way to make; it now has
the most direct control of the three.

**Payload:** the same span shape, both sides. The reader takes `bars` first and
falls back to the duration ratio, so the span shape is strictly more informative
than bare counts and the migration's comment allows either.

**Why `via` exists at all:** dragging an edge changes the bar count as a
consequence, and setting the bar count moves an edge as a consequence. The rows
are indistinguishable after the fact, and only the client knows which control the
producer touched. `via` defaults to `"edges"`, so every existing caller keeps
meaning what it meant.

### `loop_pick` — a candidate taken that we did not put first

**Where:** `POST /api/loops/[id]/render` — exporting is where a producer takes a
candidate out of the rack and into the library, and it is the only committing act
on a loop row today. (When the candidate rack from `PRODUCT_DIRECTION` Surface 1
lands, `RankCorrection` in `lib/session/rack.ts` should call
`recordLoopPick` too; it is exported for that and takes only the loop.)

**Payload:** `predicted` the top row, `corrected` the chosen row, each
`{bars, rank, components}` where `components` is the finder's six scored terms
and nothing else — no `weights`, no `reasons`, no `personalization`.

**The rank is computed server-side** from the rack as it stands, ordered exactly
as `GET /api/loops` orders it (score desc, nulls last, ties by start). A rank is a
claim about our own ordering; taking it from the client would let a bad client
teach the ranker anything it liked.

---

## What was rejected as noise, and why

Each of these returns "nothing was corrected" and writes no row. They are the
part of this pass with the most judgement in it, so each has its reason attached
and a test named after it.

| rejected | why |
|---|---|
| a drag that ends where it started (within 1 ms) | that is a click, not a correction. Wavesurfer fires `region-updated` on any drag end, including a zero-length one |
| a rename, or any patch that touched no edge and no bar count | nothing was predicted and nothing was changed |
| **a chain of nudges or drags on the same loop** | eight taps of the nudge key are one correction. When an edit begins exactly where the last logged one ended, that row's `corrected` is **extended** instead of a new row being written, so the row says "the span we offered, the span they kept" — which is what the migration says it says. Without this, the arrow keys would have been the loudest signal in the table |
| a loop of `origin = 'user'` | the producer drew it at their own cursor. There was no prediction to correct, and logging it would teach the ranker that the app's own four-bar default was wrong — it was never a claim |
| exporting the row already ranked first | that is agreement. A row every time anyone exports anything would swamp the table and teach the ranker nothing (the reader skips it anyway, so it would be pure harness pollution) |
| exporting when it was the only candidate | being the sole option is not a preference |
| exporting the same row twice, or re-exporting one that already has a render | one choice, counted once |
| any of the above when the edit itself was refused (another account's loop, edges that cross) | no edit, no correction |

**Deliberately kept:** a drag that moves a loop without changing its length. It
is a real correction of a predicted span and the accuracy harness wants it; the
ranker reads it, finds no bar-count or duration change, and skips it. Inert for
the ranking, true for the harness — which is the correct asymmetry, since the
table serves both and nothing else (principle 7).

**A failure to write a correction never fails the edit.** The loop edit or the
export has already landed by the time the row is written; rolling the producer's
work back because bookkeeping failed would be a worse lie than a missing row. The
failure is logged and the route returns `correction: null`. This differs from
`POST /api/files/[id]/edits`, where the correction *is* the act, and that route is
unchanged.

---

## How the preference reaches the finder

`find_loops_task` in `analysis/lockedgroove/jobs/analyze.py`:

1. `loop_preference_of(db, file, params)` — **before the search**. One indexed
   select of at most 300 rows for `file["user_id"]`, plus one profile read. It
   raises if the file has no owner, returns neutral if `params.personalize` is
   false, and degrades to neutral (never fails) if the history cannot be read.
2. `loop_pool_size(top_k, preference)` — a neutral preference asks the finder for
   exactly `top_k`. A preference that is going to move something asks for
   `top_k * 3` (`PERSONAL_POOL_MULTIPLE`, capped at 120).
3. `find_loops(...)` as before.
4. `personalize_ranking(..., preference)` — the same function as before, now able
   to take the preference already read.
5. the rack is trimmed to `top_k`.

**Why the pool changed.** This is the one wiring change beyond "call it", and it
is the difference between a personalization that can reshuffle a rack and one
that can change what is in it. With a pool of exactly `top_k`, an account that
keeps dragging loops out to eight bars would see the same twelve four-bar rows
forever, in a slightly different order. It costs nothing measurable: the finder
scores every candidate and truncates last, so on the test record
`find_loops(top_k=12)` and `find_loops(top_k=36)` both take **0.27 s** warm
(0.274 vs 0.268, the difference is noise). A neutral account makes the same call
it made before this pass existed.

`personalize_ranking` keeps its old signature, so the existing job test still
calls it exactly as it did.

---

## What it does, measured

One record: sixteen bars, ABAB, built on a four-bar loop
(`loop_based_track`, 90 BPM, 85 s). Three accounts in one database, `top_k = 12`.
Each history is the 14 rows the web's own routes wrote (ten `loop_edges`, two
`loop_bars`, two `loop_pick`), replayed from the fixture.

| account | the rack, in bars | 8-bar rows | 2-bar rows |
|---|---|---:|---:|
| no corrections | `4 4 4 2 2 4 4 2 4 2 4 4` | 0 | 4 |
| keeps dragging out to 8 | `4 2 2 4 4 8 2 2 4 2 2 4` | **1** | 6 |
| keeps pulling in to 2 | `4 2 2 2 2 4 4 2 2 2 2 2` | 0 | **9** |

- The account that keeps asking for eight bars is **the only one offered any**:
  no 8-bar candidate was in the measured top twelve at all, and one arrives at
  rank 6. That is the pool change earning its place.
- The account that chops breaks moves its best two-bar row from rank 4 to rank 2
  and fills the rack with them.
- The account with no history gets the measured rack **object for object**, with
  no `personalization` key written on any row.

**What did not move, and this is the number to argue about:** the top row is the
same four-bar candidate in all three racks. Its score falls 0.8548 → 0.8350 for
both personalized accounts and it still wins, because it is 0.035 clear of the
next row and a bar-count preference can only move a score by

```
W_phrase (0.22) * PHRASE_LENGTH_SHARE (0.6) * period_agreement (<=1) * bar_prior_delta (<=0.3)
```

= **0.040 at the absolute most, ~0.020 in the two-sided case a real history
produces** — an order of magnitude below the `PERSONAL_SCORE_MAX` cap of 0.15
that the handoff quotes. The cap is not what binds; the phrase-length share is.
`HANDOFF_ranking.md` says the bar prior is "enough to move one length class past
another (score blocks on a real record sit about 0.05 apart)" — on this record it
moves several rows past each other and does not move the top one, so that claim
is *nearly* right and worth re-measuring against real pairs rather than tuning on
this synthetic one. **I did not change it**: the ranking is settled and this pass
is the wire. The term-weight half reaches further (a `term_delta` of 0.06 on a
term valued 1.0 moves a score by 0.06), so a producer whose picks say something
about *seams* gets a bigger adjustment than one whose drags say something about
*length*. That asymmetry is worth knowing about before anyone tunes either.

One more measured surprise, in the "drags out to eight" rack: **two-bar rows rose
too**, from 4 to 6. The history voted for 8 and against 4 and said nothing about
2, so 2 is unchanged while 4 falls beneath it. The learner's own sentence for that
account says "You keep moving off 4 bars, so 4-bar loops rank lower for you",
which is exactly what happened — but a producer asking for longer loops and being
handed more short ones would reasonably call it a bug. If real corrections show
this, the fix is in how votes are spread (a vote for 8 is not a vote for 2), not
in the wire.

---

## What cold start costs

Two selects, both indexed, both for one `user_id`: at most 300 correction rows
(the migration's partial index serves it) and one profile row. Then
`find_loops(top_k=12)` — the same call, with the same arguments, as before this
pass. `apply_preference` returns the finder's own list object for object and
writes nothing on any candidate, so the rack a new account gets is not "the
personalized rack that happened to come out the same": it is the same list.
`test_an_account_with_no_corrections_gets_the_measured_rack_and_nothing_written_on_it`
pins the objects, the scores and the absence of the key.

In the browser, an account whose rack was never personalized makes **no request
at all** for the switch: the Loops tab only asks for it once a search has
reported something to explain.

---

## How a producer sees it, and refuses it

**Sees it,** in the Loops tab:

- A line above the rack: *"Ranked partly from your own 14 loop corrections, by at
  most 0.15 of score."* — with a **Why** disclosure listing the learner's own
  sentences (`components.personalization.why` / `jobs.result.personalization.why`).
  Nothing in the UI restates the model; the sentences are the ones
  `LoopPreference.explain()` already wrote in plain language.
- A chip on each adjusted row: `yours +0.017`, whose tooltip carries the measured
  score beside the personal one and that row's reasons. **The measurement is never
  hidden**: `score_measured` sits next to `delta` on every row.
- When the account has no history, the same line says so and says what to do about
  it. When the switch is off, it says the rack is the measurement alone.

**Refuses it:** a `Turn off` button next to that line →
`PATCH /api/loops/personalization {enabled:false}` → `profiles.loop_personalization`.
Off means the measured ranking alone, which is also exactly what a new account
gets; it takes effect on the next loop search, and the note says so.
`params.personalize = false` still turns it off for a single job (the harness's
switch, and support's).

**The switch needs the migration.** Until
`20260913001200_loop_ranking_personalization.sql` is applied, the column does not
exist: `GET` answers `{enabled: true, available: false}` (on, which is the default
the column carries) and `PATCH` answers **503 with a plain sentence** rather than
pretending to have saved something. The *writing* half of this pass needs no
migration at all — `corrections.field` is free text, so the three signals are
being recorded correctly today; only the off switch and the partial index wait on
it. Applying it is the single highest-value action for whoever picks this up.

---

## The test that proves the loop is closed

`analysis/tests/test_loop_learning_e2e.py`, eight tests, ~11 s.

It starts from an empty `InMemoryDatabase`, replays a plausible history of
corrections **through the same code path the web uses**, runs the real
`find_loops` job over real audio, and reads the rack back out of the `loops`
table.

"The same code path" is load-bearing and is enforced across the language
boundary rather than asserted in prose:

1. `web/app/api/loops/corrections.test.ts` drives the **real route handlers** —
   `PATCH /api/loops/[id]` and `POST /api/loops/[id]/render` — through two
   sessions: a producer who keeps dragging four-bar offers out to eight, and one
   who keeps pulling them in to two.
2. It writes exactly what those routes inserted into
   `analysis/tests/fixtures/loop_corrections_from_web.json`, and asserts the file
   matches on every run (regenerate with
   `UPDATE_LOOP_CORRECTION_FIXTURE=1 pnpm test corrections`).
3. The Python test loads that file, stamps each row with its own account, and
   inserts it. The rows the ranker learns from are, byte for byte, the rows the
   web writes. A payload that drifts on either side fails on both sides.
4. The last of the eight (`test_the_replayed_rows_are_the_shapes_the_reader_documents`)
   asserts every replayed row is a field the reader reads, carries no key outside
   the pinned shape, and — the sharp one — that `learn_loop_preference` counts
   **all fourteen**: not one row the web writes is silently discarded as
   unreadable.

What it shows, with three accounts in one database:

- the ranking moves in the direction each history implies (a length class that
  was not in the rack arrives; the short rows climb);
- it does not move for the account with no history — same objects, same scores,
  nothing written;
- it moves the *other* way for the account whose history points the other way,
  and the three racks are three different racks;
- `n_corrections` is 14 for each of the two, never 28: neither account ever saw
  the other's rows, in one shared database;
- every adjusted row carries `score_measured + delta == score`, `|delta| <= 0.15`,
  its six measured terms untouched, and a reason for why it moved;
- `params.personalize = false` and `profiles.loop_personalization = false` each
  land on the measured rack **exactly** — the same spans and the same scores as
  the account with no history — and turning it back on restores the producer's
  own ranking.

---

## Green

```
cd analysis && uv run pytest -q        757 passed, 2 skipped   (was 749; +8 end-to-end)
cd analysis && uv run ruff check .     All checks passed
cd web && pnpm typecheck               clean
cd web && pnpm lint                    clean
cd web && pnpm test                    1785 passed, 3 failed   (was 1746 passed, the same 3 failed)
cd web && pnpm build                   clean
```

The three failing web tests are **pre-existing and untouched by this pass**: two
in `app/api/usage/route.test.ts` and one in `app/api/web/search/route.test.ts`,
both failing on the branch before any of these changes. They are date-dependent
(the double's `NOW` is 2026-09-13 and the wall clock has passed it), and their
assertion messages are identical before and after this pass. No test was
weakened, skipped or deleted; 47 were added (39 web, 8 analysis).

---

## What only real corrections from a real crate can confirm

`HANDOFF_ranking.md`'s list still stands in full — it was written about a model
measured on fabricated corrections, and this pass has changed nothing about the
model. What this pass adds to it, from the writer's side:

- **Whether the three signals arrive at the rates assumed.** The whole design of
  `strength` (0.5 at eight corrections) rests on a guess about how often a
  producer corrects a loop. Now that the rows are actually written, the first real
  week answers it. My own guess after wiring it: `loop_edges` will dominate
  heavily, `loop_bars` will be rare (a new control nobody has a habit for yet),
  and `loop_pick` rarest of all, because exporting is a bigger commitment than a
  drag. If that holds, the term-weight half of the model — which only `loop_pick`
  feeds — stays dead weight, and the honest move is to find a second, lighter
  "I took this one" act rather than to weight the rows we have more heavily.
- **Whether coalescing a chain of nudges is right.** It assumes a producer nudging
  from where they left off is continuing one thought. If real sessions show people
  returning to a loop hours later and nudging again, those merge into one row and
  the table under-counts. The symptom would be far fewer `loop_edges` rows than
  loop edits.
- **Whether export is the right pick signal.** It is the only committing act that
  exists today, and it is a *late* one — by the time a producer exports, they have
  auditioned five candidates and the four they rejected said nothing. The rack's
  "solo against the song" and "keep it" are the real pick acts, and when they land
  they will produce ten times the signal this does.
- **Whether refusing `origin = 'user'` loops throws away something real.** A
  producer who never uses the finder, only draws loops and drags them, generates
  no signal at all under these rules. That is correct by principle 7 and might
  still be the wrong product answer for that producer.
- **Whether ±0.02 of authority for a length preference is enough to be noticed.**
  Measured above: on this record it reorders the rack and changes what is in it,
  but never changes the single automatic pick. A producer who keeps dragging loops
  out and keeps seeing the same first row may reasonably conclude it never learned
  anything. Ten real pairs plus the ablation table in `HANDOFF_ranking.md` are what
  decide whether `PHRASE_LENGTH_SHARE` is the right route for the prior to enter
  the score by.

## For the next person

- **Apply the migration.** The switch and the read index are both in it, and the
  writing half is already live without it.
- **Regenerating the fixture** is one command and it must go through the routes:
  `UPDATE_LOOP_CORRECTION_FIXTURE=1 pnpm test corrections`. Never hand-edit
  `analysis/tests/fixtures/loop_corrections_from_web.json`; hand-editing it is
  precisely the failure mode this pass exists to remove.
- **The chat cannot edit a loop** (`lib/chat/db.ts` lists, reads and inserts, and
  has no update), so there is no second write path to keep in sync today. If a
  chat loop edit ever lands, it must go through `recordLoopSpanCorrection` too.
- **Everything about *when* a row is written is in one module**
  (`web/lib/report/loopCorrections.ts`) and everything about *what it says* is in
  one other (`web/lib/report/edits.ts`). Keep it that way: the bug this pass fixed
  was two descriptions of one thing, in two places, in two languages.
