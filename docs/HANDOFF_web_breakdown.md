# HANDOFF_web_breakdown.md

Phase 4 on the web: the Breakdown tab, the Compare tab, the breakdown and
comparison routes, and the narration route under the grounding contract
(BUILD_PACKET sections 11 and 14). Built against `analysis/lockedgroove/breakdown/compose.py`
(`BreakdownContent`) and `compare.py` (`ComparisonContent`) and the `breakdown`
and `compare` jobs. Follows `docs/HANDOFF_web.md` (tokens, state, conventions).

## Files

```
web/
  app/api/breakdowns/[fileId]/route.ts           GET latest (?all=1 every version) + pending jobs + stems map; POST queue a breakdown
  app/api/breakdowns/[fileId]/narrate/route.ts   POST stream the narration (NDJSON), save the validated text
  app/api/compare/route.ts                       POST queue a compare; GET ?a=&b= the latest comparison for the pair
  lib/api/breakdown.ts (+ .test.ts)              client: get / run / narrate + readNarrationStream, missing-job helpers
  lib/api/compare.ts                             client: get / run, comparePairOf
  lib/anthropic/narrate.ts                       AnthropicNarrator (the SDK call), createAnthropicNarrator()
  lib/narration/jobs.ts                          Missing.job -> button label, offer, POST /api/jobs body (PHASE4_STAGES)
  lib/narration/prompt.ts (+ .test.ts)           system prompt, user message, the deterministic document
  lib/narration/validate.ts (+ .test.ts)         validateNarration(narration, content) -> { ok, problems }
  lib/narration/narrator.ts                      Narrator interface, DeterministicNarrator, scriptedNarrator (tests)
  lib/narration/run.ts (+ .test.ts)              runNarration: paragraph-level validation, fallback, notes
  lib/narration/stream.ts                        the NDJSON event shape shared by route and client
  lib/narration/fixtures.ts                      a BreakdownContent the way compose.py writes one (+ a faithful narration)
  components/breakdown/useBreakdown.ts           versions, live jobs, run, queue a missing job, re-request on completion
  components/breakdown/BreakdownDocument.tsx (+ .test.tsx)   the document: sections -> fact lines / missing lines
  components/breakdown/NarrationPanel.tsx        the mentor's text above the facts, notes, Copy, Narrate / Stop
  components/breakdown/WaveformSpan.tsx          the amber span over the waveform for a clicked fact
  components/breakdown/jobStatus.ts              queued / running 40% / failed text
  components/compare/useComparison.ts            reference pick, latest comparison, the compare job, refetch on done
  components/compare/ComparisonView.tsx (+ .test.tsx)        the comparison: sections, statement, mine / reference / delta
  components/compare/format.ts                   readouts by unit, missing-prerequisite wording
  components/surface/BreakdownTab.tsx            replaced the Phase 4 shell
  components/surface/CompareTab.tsx              replaced the Phase 4 shell
docs/HANDOFF_web_breakdown.md                    this file
```

No file outside that list was edited. `lib/types/db.ts` already had `BreakdownRow`,
`BreakdownContent`, `ComparisonRow`; `lib/api/client.ts` and `lib/api/types.ts`
were left alone (the request/response types for these routes live in
`lib/api/breakdown.ts` and `lib/api/compare.ts`; see "shared files" below).

## Commands run and results

| Command (from `web/`) | Result |
|---|---|
| `pnpm typecheck` | exit 0 |
| `pnpm lint` | exit 0, no warnings |
| `pnpm test` | 36 files, 322 tests passed; 44 of them are this seam's (prompt 10, validate 11, run 9, api/breakdown 4, BreakdownDocument 6, ComparisonView 4) |

Not run: `pnpm build` (the working tree is shared with agents building other
tabs; `.next/` is theirs as much as mine) and any signed-in session (no
Supabase, compute, or Anthropic key in the sandbox). The routes are typed
against the real clients and follow `app/api/loops/[id]/render/route.ts`;
the narration path is exercised end to end with a scripted narrator (no
test touches the network).

## How it works

