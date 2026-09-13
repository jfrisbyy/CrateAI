# HANDOFF: compatibility — "what in my crate works with this?"

Owner of this seam: the compat agent. The question a producer asks over and over
with a beat open: *what else that I already own fits with this, and what would it
take*. The library could already answer "sounds like this" (CLAP, section 12);
this answers a different and more useful question, and the answer is arithmetic
over two things that were already measured.

Nothing outside the files below was touched. Nothing was committed, pushed, or
applied to any project database.

## Files

| Path | What |
|---|---|
| `analysis/lockedgroove/analysis/compat.py` | the theory. Pure functions, no I/O: `fold_tempo`, `stretch_distance`, `compare_tempo`, `pitch_class`, `direct_relationship`, `key_relationship`, `compare_key`, `is_tonal`, `compatibility`, `describe`, `vitals_from_report` |
| `analysis/tests/test_compat.py` | 36 tests, written against the theory before anything was wired to it (principle 8) |
| `supabase/migrations/20260913000500_compat.sql` | `compatible_files` plus the key-theory helpers and one index. **Written, not applied.** |
| `web/lib/compat/theory.ts` | faithful TypeScript port of `compat.py` |
| `web/lib/compat/parity.json` | 24 generated cases; both suites assert against it |
| `web/lib/compat/matches.ts` | vitals off a `FileRow`, CLAP cosine, ranking, `buildMatches` |
| `web/lib/compat/client.ts` | request and response types, browser client |
| `web/lib/compat/theory.test.ts`, `matches.test.ts` | 69 tests |
| `web/app/api/compat/route.ts` | `POST /api/compat` |
| `web/components/compat/CompatTab.tsx`, `CompatRow.tsx`, `useCompat.ts` | the Fits with panel |

Minimal edits to register what was added: `web/components/surface/SurfaceTabs.tsx`
(one import, one tab id, one label, one line in the panel switch),
`web/lib/types/db.ts` (`CompatibleFilesArgs`, `CompatibleFileRow`, the RPC in
`Database.Functions`), `docs/CONTRACTS.md` (section 7 and a new section 11),
`docs/PROPOSALS.md` (four proposals appended).

## Commands and results

```
cd analysis && uv run pytest -q         432 passed, 1 skipped
cd analysis && uv run ruff check .      All checks passed
cd web && pnpm typecheck                clean
cd web && pnpm lint                     clean
cd web && pnpm test                     47 files, 513 tests passed
cd web && pnpm build                    compiled; /api/compat listed
```

---

## The music theory, and why

### Tempo: fold first, then measure the stretch

Two files share a grid when one can be stretched onto the other without the
stretch being heard. 170 and 85 BPM already share a grid — the same pulse counted
twice as fast — so the comparison is octave-folded *before* any stretch is
measured: the candidate's tempo is multiplied by the power of two that brings it
nearest the source, and what is left over is the stretch.

That ordering matters. Comparing 170 against 85 without folding gives a ratio of
2.0 and the answer "no". Folding first gives factor 2, ratio 1.0, and the honest
answer: *nothing needs stretching at all, you just count it double-time*. The
fold is reported separately (`fold`: `"half"` / `"double"` / `"none"`) because it
is a musical decision the producer makes, not a hidden transform.

The stretch ratio is `source / folded candidate` — the number the candidate's
playback rate is multiplied by, the same direction and meaning as
`combine/align.py`'s `stretch_ratio`, so a row in this panel and the lane the
layer render builds from it talk about the same number.

### The bands are symmetric in ratio space, not in percent

The brief gives 0.94–1.06 as transparent and about 0.88–1.14 as usable. Those are
not symmetric ranges around 1 in percent, and they are not meant to be: 1/0.94 =
1.064 and 1/0.88 = 1.136. They are reciprocal pairs. Speeding a file up by 6 % and
slowing it down to 94 % are the same amount of stretching, done in opposite
directions, and a stretch engine treats them the same way.

