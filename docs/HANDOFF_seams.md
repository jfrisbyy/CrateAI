# HANDOFF_seams.md

The pass that makes six parallel branches one product. Nothing new was
designed here. What was done: the nine unapplied migrations were verified as a
set against a real Postgres, the things that were built and unreachable were
connected, the first analysis was made to show numbers instead of step names,
and the documents were made to agree with the code again.

**Lead answer: the migrations apply cleanly, in order, on a database carrying
the five that are live — after four fixes, one of which was a blocker.** The
owner runs nine files, not seven: `20260913000500_compat.sql` was also never
applied, and `20260913001600_profiles_client_writes.sql` is new and repairs a
policy that has been broken since Phase 10.

---

## 1. The migrations

### What is actually live

The brief said seven unapplied migrations on top of five live ones. The five
live ones are right — `20260913000000_init` through `20260913000400_billing`.
The count of unapplied ones is **nine**:

- `20260913000500_compat.sql` was written after `STATUS.md` last said "all five
  migrations applied", and `HANDOFF_compat.md` says plainly that it was never
  applied. It is not one of the seven and it is the one whose absence breaks a
  route that ships today (`POST /api/compat` calls `compatible_files`).
- `20260913001600_profiles_client_writes.sql` is new, written here, and is
  required for two of the seven to be of any use (§1.3).

### How they were verified

A throwaway Postgres 16 cluster with `pgvector`, plus a small shim for the
parts of Supabase the migrations lean on (`auth.users`, `auth.uid()`,
`storage.buckets`/`objects`/`foldername`, the `anon`/`authenticated`/
`service_role` roles, the `supabase_realtime` publication). Nothing touched the
project's Supabase. The cluster was deleted afterwards.

Four things were checked, not one:

1. **They apply.** All fourteen files, in filename order, on an empty database.
2. **They are re-runnable.** Each of the nine re-applied on top of itself — an
   owner pasting files into the SQL editor should be able to start again from
   the top after a half-finished paste.
3. **The shapes the code actually writes go in.** A song with a lane and a
   region in the exact shape of `web/lib/session/types.ts`; a track with a
   `processing` chain and a session with a `master_processing` limiter in the
   shape of `web/lib/processing/persist.ts`; an `export` job; a `stems` row with
   all seven quality columns; a `loops` row with `components.sample_ready`; the
   producer's own switches on `profiles`. Then the queries each migration's
   header says it exists for ("what is in bar 17", the vocal-free loops, the
   trustworthy stems).
4. **The advisors' rules the project already fixed once.** RLS enabled with the
   four-policy loop on every table, `security invoker` and an explicit
   `search_path` on every function the project writes, every foreign key covered
   by an index, no duplicate or colliding index names, and cross-account reads
   actually returning nothing.

### 1.3 The blocker: `profiles_update_own` recursed

**Every authenticated UPDATE on `public.profiles` fails.** Found by writing a
row as a signed-in user, which is a thing no test had done because the web test
double implements the *intent* of the policy rather than its SQL.

```
ERROR:  infinite recursion detected in policy for relation "profiles"
```

The policy in the live billing migration reads the table it guards:

```sql
with check ((select auth.uid()) = id
            and plan = (select p.plan from public.profiles p
                         where p.id = (select auth.uid())))
```

Evaluating the policy needs a select on `profiles`, which needs the policy.
Postgres detects the loop and raises.

What it breaks:

| | |
|---|---|
| today | `PATCH /api/profile { corrections_opt_in }` 500s. The corrections opt-in shipped in Phase 10 and has never worked. |
| `…001200` | `profiles.loop_personalization` — the switch a producer uses to stop their own corrections tuning their loop ranking — could not be set. |
| `…001500` | all six `onboarding_*` columns are written by the account that owns them. None of them could be. |

**Fix**: `supabase/migrations/20260913001600_profiles_client_writes.sql`. The
policy becomes the same four-line shape every other table uses, and the half a
policy cannot express — comparing the old value with the new — moves into a
`before update` trigger that is handed OLD and NEW and never queries the table.