**Routes.** `GET /api/breakdowns/[fileId]` returns `{ breakdown, breakdowns, jobs, stems }`:
the latest row (every version, newest first, with `?all=1`; the tab always
asks for all so the version switcher has them), the queued/running
`breakdown` / `stems` / `analyze` jobs on the file and on its stem files,
and the `stems` map (`stem -> stem_file_id`, latest separation wins) so a
missing entry's `analyze:drums` can be queued against the right file.
`POST` inserts a `jobs` row `kind: 'breakdown'` with `params: {}` or
`{ web_context }` (validated as JSON), dispatches it, 409 while one is
queued or running, 409 on a file whose analysis failed.
`POST /api/compare { file_a_id, file_b_id }` needs two different files the
caller owns with a report (`.not("report", "is", null)`), 409 while the same
pair is queued; the job row's `file_id` is `file_a_id` so the surface sees
it. `GET /api/compare?a=&b=` returns the latest row for the pair; with only
`a` it returns the latest comparison of that file against anything, which
the tab uses to restore the last reference.

**Narration** (`POST /api/breakdowns/[fileId]/narrate { version? }`) streams
newline-delimited JSON events (`lib/narration/stream.ts`): `paragraph`
(text that has already passed the validator), `note`, `reset`, `done`
(`{ text, source, removed, stop, saved, version }`), `error`. The chat
route streams plain text; this one needs to say what was removed and how it
ended, so the events are typed. `readNarrationStream` in `lib/api/breakdown.ts`
reads it.

`lib/narration/run.ts` drives a `Narrator` (`narrate(content) -> AsyncGenerator<string, stop>`):
deltas are buffered into paragraphs (blank-line separated, which the prompt
asks for); each finished paragraph goes through `validateNarration` and is
sent only when it passes. A failing paragraph is dropped and counted; the
note says "N lines were removed because they said something that wasn't
measured; the facts below are complete." When nothing survives, the model
stops with `refusal`, the call fails, or no key is set, the measured
document (`deterministicDocument`: the fact texts joined by section,
missing entries as "not measured" plus the offer to run the job, the recipe
numbered) is streamed after a `reset` with a note that says so. A
`max_tokens` stop keeps what was validated and notes the cut. Only
model-sourced validated text is saved to `breakdowns.narration`; the
measured document standing in is shown, not saved, so "Narrate" stays
available.

`lib/anthropic/narrate.ts` is exactly the shape asked for: `new Anthropic()`
(reads `ANTHROPIC_API_KEY`), `client.messages.stream({ model: "claude-opus-5",
max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: "medium" },
system: [{ type: "text", text, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content }] })`,
`stream.on("text", ...)`, `await stream.finalMessage()`, `stop_reason`
mapped to `end_turn | max_tokens | refusal | other`. No prefill, no
`budget_tokens`, no `temperature`. The system prompt is the stable, cached
block; the fact list is the user message. A request abort (the producer
pressed Stop, or navigated) calls `stream.abort()`.

**The validator** (`lib/narration/validate.ts`) checks, on a whole
narration or one paragraph:
- every number (integers and decimals; signs ignored; list markers like
  `1.` stripped) appears in some fact text or value (values are walked
  recursively, citation titles and the track title count);
- every `X major/minor` (any spelling; `Bb` = `A#` via `lib/music/keys.ts`)
  is a key the facts name (text or `{tonic, mode}` values); a plain
  "A minor"/"A major" counts as a key only after a word that introduces one
  ("in", "is", "key", ...), so "A minor caveat" passes;
- a run of chord symbols (`Fm – Bbm – Db`, `Fm7 to Bbm`) must be chords the
  facts carry, normalized (`Bbm` = `A#:min` = `Bb:min`); runs of bare letters
  (`A, B, A, B`) are section labels and are skipped;
- no section-11 instrument word (piano, rhodes, guitar, bass, vocal,
  strings, brass, synth, 808, plus horn, organ, flute, sax, wurlitzer, clav)
  unless the facts, the missing texts or the section titles use it;
- a number that appears only in facts whose text carries a hedge ("likely",
  "roughly", "I can't tell") is not stated in a sentence without a hedge
  marker. This is per sentence, so a hedged and an unhedged value in one
  sentence share the hedge; the prompt asks for the hedge in the same
  sentence as its value.