So the measure is `stretch_distance(r) = max(r, 1/r) - 1`, and one threshold
covers both directions:

| Constant | Value | What it rests on |
|---|---|---|
| `TRANSPARENT_MAX` | 0.06 | the brief's 0.94–1.06; inside this a stretch is not audible on the material this platform is for |
| `USABLE_MAX` | 0.14 | the brief's 0.88–1.14 read as reciprocals (1/0.88 = 1.136 ≈ 1.14); past this transients smear enough to hear |
| `MAX_OCTAVES` | 1 | half-time and double-time are the moves producers make; quarter-time is a claim nobody asked for. A parameter, so a caller can allow 2 |
| `OCTAVE_PENALTY` | 0.03 per fold | a *ranking* tiebreak only, so that at equal everything a literal tempo agreement sorts above a half-time one. It does not change whether a pair is compatible |

`tempo_score` falls linearly from 1.0 at an exact match to 0.5 at the edge of
usable (`1 - distance / (2 · USABLE_MAX)`). One formula, easy to explain, and the
half-way point lands exactly on the band edge.

### Key: five relationships, and never pitch what already works

In the brief's order of strength, with the score each carries:

| Relationship | Score | What it is |
|---|---|---|
| `same` | 1.00 | identical tonic and mode |
| `relative` | 0.90 | relative major/minor — the same seven notes |
| `dominant` | 0.80 | the candidate a perfect fifth above, **same mode** |
| `subdominant` | 0.80 | a perfect fifth below, same mode |
| `parallel` | 0.70 | same tonic, other mode |

Two decisions worth stating:

**The fifths require the same mode.** G major over C minor is a B natural against
a B flat. It is not a dominant pairing, it is a clash, and calling it one would
be the kind of plausible-sounding wrongness principle 2 exists to prevent. It
falls through to the shift search instead, which finds G *minor* one semitone
down or reaches it another way.

**Shift 0 is always tried first.** The search walks outward — 0, then ±1, ±2 —
and returns the first size that lands on any of the five, taking the stronger
relationship when both directions land and the upward shift on a tie (the
convention `align.semitone_shift` already uses). The consequence is that a pair
that already works is never pitched: C major under C minor is reported as
`parallel` at shift 0, not as "same key, two semitones down". Chasing the higher
relationship score by pitching material that needs no pitching would be worse
advice, not better.

`SHIFT_PENALTY` is 0.12 per semitone off the relationship's score. It ranks; it
does not gate. `CHARACTER_SHIFT` is 2, from the brief: past two semitones the
material's character changes, so `KeyMatch.shifts_character` goes true and the
row says so. The UI's default `max_semitones` is 2 for the same reason, with
"Any" one click away.

Worth writing down, because it surprised me and it is asserted in both suites:
**no key is more than four semitones from a relationship.** The five
relationships cover the circle densely enough that `MAX_SHIFT` = 6 is never the
binding constraint — the far corner is a cross-mode pair like F minor under C
major, at +4 to the relative minor. The default of 2 is therefore a real
restriction and the right one to expose.

### "No key" is two different things

A file with no key is compatible with everything, and the brief is right that
this is the common case rather than an edge case. But the key stage always
*returns* something: Krumhansl-Schmuckler on a chroma always has a best profile,
so a drum break reads as a key at about 0.37 confidence (HANDOFF_dsp choice 11
measures exactly this). Taking that at face value would have the panel announcing
"relative minor" about a snare's spectrum.

So the material is asked whether it is tonal at all, using the rule the codebase
already has and the layer render already obeys — `align.py`'s
`AlignItem.is_tonal`: `NON_TONAL_TAGS` (`drums`, `drum`, `break`, `percussion`,
`hats`, `kick`, `snare`, `beatbox`), or a stem whose filename says drums. Non-tonal
material has no key here, whatever the chroma said, in all three
implementations (`compat.is_tonal`, `theory.ts` `isTonal`, `file_is_tonal` in the
migration). Keep the tag list in step across the four places it now lives.

