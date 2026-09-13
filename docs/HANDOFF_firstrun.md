# HANDOFF_firstrun.md

The first four minutes: an empty crate, one record, and the moment a producer
sees something true about their own audio that they could not have got as fast
any other way.

The constraint this is built around is the product's first principle, and it is
the reason onboarding here is harder than most:

> Nothing from nothing. It does nothing at all until they bring their own audio.

So there is no demo crate, no sample pack, no "try it with this record". The
only screen that has to talk is the one where there is nothing to look at yet,
and everything after it is the product's own output doing the teaching. No
modal, no carousel, no checklist, no tour.

## 1. The four minutes, step by step

| Time | Where they are | What is on screen |
|---|---|---|
| 0:00 | `/login` | The form, and under it two things worth knowing before an account exists: it will not generate anything, and what free costs. |
| 0:10 | `/` , empty crate | "Nothing in the crate yet. Drop one record in." A drop target big enough to be the obvious next action, three lines of what happens after the drop, the constraint stated plainly, and the free tier in one sentence. |
| 0:30 | dropping | The upload, in its real steps: hashed in the browser first (bytes only move if the hash is new), checked against the crate, uploaded with a byte count, analysis queued. |
| 0:45 | queued | "Compute scales to zero between jobs, so a machine may have to start before it can read the file." |
| 1:00–2:00 | analyzing | The ladder: eleven steps, the one running now in amber, each saying what it will produce. Elapsed time, and either this account's own median analysis time or an honest "no estimate yet: this is the first one". |
| 2:00 | the report lands | Tempo, key, bar 1, sections, feel, bandwidth, level — each with the confidence it was measured with, the hedge word its band calls for, and the alternate it nearly chose. Plus the sentence that makes it theirs: anything wrong here is yours to fix, and the fix is kept. |
| 2:30 | one click | "Find the loops" — which costs nothing against any cap — then its progress on the same grid. |
| 3:30 | loops back | "4 loops found. Best: 4 bars at 0:12.000, scored 0.82." One button: **Play them**. It opens `/f/[id]`, the panel slides in on the Loops tab, and the producer presses play on a loop cut from the record they brought four minutes ago. |

That last row is the whole point. Everything before it is arranged to get there
with nothing in the way, and everything the screen says on the way is either a
real measurement or a statement of what the machine is doing right now.

## 2. Files

```
web/lib/onboarding/            pure, tested; no React, no fetch
  stages.ts      the analysis ladder read out of jobs.progress, elapsed,
                 this account's own median run time                        (+ test)
  findings.ts    the report -> the rows a producer reads first, with
                 confidence, hedge and the alternate                       (+ test)
  crate.ts       the second session: what the crate is, what landed while
                 they were away, what broke                                (+ test)
  limits.ts      the plan in one sentence, the caps as rows, the warnings   (+ test)
  memory.ts      the five remembered facts, localStorage, guarded           (+ test)
  state.ts       the step machine over files, jobs, uploads and memory      (+ test)

web/components/onboarding/
  FirstRun.tsx       the strip: picks the step, draws it, runs the two actions
  StageLadder.tsx    the wait
  FindingsTable.tsx  the measurements
  CapShape.tsx       the caps
  NotAGenerator.tsx  what it will not do                       (all four + test)

web/components/library/UploadZone.tsx   `variant="hero"` — the same drop target,
                                        first-screen sized (edited)
web/components/library/LibraryPane.tsx  empty-crate line (edited)
web/components/surface/EmptySurface.tsx the panel's empty state (edited)
web/app/(auth)/login/page.tsx           the constraint and the plan, pre-account (edited)
web/components/shell/Workspace.tsx      +2 lines: mounts <FirstRun /> (edited, see §9)
supabase/migrations/20260913001500_onboarding_state.sql   NOT APPLIED
```

Suite: 1155 passing in 122 files before, **1228 in 129 files** after. Nothing
existing was changed or skipped.

## 3. The state machine