**The Breakdown tab.** Toolbar: Run breakdown (primary until one exists,
then Refresh), the composing job's status, the version switcher (`v1 v2 ...`,
a segmented control, latest by default), generated time and analysis
version. A quiet amber-ruled line "waiting on: stems running 40%, ..." while
the latest version's `requires` is non-empty, from the live jobs in
`LibraryProvider`. Then the narration panel (Narrate / Stop / Copy, status,
notes, the paragraphs), then the document: sections in the packet's order;
each fact is a line with the three-level amber dot (`ConfidenceDot`), the
hedge already in the text, the source and confidence on hover, and, when
the fact has a time, the text is a button that seeks the waveform
(`waveRef.current?.setTime`, `setCursor`) and, when it has an end, draws an
amber span over the waveform (`WaveformSpan` portals one non-interactive
div into the surface's `.waveform` element, positioned in percent of the
duration). The mono readout on the right is the clock (`0:20.870 – 1:02.600`)
or `bar 9`. World facts render their citation title as `[title]` linking to
the URL in a new tab with `rel="noopener noreferrer"`. Missing entries read
"not measured yet <text>" with one button naming the job ("Separate stems",
"Run chord analysis", "Run the breakdown stages", "Analyze the drums stem");
while that job runs the button gives way to its status, a failed one shows
the error and Retry. `identify_context` is not a job (Phase 5), so the
context line is text only.

Re-requesting: when a relevant job (breakdown / stems / analyze on the file,
analyze on a stem file, loop-finder tasks excluded) transitions to `done`,
the hook refetches; if that job was one the tab queued, or the latest
version is incomplete (`requires` non-empty or a missing entry with a job),
it POSTs a new breakdown after a 1.5 s debounce (several stem analyses
finishing together produce one version, not four). A 409 from that POST is
ignored (a breakdown is already composing). Each completion triggers at
most one re-request, so the chain is bounded: stems -> per-stem analyze ->
Phase 4 stages -> complete.