What is deliberately *not* done: a confidence floor. A tonal file whose key reads
0.42 keeps its key and its 0.42. The brief's own example is a key measured at
0.42 that still produces a hedged claim, and discarding a real measurement
because it is uncertain is not the same as being honest about it.

### Confidence: the weakest link, and it says which link

A compatibility claim is a claim about two files' measurements, so it is capped
by the weakest measurement it actually uses — the minimum, not a product. Two
solid numbers do not make a claim *less* true than one.

Only the axes the claim uses can bind it. A keyless drum break's absent key does
not drag down a tempo claim, because the tempo claim never touched it. A key
measured at 0.42 caps every harmonic claim built on it at 0.42.
`confidence_bound_by` names the input (`source_key`, `candidate_tempo`, …) and
`confidence_reason` says it in words the panel prints: *"this file's key was
measured at 0.42, and no claim built on it can be surer than that."*

A value that is present but carries no recorded confidence is treated as 0, not
as 1. That is principle 2 read strictly, and it is asserted.

### The combined score

`0.5 · tempo + 0.5 · key` when both axes were measured; the tempo score alone
when either side has no key (and the `method` string says "no key on one side, so
tempo alone"); the key score alone when either side has no tempo. The weights are
a judgement call and are the softest number here — tempo is the harder constraint
to fix, key is the more obvious when wrong — so they are two named constants,
`TEMPO_WEIGHT` and `KEY_WEIGHT`, and moving them moves nothing else.

The score only ranks. `compatible` decides, and it is about the bands.

## The SQL

`supabase/migrations/20260913000500_compat.sql`. **Written and never applied to
any project database.** It follows `library_filter` and `similar_files` in
`20260913000200_search.sql` exactly: `security invoker` so RLS decides what the
caller can see, `set search_path = public, extensions`, effective values (a
`user_edits` correction wins over the prediction), and `limit least(coalesce(...),
100)`.

```sql
compatible_files(
  p_file_id            uuid,
  p_limit              integer          default 20,
  p_stretch_tolerance  double precision default 0.14,   -- max(r, 1/r) - 1
  p_max_semitones      integer          default 2,
  p_kind               text             default null,
  p_max_octaves        integer          default 1,
  p_include_keyless    boolean          default true
) returns table (
  file_id           uuid,
  octave_factor     double precision,   -- 0.5 half-time, 1 as written, 2 double-time
  folded_bpm        double precision,
  stretch_ratio     double precision,
  stretch_distance  double precision,
  key_relation      text,               -- same | relative | dominant | subdominant | parallel | null
  semitone_shift    integer
)
```

It is a **coarse filter**: the caller's own ready rows, inside the octave-folded
tempo window, in a key family reachable within `p_max_semitones`. It returns the
values it computed so they can be inspected, but the numbers the user sees are
recomputed by the route from the reports, so there is exactly one implementation
behind anything anyone reads.

Supporting functions, all `immutable` and mirroring `compat.py` one to one:
`pitch_class_index`, `key_direct_relation`, `key_relation_strength`,
`key_match_shift` (the outward walk), `key_match_relation`, `file_is_tonal`.

Two things in there worth knowing:

- **An index**, `files_effective_bpm_idx`, on `(user_id, coalesce(user_edits
  tempo, tempo))`. The candidate CTE opens with a single sargable window — the
  widest any fold could reach, `[src / (2^oct · (1+tol)), src · 2^oct · (1+tol)]`
  — so the tempo filter is a range scan on that expression and the exact distance
  is checked on what survives. `library_filter` and `search_embeddings` filter on
  the same expression and will benefit from the index too.
- **Rows with no measured tempo are kept**, since nothing was measured and so
  nothing rules them out, and they sort after the rows that could be measured
  (`coalesce(distance, 1.0)`). If `p_limit` truncates, they are what is lost.

## The API

`POST /api/compat`

```jsonc
{ "file_id": "uuid",
  "limit": 20,                 // <= 100
  "stretch_tolerance": 0.14,   // 0.06 transparent, 0.14 usable
  "max_semitones": 2,          // 0..6
  "max_octaves": 1,            // 0..2
  "kind": null,                // a FileKind to search only chops, only stems, ...
  "include_keyless": true }
```

```jsonc
{ "source": { "file_id", "name", "bpm", "bpm_confidence", "tonic", "mode", "key_confidence" },
  "matches": [{
    "file": { /* the whole FileRow, as /api/search returns */ },
    "score": 0.91, "confidence": 0.42,
    "confidence_bound_by": "source_key",
    "confidence_reason": "this file's key was measured at 0.42, and no claim built on it can be surer than that",
    "method": "octave-folded tempo ratio, ...; key relationship ...",
    "compatible": true,
    "reason": "relative minor, 2% faster",
    "tempo": { "source_bpm", "candidate_bpm", "folded_bpm", "octave_factor", "fold",
               "ratio", "percent", "distance", "quality", "compatible", "score",
               "confidence", "method", "note" },
    "key":   { "source_tonic", "source_mode", "candidate_tonic", "candidate_mode",
               "relationship", "semitone_shift", "shifts_character", "compatible",
               "score", "confidence", "method", "note" },
    "timbre": 0.83          // CLAP cosine, or null when either file has no embedding
  }],
  "considered": 17,
  "note": null,
  "method": "..." }
```

The route does the coarse filter in the database, scores what comes back with
`lib/compat/theory.ts`, and ranks. Every branch that returns nothing returns a
`note` saying why in a producer's terms — not analyzed yet, nothing measured on
this file, nothing in range, no embeddings so no tie-break — rather than an empty
list with no explanation.

**Timbre as the secondary sort.** Scores land on a handful of values (five
relationships times a short list of stretches), so ties are the normal case, not
the exception — which is exactly where "and which of these two sounds more like
my record" is the question worth answering. Candidates and source are looked up
in `embeddings`, vectors from the same model are cosined, and inside a score
bucket of 0.01 the closer timbre wins. Files without an embedding get `null`, not
a zero, and an error reading `embeddings` costs the tie-break, not the answer.

After timbre, ties break on **how much was measured**: a keyless break at the
same tempo scores 1.0, exactly like an exact key match, because on everything
that could be checked it is as good — but the pair checked on both axes goes
first. An absence of a measurement is not evidence.

## The UI

A "Fits with" tab on the surface, next to Layers (`SurfaceTabs.tsx`). The tab
component lives in `components/compat/` rather than `components/surface/` to keep
this seam's files in one place; `SurfaceTabs` gained one import line.

- **Two dials, both the producer's to turn** (principle 4): *Stretch* —
  Transparent / Usable — and *Pitch shift* — None / Up to 2 / Any — plus a
  checkbox for keyless material. Defaults: usable, up to 2, keyless included.
- **A header line** stating what is being matched against: the open file's BPM
  and key with their confidence dots, so a bad match traces back to a bad
  measurement rather than to a mysterious algorithm.
- **Each row says why in plain words**: "relative minor, 2% faster", "same key,
  needs half-time", "no key detected, tempo only", followed by the hedge word and
  the sentence naming which measurement capped the confidence. Under it: the
  candidate's tempo (`85 → 170` when a fold is involved), its key, the exact
  ratio, the semitone shift with "changes character" when it is past two, and the
  timbre percentage when there is one. Every one of those has the full `note` on
  hover.
- **One click to a layer lane**: "Layer this" posts `{ file_ids: [open, match] }`
  to `/api/layers` — which already takes exactly that — and switches to the
  Layers tab, where the lane editor and the render are waiting. The alignment
  plan the compute builds uses the same `stretch_ratio` direction this panel
  showed.
- **Every value is correctable**: the BPM and key cells are buttons that open
  that file's Report tab, where tempo can be halved, doubled or tapped and the
  key set by hand. A correction there changes what this panel says next time,
  because both the SQL and the scoring read effective values.
- Design tokens, row grid, confidence dot, play button and `openFile` are the
  existing ones; nothing new was invented.

## What was verified, and how

- **Python ↔ TypeScript**: `web/lib/compat/parity.json` holds 24 generated cases
  (every relationship, both folds, both missing values, the confidence bounds,
  each option). `test_compat.py::test_the_parity_table_still_describes_this_module`
  and `theory.test.ts` both assert against it, so neither side can drift. Two real
  divergences were caught this way and fixed: JavaScript's `String.replace`
  replaces one occurrence where Python's replaces all, and `Math.round(n * 1e6)`
  disagrees with Python's `round(x, 6)` on values near a half (it is
  `Number(n.toFixed(6))` now).