`lib/onboarding/state.ts` derives the step from what the workspace already
knows — the library store's files, jobs and upload queue, plus five remembered
facts. There is no separate onboarding flow to drift out of step with the
product: a drop into the library rail, a retry from a row, or a second tab all
move the first run because they move the same state.

```
empty      nothing in the crate, nothing uploading
uploading  hashing / checking / uploading / queueing, with real progress
queued     the row exists, compute has not taken it
analyzing  the ladder, driven by jobs.progress
failed     what went wrong, and the retry
ready      the measurements. the teaching moment
returning  a crate that already works: what landed, what broke, what is in it
silent     nothing true worth saying. renders nothing
```

Two rules keep it from overstaying:

- **The working steps only show while no record has been analyzed yet.** Once
  the crate has one, the library rail's own progress line is enough and the
  strip gets out of the way.
- **It teaches for one session.** The `ready` card stays until the producer
  hides it, acts on it, or comes back after a gap of 30 minutes or more — at
  which point it becomes the returning strip instead.

An empty crate always shows the empty screen, however old the account is. An
empty library is a dead end whether it is your first day or your fortieth.

## 4. What the first analysis actually shows

A running `analyze` job writes exactly one number to the database:
`jobs.progress`. The stage name passed to `ctx.progress(fraction, stage)` is
not persisted (`analysis/lockedgroove/jobs/common.py`). But the fractions are a
fixed ladder — `0.02` download, `0.05` decode, then `0.1 + 0.8 * (i / n)` per
stage in `DEFAULT_STAGES` order, then `0.95` write — so the number does say
which measurement is running, and `lib/onboarding/stages.ts` reads it back.

`stages.test.ts` parses `DEFAULT_STAGES` out of `analysis/lockedgroove/pipeline.py`
and fails if the ladder drifts from it. That is the one coupling worth knowing
about: change the Python stage list and the test tells you to change the
ladder.

| Fraction | Step | What the row says it will give |
|---:|---|---|
| 0.02 | Fetching | your file, on the machine that measures it |
| 0.05 | Decoding | samples, and the waveform you will see |
| 0.10 | Tempo | BPM, with the half and the double it also considered |
| 0.20 | Beats | every beat, the downbeats, and the meter |
| 0.30 | Onsets | where the hits land |
| 0.40 | Key | tonic and mode, and the key it nearly chose instead |
| 0.50 | Groove | swing, and how far off the grid it sits |
| 0.60 | Loudness | integrated LUFS and true peak |
| 0.70 | Spectrum | brightness, width, and how high the content actually goes |
| 0.80 | Sections | where it changes, and the bar length it repeats on |
| 0.90 | Writing it down | the report, the waveform and the vitals, all at once |

**At five seconds** the only true thing is client-side: the hash, and whether
this record is already in the crate. That is shown, because it is real, and
because it explains why nothing has uploaded yet.

**At twenty seconds** the honest answer is the ladder, not a partial reading.
The report is composed in memory and written once at 0.95, so there is no
half-measured tempo to display, and the screen says so rather than inventing
one:

> The report is written in one pass at the end, so there are no half-measured
> numbers to show you. This is where the job actually is.

**At a minute** it is still the ladder, plus elapsed time and — if this account
has finished an analysis before — the median of its own past runs with the
sample size ("about 48 s (4 of them)"). On the very first one it says there is
no estimate yet, because there isn't. A test asserts no ladder row can contain
a number with a unit in it.

**Then everything lands at once**, which is the shape of the pipeline and is
fine: the payoff is large enough to be worth the wait, and the wait was legible.

*If the owner wants twenty seconds to carry real partial results*, the change is
in compute, not here: have `analyze_task` patch `files.report` after each stage
instead of once at the end (`db.update_file(file_id, {"report": partial})`
inside `on_progress`). Realtime already pushes `files` updates to the client and
`firstFindings()` already renders a partial report — it skips what is null.
That is maybe twenty lines in `analysis/lockedgroove/jobs/analyze.py`, and it
would turn the ladder into tempo appearing at 0:20, key at 0:40, sections at
1:00. It is the single highest-value follow-up in this handoff, and it is in a
directory this pass does not own.