**The Compare tab.** A select of the library's ready files (originals
first, then by name, `title, kind, BPM, key`), excluding the open file.
Compare posts; the job's status shows while it runs; when it reaches done
the comparison is refetched. The view is a table per section (vitals,
structure, sample, drums, bass, harmony, mix): the statement with its dot
and hedge word, then `mine`, `the reference` and the delta in the mono
face with the unit (`92.0 | 88.0 | +4.0 bpm`; `52 | 58 | -6%`; kick steps as
`0 10`; booleans as yes/no). The source is the row's hover title (and
`data-source`). Missing prerequisites are listed in plain words ("needs
stems on both files for the bass/sample overlap"). The header names the two
files under `mine` and `the reference` (the content's `a_name` / `b_name`).

## Interpretation choices

- **Validate before showing, per paragraph.** The packet says the narration
  cannot introduce a fact not in the structure; the simplest robust way to
  honor that on a stream is to hold each paragraph until it passes, so no
  unmeasured line is ever on screen, even briefly. Whole-document fallback
  happens only when nothing survives, on refusal, on error, or without a
  key. Removed paragraphs are counted in the note; the facts underneath are
  always complete.
- **Refusals are reported, not routed around.** The claude-api skill
  recommends the server-side `fallbacks` parameter by default for
  `claude-opus-5`; it was not added, because the shape was specified
  exactly and because under the grounding contract the right answer to a
  refusal is the measured document, which the route already streams with a
  note (`stop: "refusal"` in `done`).
- **The saved narration is only model text that passed.** The measured
  document is never written to `breakdowns.narration`.
- **Missing-job requests carry `force: true`** on `analyze` runs because
  `jobs/analyze.py` skips a file that already has a report at the current
  `analysis_version`; with `stages` present compute merges the sections
  into the kept report, so the file's version is not bumped (unlike the
  Report tab's reanalyze route, which bumps it). Stems are queued with
  `model: "htdemucs_ft"` (the default in OPEN_QUESTIONS C.17).
- **`analyze:<stem>`** resolves through the stems map from the GET; when
  the stem file is gone the button is disabled with a title saying to
  separate stems again.
- **Versions** are read with `?all=1` (up to 50) so the switcher and the
  saved narration per version are local; pinning a version keeps it while
  new ones land, the latest is shown by default.
- **The compare job's `file_id` is file A** so the surface's job list and
  409 check see it; the pair is read from `params`.
- **Key spelling** in the validator normalizes both sides to sharps
  (`normalizeTonic`), so "Bb major" in a fact and "A# major" in the
  narration agree (OPEN_QUESTIONS C.13).
- **The waveform highlight** does not touch `Waveform.tsx`; it is a portal
  into the `.waveform` element with `pointer-events: none` and z-index
  below the wavesurfer cursor. Removing it later is one file.
- **Copy** uses `navigator.clipboard.writeText`; when blocked, the text is
  still selectable on screen.

## For shared files (not edited here)

- `docs/CONTRACTS.md` section 7: add `GET /api/compare?a=&b=` (the table
  has only POST), note that `POST /api/breakdowns/[fileId]` takes
  `{ web_context? }`, and that `/narrate` answers `application/x-ndjson`
  with the events in `lib/narration/stream.ts`.
- `web/.env.example`: `ANTHROPIC_API_KEY` is now used by the narrate route
  (the comment says Phase 8).
- `lib/api/client.ts` / `lib/api/types.ts`: the breakdown and compare
  request/response types and the `breakdownApi` / `compareApi` objects live
  in `lib/api/breakdown.ts` and `lib/api/compare.ts`; fold them into the
  `api` object and `types.ts` when the seam closes if one place is wanted.
- `lib/anthropic/models.ts` (chat seam): `NARRATION_MODEL` is a constant in
  `lib/anthropic/narrate.ts` for now; import it from `models.ts` once that
  lands (OPEN_QUESTIONS E.21 wants both models in one file).
- **Compute, `jobs/breakdown.py`:** the Phase 4 stages are queued with
  `queue_analyze(..., stages=PHASE4_STAGES)`, which sets
  `analysis_version: ANALYSIS_VERSION` and no `force`. On a file already
  analyzed at `ANALYSIS_VERSION` (the normal case), `analyze_task` skips it
  as already analyzed, so the sections stay null and the breakdown never
  completes on its own. Adding `extra_params={"force": True}` there fixes
  it; the web's own "Run the breakdown stages" button already sends
  `force: true`.
- Realtime: `breakdowns` and `comparisons` are not in the publication; both
  tabs refetch on job transitions instead (proposal below).

## Proposals (docs/PROPOSALS.md template)

## Breakdowns and comparisons in the Realtime publication
**What it does for a producer:** A new breakdown version or a comparison appears the moment compute writes it, including versions the chat asks for, without the tab watching job rows.
**Principle it serves:** 5, the library is the product.
**Principle it risks:** None; RLS applies to Realtime.
**What it takes:** `alter publication supabase_realtime add table public.breakdowns, public.comparisons` plus `replica identity full`; a subscription in `useBreakdown` / `useComparison` replacing the job-transition refetch.
**Where it belongs:** Phase 4 hardening.
**Status:** proposed.

## Audition a fact's span
**What it does for a producer:** Next to "Bars 9 to 24: verse" or "In verse: kick on the one and the and of three", a play button that loops just that span, so the line can be heard while it is read.
**Principle it serves:** 2 and 4; the breakdown links to the audio it came from.
**Principle it risks:** None.
**What it takes:** The surface already decodes the file and has `LoopPlayer.playRaw(buffer, start, end)`; expose `ensureDecoded` and a `playSpan(start, end)` on `SurfaceState`, and a small button on fact lines with `end_s`.
**Where it belongs:** Phase 4.
**Status:** proposed.

## Ask the mentor about this line
**What it does for a producer:** A "?" on any fact line opens the chat with that fact and its report source in context: "why do you say the drums are a break?" gets the timing-drift and hit-spectrum numbers, not a guess.
**Principle it serves:** 2, measure don't guess; the learning goal.
**Principle it risks:** None; the chat still answers only from the report.
**What it takes:** A `crateai:chat-prefill` event carrying `{ file_id, source, text }`, the chat composer listening for it, and `get_report` narrowed to a path (Phase 8 tools).
**Where it belongs:** Phase 8.
**Status:** proposed.

## Not exercised in the sandbox

The first signed-in run with a key should be watched for: the NDJSON stream
reaching the browser unbuffered through Vercel (the route sets
`cache-control: no-store`; if a proxy buffers, paragraphs arrive together
at the end, which is still correct); the update of `breakdowns.narration`
under the user client after the response has started (RLS update-own is
in the migration; the cookie store is read-only at that point, which
`lib/supabase/server.ts` already tolerates); and the `.waveform` portal
after the 9-minute URL refresh recreates wavesurfer (the outer element
persists, the span should too).