- **SQL ↔ Python**: a throwaway local Postgres 16 cluster in the scratchpad —
  never a project or live database, initialised and deleted inside this session —
  with a stub `files`/`tags`/`auth.uid()` schema. The migration loads clean, and:
  `key_match_relation` / `key_match_shift` agree with `key_relationship` on **all
  576 key pairs**, and the octave fold agrees on **342 tempo pairs**.
  `compatible_files` was exercised for the tempo window, the key family, user
  edits winning over predictions, `status <> 'ready'` and another user's rows
  being excluded, each parameter, the non-tonal rule from both sides, an unknown
  file id, and the limit cap.

## What could not be verified here

- **The migration has not been applied anywhere it matters**, by instruction. It
  parses and runs, but not against the real schema: real RLS policies, the real
  `tags` table, `pgvector`, and the advisor's linter have not seen it. Before
  applying: check `files_effective_bpm_idx` is worth its write cost on a real
  library, and run the Supabase advisors, which have opinions about function
  search paths (all set) and about `plpgsql` functions in a `where` clause
  (`key_match_shift` is `immutable` and at most thirteen iterations, but it has
  not been EXPLAINed against a real table).
- **No route, panel or RPC ran against a live session.** There is no Supabase in
  this worktree, so `POST /api/compat` has never returned a real row: the
  PostgREST spelling of the RPC arguments, the shape `embeddings.vector` arrives
  in (the parser handles both the `[...]` string and an array), and the RLS
  behaviour under a real user are all unexercised. The ranking, scoring and
  wording around them are covered by unit tests with injected rows.