## 5. "Nothing from nothing", said early and plainly

It appears twice before a producer can waste any time, and once more only if
they somehow got past both:

1. **On the sign-in page**, under the form, before an account exists.
2. **On the empty crate**, the first screen inside.
3. **On the payoff card**, only when the memory says the constraint was never
   shown (`seenConstraint`).

The framing is deliberately not an apology. It is the reason the numbers are
worth reading:

> It works on records you bring. There is no generator in here.
>
> Type "make me a boom-bap beat" and nothing comes back, by design. Everything
> it hands you is cut, stretched, separated, layered or re-voiced from a file
> you brought. That constraint is also why the numbers are worth reading: each
> one was measured off your audio and carries the confidence it was measured
> with, rather than being a language model's guess at what a record probably is.

The short form, used on the login page and the payoff card, says the same in
three lines. Both are in `components/onboarding/NotAGenerator.tsx`.

## 6. Limits, made legible before they bite

The free tier is unusual and worth saying out loud: **the expensive-feeling part
of this product is the free part, and the scarce part is conversation.**
`checkJobQuota` refuses only `stems` and the GPU kinds; `analyze` — which is
both the first analysis and the loop finder — is never refused for quota. So
the first screen says:

> Free: 2.00 GB of storage, 5 separations a month, 8 chat turns a day and 40 a
> month.
>
> Analysis and the loop finder spend none of this: only conversation, web
> lookups, separation and the bytes you store.

Both sentences are generated from `lib/billing/limits.ts` — no cap is retyped
anywhere in the onboarding copy, and `limits.test.ts` fails if `analyze` is ever
added to `GPU_JOB_KINDS`, because the sentence above would become a lie.

Where they appear:

- **Empty crate**: the sentence, the note, and a `<details>` with every cap as a
  row. Collapsed, because a producer with nothing uploaded does not need a table.