The trigger also closes a hole the original clause left open: it guarded `plan`
and nothing else, so a client could have written its own `stripe_customer_id` or
`stripe_subscription_id`. Both are `unique` and both are how the Stripe webhook
finds an account. The trigger guards `plan`, `plan_status` and both Stripe ids,
and only for the `anon` and `authenticated` roles, so the webhook and the SQL
editor are untouched.

Verified on the cluster: the producer can write `corrections_opt_in`,
`loop_personalization` and the onboarding columns; `plan = 'pro'` and a
hand-written Stripe id are refused by name; writing an unchanged `plan` value is
allowed (so a client echoing the field back does not break); a user updating
another user's row touches nothing; the service role still sets the plan.

`web/lib/testing/schema.ts` — the double's mirror of the schema — listed
`frozen: ["plan"]`. It now lists all four columns, so the double and Postgres
say the same thing.

### 1.4 The other three problems, and what was done

**Unindexed foreign keys, four of them new.** `20260913000100_advisor_fixes.sql`
covered every foreign key in the init schema; the migrations written since added
seven that were not covered. All seven fire on a delete, which is exactly when an
unindexed foreign key costs a full scan of the child table.

| Column | Fixed in |
|---|---|
| `song_tracks.user_id` | `…001000` (`song_tracks_user_idx`) |
| `song_regions.source_file_id` | `…001000` (`song_regions_source_file_idx`; the existing index leads with `user_id`, so it does not serve the constraint) |
| `profiles.onboarding_first_file_id`, `profiles.onboarding_last_file_id` | `…001500`, partial on `is not null` |
| `usage_events.job_id`, `takedowns.file_id`, `takedowns.user_id` | `…001600` — pre-existing, from the live billing migration, never covered because the advisor pass ran before it |

After the fixes the advisor query returns nothing.

**`…001400` would have silently done nothing.** It used `alter table if exists`
so that running it before `…001000` was "a no-op rather than a failure". That
trade is wrong for this column: a no-op means `web/lib/processing/persist.ts`
writes a chain to a column that is not there, the producer's EQ disappears on
reload, and nothing anywhere says why. It now raises `undefined_table` with a
hint naming the file to apply first. Verified: run against a database without
`song_tracks`, it stops with

```
ERROR:  song_tracks / song_sessions do not exist
HINT:  apply supabase/migrations/20260913001000_song_arrangement.sql first; …
```

**`…001000` could not be run twice.** Every table in it is `create table if not
exists`, which advertises a file you can re-run, and then its trigger and its
twelve RLS policies were unguarded — a second pass died on
`trigger "song_sessions_set_updated_at" already exists`. The trigger is now
dropped first (the guard `…000400` already uses) and each policy is dropped
before it is created, since Postgres has no `create policy if not exists`. The
resulting schema is identical.

### 1.5 What was checked and was fine

No two migrations alter the same table in a conflicting way; no column is added
twice; no index name collides; no `alter table` targets a table a later
migration creates. Specifically:

- `…001200` and `…001500` both add columns to `profiles`; both use `add column
  if not exists` and the column sets are disjoint.
- `…001300` is the only migration that touches `jobs_kind_check`. Its list
  matches `web/lib/types/db.ts` `JOB_KINDS` and `analysis/lockedgroove/db.py`
  `JOB_KINDS` exactly, and a bad kind is refused.
- `song_tracks.origin`'s check (`candidate|audition|file|render`) matches
  `TrackOrigin`; `song_sessions.snap` matches `SnapUnit`; both are the full
  union, so no insert the web can make violates them.
- The index on `report.spectral.bandwidth.value` casts to `numeric`. `Estimate.
  value` is `Optional[float]`, so the jsonb is always a number or null and the
  cast cannot fail — the same guarantee the live `files_report_bpm_idx` relies
  on.
- `…000620` sorts after `…000500`, which is the newest applied migration, so
  nothing is being inserted behind an already-applied version.