- **The CLAP tie-break has never seen a real embedding.** The cosine is tested on
  synthetic vectors; whether CLAP similarity actually separates "which of these
  two breaks sits better under this loop" the way a producer would is a question
  for the accuracy harness, not for a unit test.
- **The thresholds are the brief's, not measured.** 6 % and 14 % come from the
  brief and match what stretch engines do to transients, but nothing here
  measured them on real material. They are named constants in one place per
  language for exactly that reason. `TEMPO_WEIGHT` / `KEY_WEIGHT` at 0.5/0.5 is
  the softest choice in the module.
- **Nothing wires this into the chat or the compute.** There is no `compatible`
  chat tool and no job kind; `compat.py` is a library the pipeline does not yet
  call. Both are proposals, below.

## Interpretation choices, noted and moved past

1. **`describe` says "no key detected, tempo only"** when the key axis is absent
   *and* the tempo needs nothing; when a stretch is involved it says "no key
   detected, 3.4% faster" instead, because the stretch is the more useful half of
   that sentence.
2. **"no key detected" is written from the pair's point of view**, so a row reads
   the same whether it is the open file or the candidate that has no key. Which
   side it was is in `KeyMatch.note`, on hover.
3. **The tab component lives in `components/compat/`** rather than
   `components/surface/`, to keep this seam inside its own directory. It is the
   only tab that does.
4. **`components/stems/navigate.ts`'s `SurfaceTab` union was left alone** — it is
   another seam's file, and nothing needs to deep-link into this tab yet. It
   means `openFile(router, id, "compat")` is not available until someone adds
   `"compat"` there.
5. **`p_max_octaves` defaults to 1 everywhere**, so quarter-time and
   quadruple-time pairings are not offered. The parameter accepts 2.