- **Payoff card and returning strip**: `capWarnings()`, which says nothing until
  a cap is at four fifths, then names what is left and when it resets, then —
  when one is gone — names what still works without it ("the analysis, the loops
  and the library still work").
- **Where a cost is about to be spent**: the breakdown is pointed at with its
  price attached ("it wants the drums separated first, which spends one of the 5
  separations a month"), so nobody spends a fifth of their month's separations
  by clicking a button that looked free.

The counts come from `GET /api/usage` once, when the strip mounts. They can go
stale within a long session; the account page is the live view and nothing here
enforces anything, so the worst case is a warning that is a turn or two behind.

## 7. What the second session opens onto

Returning with ten records is a different problem from arriving with none, so
the strip stops teaching and starts reporting. It shows when the producer has
been away 30 minutes or more, or whenever there is something true to say
(`crateLines()` returns nothing for a quiet crate, and then the strip does not
render at all).

```
Where you left off
12 records, 48:31, 71.0–96.4 BPM, 7 keys
3 records finished analyzing while you were away.
1 did not analyze; open it to see why, or retry it in the library.
[Open moonlight_highlife.wav]
```

- The numbers are measured, not counted loosely: only analyzed originals are
  "records", the tempo range comes from the effective reports (so a *corrected*
  BPM is the one that counts), and "while you were away" is read from finished
  `analyze` jobs rather than `files.updated_at`, so renaming a file is not
  reported as new work.
- The one button is the way back in: whatever landed while they were away,
  otherwise the record they had open when they left.
- At three records or more it adds the line that turns a crate into a library —
  that the search box takes `f minor 88-94` or `like the open file`, and that
  "what fits this" on an open record racks up everything that would sit under it.

## 8. Every piece of copy

So it can be rewritten in the owner's voice. Grouped by where it appears.

### Sign-in page (`app/(auth)/login/page.tsx`)

- *It works on records you bring. There is no generator in here.*
- *A description of a beat gets you nothing; every result is cut, stretched,
  separated or re-voiced from a file you uploaded. That constraint is the reason
  the numbers can be trusted — they were measured off your audio.*
- *Free: 2.00 GB of storage, 5 separations a month, 8 chat turns a day and 40 a
  month. Analysis and the loop finder spend none of this: only conversation, web
  lookups, separation and the bytes you store.* (generated)

### Empty crate

- **Heading**: *Nothing in the crate yet. Drop one record in.*
- *One is enough. It comes back with its tempo, its key, where bar 1 sits and
  where the sections change, each with the confidence it was measured with — and
  then the loops in it, ranked, and playable.*
- **Drop target**: *Drop a record here.* / while dragging: *Drop it.* /
  *wav, aif, aiff, flac, mp3, m4a, aac, ogg, opus. One is enough to start; a
  folder works too.*
- **1** *It is hashed here, in your browser.* — *Bytes only move if the hash is
  new, so a record you already have is caught before it uploads twice.*
- **2** *It gets measured, and you watch which measurement is running.* —
  *Tempo, then beats and downbeats, key, groove, loudness, spectrum, sections.
  Real work on your file rather than a spinner, and nothing is stated before it
  has been measured.*
- **3** *You correct whatever is wrong.* — *Halve or double the tempo, take the
  alternate key, put bar 1 where you hear it. Your correction wins over the
  measurement everywhere, permanently.*
- The long "not a generator" block (quoted in §5).
- The plan sentence and the unmetered note (§6), plus a disclosure labelled
  *Every cap, and what is left*.

### Library rail (`LibraryPane.tsx`)

- *Nothing in the crate yet. One record is enough to start; a folder works too.
  Each file is hashed here in the browser, checked against what you already
  have, uploaded, then measured.*

### Uploading

- *Hashing it here, before anything uploads — 43% of 41.2 MB.*
- *Checking it against what you already have.*
- *Uploading — 62% of 41.2 MB.*
- *Queueing the analysis.*
- *Waiting to start.*
- *Nothing is measured until the bytes are up. The analysis starts on its own
  the moment they are.*
- *3 more in the queue; they upload two at a time and are hashed one at a time.*
- On failure: the uploader's own error, with **Retry** and **Remove**.

### The wait

- *Queued. Compute scales to zero between jobs, so a machine may have to start
  before it can read the file.*
- *Queued, but compute not configured. It will run as soon as compute is
  reachable.* (when the job carries a dispatch note)
- *Measuring it now.*
- The eleven ladder rows in §4.
- *31 s so far. Analyses on this account have taken about 48 s (4 of them).* /
  *…No estimate yet: this is the first one on this account.*
- *The report is written in one pass at the end, so there are no half-measured
  numbers to show you. This is where the job actually is.*
- *Drop more records while this runs; they queue behind it. Nothing here needs
  your attention until it lands.*

### Failure

- *moonlight.wav did not analyze.*
- the job's own error, verbatim.
- *The file is still in your library and nothing about it was lost. A retry runs
  the same pass again; if it fails the same way, the file itself is the problem
  and another record is the faster test.*

### The payoff

- **Heading**: the file's title, then the headline: *92.0 BPM, likely F minor*
  (hedged by the same bands the chat uses).
- *Measured off your file, not looked up. The dot is the confidence each value
  was measured with; where it is low the wording says so rather than rounding it
  away.*
- The rows, generated from the report (`findings.ts`):
  - **Tempo** *92.0 BPM* — *46.0 half-time, 184.1 double-time; halve, double or
    tap it if the grid is on the wrong one*
  - **Key** *F minor* — *or Ab major, which correlated 0.88*
  - **Bar 1** *0:00.512* — *4/4, 64 bars; put the cursor on the real one and
    press D if this is off*
  - **Sections** *7* — *likely it repeats on 8 bars*
  - **Feel** *swung 58%* — *hits sit 11.7 ms off the grid on average*
  - **Bandwidth** *15.7 kHz* — *there is nothing above that in the file — a
    limit of the source, not of the processing* (or *full band, so nothing was
    thrown away before you got here*)
  - **Level** *-9.4 LUFS* — *true peak -0.3 dBTP*
- *Anything wrong here is yours to fix, and the fix is kept: halve or double the
  tempo, take the alternate key, put bar 1 where you hear it. Corrections beat
  measurements everywhere afterwards.*
- *Next: the finder ranks the sections worth flipping, with the edges on the
  beat grid, and every candidate is something you can play and drag. It costs
  nothing against the caps.* — buttons **Find the loops**, **Open the waveform**.
- *Ranking loop candidates on the beat grid — 40%.*
- *4 loops found. Best: 4 bars at 0:12.000, scored 0.82.* — buttons **Play
  them**, **Done with this**.
- When the finder returns nothing: *The finder came back with nothing on this
  one, which happens when there is no steady grid to cut on.* — button **Open it
  and cut one by hand**.
- *After that, the breakdown: how the record was put together, every number
  linked to the place in the waveform it came from. It wants the drums separated
  first, which spends one of the 5 separations a month, so it waits on the
  Breakdown tab until you ask for it.*
- **Hide** (tooltip: *Put this away; the library and the chat stay as they are*).

### Coming back

- **Where you left off** / **In the crate**
- *12 records, 48:31, 71.0–96.4 BPM, 7 keys* (generated)
- *3 records finished analyzing while you were away.*
- *1 is still in the queue.*
- *2 did not analyze; open them to see why, or retry them in the library.*
- *With this much in it the crate answers questions: the search box takes
  `f minor 88-94` or `like the open file`, and "what fits this" on an open
  record racks up everything that would sit under it.*
- **Open <name>**, **Hide**.

### Warnings (only at four fifths of a cap, or past it)

- *1 chat turn left. The day resets at midnight UTC, the month on the first.*
- *No chat turns left today on free. The count resets at midnight UTC; the
  analysis, the loops and the library still work.*
- *No chat turns left this month on free. The count resets on the first; the
  analysis, the loops and the library still work.*
- *0.10 GB of storage left of 2.00 GB.*
- *1 separation left this month.* / *No separations left this month on free; the
  count resets on the first.*
- *No web lookups left. Musical facts still come from the analysis, which does
  not need them.*

## 9. Decisions and interpretations

- **The first screen lives in the chat column, not in the panel.** `app/(app)/page.tsx`
  renders `EmptySurface` into `children`, and at `/` the shell renders no panel
  at all (`routeKind` is `null`, so nothing is pushed and `children` is never
  mounted). That component has therefore been unreachable at `/` since the
  adaptive layout landed — a finding worth knowing independently of this work.
  Rather than change that deliberate design, the strip mounts above `<ChatPane />`
  in the same column. **That is a two-line edit to `web/components/shell/Workspace.tsx`,
  the only file touched outside this pass's ownership** (an import and
  `<FirstRun />`). If a parallel branch has restructured that file, re-apply
  those two lines anywhere inside the chat column; `FirstRun` needs only the
  library context and renders `null` when it has nothing to say.
- **Onboarding state is per-device today.** `localStorage`, one key,
  `crateai:onboarding`, every access guarded so a private window degrades to "no
  memory" rather than a broken workspace. The migration adds the same five facts
  to `profiles`; it is **not applied** because writing them needs a PATCH on
  `/api/profile`, which this pass does not own. `readMemory`/`writeMemory` are
  the only two call sites, so the swap is mechanical.
- **The ladder is inferred, not reported.** Justified in §4, guarded by a test
  that reads the Python. The UI never states a value from it — only what the job
  is doing — so the worst case of drift is a stage name one step out.
- **No estimate is invented.** The only duration ever shown is the median of
  this account's own finished analyses, with the sample size. There is no
  hard-coded "about a minute" anywhere.
- **Acting does not dismiss.** Opening the file or running the finder keeps the
  strip, because the thread from "measured" to "hear a loop" is the point.
  Hiding is explicit, and a new session graduates it automatically.
- **The strip is capped at 60vh and scrolls inside**, so the composer is never
  pushed off the screen on a laptop.
- **The product name.** The copy here never says "CrateAI" or "Cratebox", so
  nothing in it has to change when the mechanical rename happens. The top bar and
  the login form still say CrateAI; that rename is outside this seam.
- **The loop finder, not the chat, is the second beat of the tutorial.** With 8
  chat turns a day on free, steering a first session into conversation would
  spend a quarter of the day's budget before the producer knows what the product
  does. The finder costs nothing and produces something audible.

## 10. What only a real first session can judge

Everything below was reasoned about and none of it was watched. There is no
browser, no sign-in and no Supabase in this environment; the logic and the state
machine are tested hard (73 new tests), the presentation is thin and rendered
only through `react-dom/server`.

- **Whether four minutes is actually four minutes.** Nobody has timed an
  analysis on real hardware through this app. If a 5-minute record takes three
  minutes, the ladder is a waiting room and the design needs a second thing to do
  during it. If it takes fifteen seconds, half of §4 is over-engineering.
- **Whether the ladder reads as progress or as noise.** Eleven rows may be too
  many; the alternative is four groups. This is the first thing to watch over a
  producer's shoulder.
- **Whether the findings table is the right seven rows**, and whether tempo and
  key first is right for a producer who flips records, or whether sections and
  the loop period matter more.
- **Whether "there is no generator in here" reads as honest or as defensive.**
  It is the single riskiest piece of copy here. The intended effect is relief and
  credibility; the failure mode is sounding like an apology for a missing feature.
- **Whether the empty screen is too long.** It is a heading, a drop target, three
  steps, the constraint and the plan. A producer who reads none of it still sees
  the drop target first, which was the design, but that is a guess about eye
  travel that a real session settles in five seconds.
- **Whether the first record ever fails.** The failure copy has never met a real
  error string from compute. If those strings are stack-shaped, the card will show
  something ugly at the worst possible moment.
- **Whether the loop finder is a good second beat for material a producer picks
  first.** Its own handoff notes it struggles when downbeat confidence is low. A
  producer whose first upload is an ambient record gets "nothing on this one" as
  their first result, which is honest and a bad first impression. Watch which
  record the first five people drop.
- **Whether the caps land as generous or as mean.** Saying "8 chat turns a day"
  out loud on the first screen is a deliberate risk: it is honest, and it might
  read as stingy before they know what a turn is worth.
- **Whether a second session ever happens**, which is the only measurement that
  matters and the one this pass cannot take. When the migration is applied,
  `profiles.created_at` → `onboarding_first_ready_at` is the number to watch:
  signup to first measured record, per invited producer.

## 11. What is not done

- **Per-stage partial results** (§4). The highest-value follow-up; it lives in
  `analysis/lockedgroove/jobs/analyze.py`.
- **The migration is not applied**, and nothing writes those columns. Needs a
  PATCH on `/api/profile`.
- **No first-run instrumentation.** Nothing records which step a producer left
  from. With the migration applied and one route, "dropped a record" versus
  "signed in and left" becomes answerable for the first handful of invites; today
  it is not.
- **The chat is untouched.** A producer who types "make me a beat" is handled by
  the system prompt, not by anything here. Worth checking that the refusal lands
  in the same voice as the sign-in copy.
- **Nothing plays inside the strip.** The payoff hands off to the Loops tab to
  press play. Once the audition rack is the default way to hear candidates, the
  "Play them" button should open a rack instead of a tab — one line, and a better
  ending to the four minutes.
- **The account page and the first-run strip describe the caps separately.**
  Both read `lib/billing/limits.ts`, so they cannot disagree about numbers, but
  they are two pieces of prose about the same thing.