- Cross-account reads of `song_sessions`, `song_tracks` and `song_regions`
  return zero rows. **One thing left as it is:** foreign keys are not subject to
  RLS, so a user can create their own `song_regions` row pointing at another
  user's `file_id`. They get nothing readable by it, the takedown and lineage
  queries filter by `user_id`, and the same exposure already exists on `loops`,
  `chops` and `stems`. Changing it would mean a trigger on every child table;
  it is noted rather than fixed.

### 1.6 The ordered apply plan

Five are applied. Run these nine, in this order, with
`supabase db push` or by pasting each into the SQL editor:

| # | File | Works without it? |
|---|---|---|
| 1 | `20260913000500_compat.sql` | **No.** `POST /api/compat` and the "What fits this" rack call `compatible_files`, which does not exist. |
| 2 | `20260913000620_loops_sample_ready.sql` | Yes, more slowly. The sample-ready claims live in `loops.components`, which already exists; this is four indexes. |
| 3 | `20260913000800_stem_quality.sql` | **No.** The separation writes seven columns on `stems` that are not there, so the write fails. |
| 4 | `20260913001000_song_arrangement.sql` | Yes, until a reload. A song lives only in the browser and comes back as anonymous blocks of audio. |
| 5 | `20260913001200_loop_ranking_personalization.sql` | Yes, with the switch missing. Ranking still personalizes; nothing can turn it off. |
| 6 | `20260913001300_song_export.sql` | **No.** `POST /api/export/song` violates `jobs_kind_check` on `'export'`. |
| 7 | `20260913001400_track_processing.sql` | Yes, until a reload — and it refuses to run before (4). |
| 8 | `20260913001500_onboarding_state.sql` | Yes. The first run remembers in `localStorage`, per device. |
| 9 | `20260913001600_profiles_client_writes.sql` | **No.** Without it every client write to `profiles` fails, including the one that shipped in Phase 10, and (5) and (8) are dead columns. |

Then `node scripts/preflight.mjs`. It now probes columns as well as tables and
functions (§4), so a file skipped in this list shows up as a FAIL naming the
column rather than as a broken feature weeks later.

---

## 2. Things that were built and unreachable

### The export panel is mounted

`components/export/**` — the panel, the estimator, the hook, fourteen route
tests — existed with nothing rendering it. It is now mounted in
`web/components/shell/Workspace.tsx`, on the song surface, as a collapsed
drawer under the timeline: one line closed, the full panel open, with the lane
count in the header.

It is on the song rather than in the surface stack because an export is
something you do *to* the song you are looking at, not another object to page
back and forward through — and because that keeps the change to the one file
this seam owns, rather than to `surfaceStack.ts` and `TransportBar.tsx` as well.
`arrangement` comes from `session.arrangement` (the audition lane is already
held out of it), `keyOf` and `nameOf` from the library, and the options object
is memoized so the request is not rebuilt on every render.

**One decision recorded:** the zip is "Untitled song". Nothing in the session
model carries a name, and naming a multi-record arrangement after one of its
records would be worse than saying nothing. When a song gets a name — it will,
when `song_sessions.name` is written — pass it as `name`.

### The keyboard's one hunk landed correctly

`web/components/surface/ChopsTab.tsx` carries the merge exactly as
`HANDOFF_keyboard.md` §11 describes it: `<KeyboardPanel />` in the left column
in place of `<PadGrid />` + `<RecordPanel />`, `useKit()`, and both `baseBindings`
(file order) and `bindings` (the kit's order) computed and passed. The chop
controls, the chop list and the MIDI panel are untouched. Nothing to finish.

### The shell's pad toast was lying

`Workspace.tsx` showed "pads fill with chops in Phase 3" on every pad key, which
stopped being true when the instrument landed. It now says where the pads live —
and only when the panel is *not* showing a record, which is the case where the
key definitely made no sound and the producer needs telling. While a record is
open the pads may well be playing and a toast over every hit would be noise.

### What else was looked for, and what was found

Every `.tsx` in `components/` and `app/` was checked for a non-test importer,
and every route in `docs/CONTRACTS.md` for a caller.

- **Every API route has a caller** except `/api/health`, which is for uptime
  checks and the preflight. Correct as it is.
- **`components/surface/ShellTab.tsx`** has no importer at all. It is a
  seven-line placeholder from the early shell, not a feature — dead code, worth
  deleting by whoever next owns that directory.
- **`components/surface/EmptySurface.tsx` is unreachable at `/`**, as
  `HANDOFF_firstrun.md` §9 found: the shell renders no panel on the index route,
  so `children` never mounts. That is the deliberate design (the first screen is
  a chat) and `FirstRun` now occupies that space. Left alone.

### Two capabilities still behind a flag nobody sets — deliberately not built

Both are real, both are named here with their file lists, and neither is the
one-tag change the export panel was.

**`profiles.loop_personalization` cannot be set.** `PATCH /api/profile` accepts
`corrections_opt_in` and nothing else. Making the switch real is five files
(`app/api/profile/route.ts`, `lib/types/db.ts` `ProfileRow`/`ProfileInsert`,
`components/account/AccountPanel.tsx` beside the existing toggle,
`lib/billing/usage.ts`'s fallback profile, `lib/testing/rows.ts`+`schema.ts`).
The reason to leave it: `20260913001200`'s own header says to apply it "when the
web side that writes `loop_edges` / `loop_bars` / `loop_pick` lands", and that
write path does not exist yet. A switch that turns off a personalization with no
corrections to learn from is decoration. **The blocking work is the corrections
write path**, not the toggle.

**The `onboarding_*` columns cannot be set.** Same route, same schema. The
firstrun handoff calls the swap "mechanical" — `readMemory`/`writeMemory` are
the only two call sites — but it is not, quite: a producer who starts on a
laptop and signs in on a studio desktop has two sets of state and something has
to decide which wins. That is a product decision, not a seam fix. `…001600` at
least makes the columns writable, which was the hard blocker.

**The stem picker names models instead of asking for the best available.**
`HANDOFF_audio_quality.md`'s first follow-up: `web/lib/api/stems.ts` hard-codes
three model ids and defaults to one by name, so the backend's quality-ordered
resolution never runs for a request from the tab, and the tier, published SDR
and quality note that now come back on every `stems` row are never shown. The
files are `web/lib/api/stems.ts`, `web/components/stems/**` and
`web/lib/chat/tools.ts` — three seams, one of them off limits here. Highest-value
item left on this list, because it is the irreversible step in the whole chain.

---

## 3. The first analysis shows numbers

`analyze_task` wrote `files.report` once, at the end, so at twenty seconds the
first-run screen could only show a step name lighting up. It now writes the
report after **every stage**. Realtime already pushes `files` row changes and
`firstFindings()` already renders whatever a report has and skips what it does
not, so the producer sees a measured tempo at about twenty seconds, the key
behind it, and the sections after that.

### How a partial report announces itself

One field, and one rule:

```
report.pending = { stages: [...], done: [...], fraction: 0.5 }   still being written
report.pending = null                                            finished
```

`done` and `stages` are the report's own field names, so a reader can say
*which* measurement is still coming, not just that one is. A stage that ran and
failed counts as done — its field is `null`, which on a finished report already
means "it ran and produced nothing", and a consumer must never be left waiting
for a measurement that is not coming.

Why absence means finished rather than a `complete: true` flag: it keeps every
reader written before this field existed correct about a finished report, which
is every reader in the repo. And it is not the only signal — **a partial is only
ever stored while `files.status = 'analyzing'`**, because the partial patch
writes `report` and nothing else: no `analysis_version`, no `status`, no vitals.
A reader that has never heard of `pending` still has the row.

`effective()` carries `pending` through untouched on both sides —
`lockedgroove.report.effective` and `web/lib/report/effective.ts` — so
`isPartial(effective(r)) === isPartial(r)`. A correction still resolves over a
partial (the correction wins whenever the measurement lands), it just cannot
make the report look finished. `report.is_partial` and `effective.ts`'s
`isPartial` are the same one-line test, and `isPartial` takes the raw jsonb off
a row as well as a model, because half the callers have one and half the other.

### Two traps this could have fallen into, and did not

**Erasing a correction.** `report.user_edits` is copied from the prior report
*after* `analyze_array` returns, so the live object carries the default until
then. A partial written without them would, if the job then died, leave the file
with the producer's corrections gone — principle 7, broken by a progress
feature. Every partial carries the prior edits. There is a test.

**Becoming permanently unanalyzable.** `analysis_version` is only written in the
finishing patch, so a half-written report always sits under the *previous*
version. Without a guard, a file re-analyzed at the same version and interrupted
would be skipped as "already analyzed at version N" forever. The idempotency
check now treats a partial report as no report. There is a test.

### What changed, and where

| File | Change |
|---|---|
| `analysis/lockedgroove/report.py` | `Pending` model, `AnalysisReport.pending`, `is_partial()`, and `effective()`'s docstring saying it carries `pending` through |
| `analysis/lockedgroove/pipeline.py` | maintains `report.pending` while the stages run and clears it before returning; new `on_partial` callback, best effort like `on_progress` |
| `analysis/lockedgroove/jobs/analyze.py` | **two hunks only** — see below |
| `scripts/gen_report_types.py` | `pending` excluded from `REPORT_SECTIONS`; it is bookkeeping, not a measurement, and `notAnalyzed()` would otherwise list it as a section the record has no reading for |
| `docs/analysis_report.schema.json`, `web/lib/types/report.ts` | regenerated |
| `web/lib/report/effective.ts` | `isPartial`, `pendingStages`, `pending: null` in `emptyReport` |
| `web/components/onboarding/FirstRun.tsx` | the analyzing view renders the findings that have landed, above the ladder |
| `web/components/onboarding/StageLadder.tsx` | a `partial` flag picks between two true sentences; the old one is still there and still tested, because it is still true of a pipeline that writes once at the end |
| `analysis/tests/test_partial_report.py` | new, 14 tests, the whole contract at every layer |

**`analysis/lockedgroove/jobs/analyze.py`, for the merge.** Another agent is
working the loop path in this file. Two hunks were touched and both are in
`analyze_task`, which is not the loop path:

1. the idempotency line, `and not is_partial(file.get("report"))`, plus the
   import of `is_partial`;
2. a new `on_partial` function beside the existing `on_progress`, and
   `on_partial=on_partial` in the `analyze_array` call.

`find_loops_task`, `personalize_ranking`, `loop_stems`, `_loop_row` and
`_claim_counts` were not opened. The module docstring gained two paragraphs.

---

## 4. The consistency pass

**`docs/CONTRACTS.md`.** Every route in section 7 exists and every route that
exists is in section 7 — verified against the filesystem, no drift. What was
added: `LOG_LEVEL` to section 1; the partial-report contract to section 5, with
the `analyze` row corrected (it was missing `force` and still said the report is
written once); `on_partial` to section 8; and a **new section 12** saying which
migrations are applied, what each unapplied one is for, what stops working
without it, and the shape of every table and column they add. The migrations
were the one thing crossing every seam boundary that this document did not
describe.

**`docs/STATUS.md`.** Said "all five migrations applied" (true, and now
misleading — there are fourteen files), 411 Python tests, 44 web files and 376
web tests, and named a branch that no longer exists. Now: the real numbers, the
real migration state with a pointer to the plan, a header that says the phase
reports cover Phases 0–10 and the handoffs cover what came after, and "apply the
nine waiting migrations" as owner to-do 1.

**`docs/RUNBOOK.md`.** Section 1 said "Both migrations in
`supabase/migrations/` are applied" — two revisions of reality out of date. It
now carries the ordered apply plan, the two ordering constraints that matter,
and the note that each file is re-runnable. The preflight table in section 7
gained the column check and the `.env.example` check.

**`web/.env.example`.** `LOG_LEVEL` was read by `web/lib/log.ts` and documented
nowhere. Added, commented out, with its default. It is the only variable that
was missing; the other thirteen all match.

**`scripts/preflight.mjs`.** Two additions, both read-only and both
self-maintaining:

- **Columns.** It read `create table` and `create function` out of the SQL and
  probed for them. Four of the nine unapplied migrations add *columns* to tables
  that already exist, so a database missing one of them answered every check
  while the feature failed for a real user. It now parses `alter table … add
  column` too — sixteen columns across `stems`, `profiles`, `song_tracks` and
  `song_sessions` — and probes each with `select=<column>`, which PostgREST
  answers by naming the missing column. A skipped migration is now a FAIL that
  says which one.
- **`.env.example` against the code.** Every `process.env.X` the web app reads
  must be documented in `web/.env.example` (platform variables excluded). A WARN,
  because an undocumented variable does not break a first session — it breaks the
  next deploy.

**`web/lib/testing/schema.ts`.** It mirrors the migrations for the route tests,
so it moved with them: `profiles.frozen` now lists all four columns a client may
not change, matching the new trigger.

---

## 5. One thing fixed that nobody asked for

The web suite arrived at this seam **1746 passing, three failing**, against a
stated baseline of 1749. Nothing had changed: `lib/testing/schema.ts` defined
the double's `now()` as the literal `2026-09-13T12:00:00.000Z`, and the date
rolled over to the 14th. Three tests seed a row "today" and compare it against
the real clock — `chat_turns_today`, the free plan's searches-per-day cap — so
they passed on the day they were written and failed on the next one. Confirmed
pre-existing by stashing every change in this branch and running them again.

`NOW` is now midday *today*. Nothing asserts the literal (the tests that pin a
date bring their own), no test was weakened, and the suite is back to green.

**A second bomb in the same place, not defused:** `app/api/usage/route.test.ts`
anchors its "earlier this month" event at the literal `2026-09-01`, so it breaks
on 1 October. The fix is one line — derive it from the start of the current
month — in a file this pass did not own.

---

## 6. Green

| | |
|---|---|
| `analysis`: `uv run pytest -q` | 765 tests, 763 passed, 2 skipped (optional `modal`, `basic_pitch`) — was 749 passed; +14 new |
| `analysis`: `uv run ruff check .` | clean |
| `web`: `pnpm typecheck`, `pnpm lint` | clean |
| `web`: `pnpm test` | 167 files, 1754 passed — was 1749; +5 new, 3 recovered from the date bomb |
| `web`: `pnpm build` | clean |
| `scripts/gen_report_types.py --check` | schema and TypeScript types in sync |
| all fourteen migrations, in order, local Postgres 16 + pgvector | apply cleanly, re-runnable, advisors clean |

Not committed, not pushed, no PR. Everything is in the worktree.

## 7. Files touched outside this seam's stated ownership

Each was a consequence of something the brief asked for, and each is one hunk or
one additive export.

| File | Why |
|---|---|
| `analysis/lockedgroove/report.py` | `pending` has to live on the report for `effective()` to carry it |
| `scripts/gen_report_types.py` | `pending` must not become a `REPORT_SECTIONS` entry |
| `web/lib/report/effective.ts` | the brief: "make the pipeline's own `effective()` and the web's readers agree". Two new exports; `effective()` itself is unchanged (it deep-copies, so `pending` already survived) |
| `web/components/onboarding/{FirstRun,StageLadder}.tsx` | the partial report has to be rendered somewhere, and the ladder's old sentence became false in the partial case |
| `web/lib/testing/schema.ts` | it mirrors the migrations, and the profiles policy changed; plus the fixture clock in §5 |
| `web/components/onboarding/onboarding.test.tsx`, `web/lib/report/effective.test.ts` | one new test each, both additive; no existing assertion changed |
