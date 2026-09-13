# PROPOSALS.md

The packet is the basis, not the boundary. Anything that would make a
producer's flow faster, better, or more understood, without making the beat
for them, gets proposed here and reviewed between phases.

Template:

```
## <name>
**What it does for a producer:** one paragraph, in their words.
**Principle it serves:** which of the nine.
**Principle it risks:** which, and how it's mitigated.
**What it takes:** stages, models, UI, rough effort.
**Where it belongs:** which phase, or a new one.
**Status:** proposed | accepted | deferred | declined, with the owner's note.
```

---

## Meter detection
**What it does for a producer:** Waltz-time soul records and 6/8 gospel loops stop getting a 4/4 grid forced on them. The grid, the loop finder, and the drum pattern read correctly without a manual override.
**Principle it serves:** 2, measure don't guess.
**Principle it risks:** Little. A wrong meter guess is worse than the 4/4 default, so it ships only with a confidence gate and the override stays.
**What it takes:** Bar-length autocorrelation of the downbeat-candidate energy over 3, 4, 6 (and 5, 7) beat groupings; one stage; harness cases from Ballroom waltzes.
**Where it belongs:** Phase 2+.
**Status:** proposed.

## Reference-driven mixing hints
**What it does for a producer:** After comparing my beat with a reference, tell me the specific moves: "your low end is 3 dB heavier below 120 Hz; your hats are 2x denser; your snare has 0.4 s more tail." Suggestions, not a mix.
**Principle it serves:** The learning goal; 2 and 4.
**Principle it risks:** 1, drifting into doing the mix. Mitigated by returning suggestions only, never applying them to audio.
**What it takes:** Band-wise loudness deltas from the comparison, a small rules layer, narration under the grounding contract.
**Where it belongs:** Phase 4+.
**Status:** proposed.

## Chop pitch matching
**What it does for a producer:** Each chop pitched to the song key automatically, editable per chop, so a kit is playable in key the moment it's cut.
**Principle it serves:** 4, every output editable; 5, the library.
**Principle it risks:** None serious; a bad pitch estimate is visible and reversible per chop.
**What it takes:** Per-chop pitch estimate (pyin on the chop), semitone shift with the stretch engine, a per-pad pitch field.
**Where it belongs:** Phase 3+.
**Status:** proposed.

## Session export to DAW project formats
**What it does for a producer:** Instead of a zip of WAVs and MIDI, an Ableton Live set, FL Studio project, or Logic project with the chops on pads and the MIDI on tracks, at the right tempo.
**Principle it serves:** Handoff; not a DAW.
**Principle it risks:** None; effort is the cost, and it is high per format.
**What it takes:** Ableton `.als` (gzipped XML) is documented enough to generate; FL and Logic need reverse-engineered formats. Start with Ableton.
**Where it belongs:** Phase 3+.
**Status:** proposed.

## Groove transplant
**What it does for a producer:** Take the measured swing and offsets of one record and apply them to the MIDI of another, so my programmed drums sit like the break I love.
**Principle it serves:** 2 and 4.
**Principle it risks:** 1, if applied to generated material. It only applies to MIDI derived from the user's audio or tapped on the pads.
**What it takes:** Groove template already measured in `groove.py`; a MIDI transform; a control on the MIDI export.
**Where it belongs:** Phase 3+.
**Status:** proposed.

## Shared kits
**What it does for a producer:** Publish a kit built only from re-voiced or synthesized material I own, so others can play it.
**Principle it serves:** 5.
**Principle it risks:** 6, user audio is private. Mitigated by a rights attestation flow and by allowing only `revoice_render` and pad recordings, never originals, stems, or chops of uploaded audio.
**What it takes:** A `kits` table with a public flag, an attestation step, a public read path for attested kits only.
**Where it belongs:** Phase 10+.
**Status:** proposed.

## Local compute runner
**What it does for a producer:** Nothing directly; it lets the owner run every job kind on a laptop without a Modal account, which makes development and testing of the analysis pipeline immediate.
**Principle it serves:** 8 and 9, tests before DSP and the harness.
**Principle it risks:** None; it is the same code behind the same dispatch contract.
**What it takes:** A FastAPI app in `analysis/lockedgroove/server.py` (built in Phase 0).
**Where it belongs:** Phase 0.
**Status:** accepted (small, inside Phase 0 acceptance).

## Tap tempo and count-in on the pads
**What it does for a producer:** Tap a tempo in the header, get a count-in click before record mode so the first hit lands on the one.
**Principle it serves:** 4.
**Principle it risks:** None.
**What it takes:** Client-only, Web Audio scheduling.
**Where it belongs:** Phase 3.
**Status:** proposed.

## Enharmonic key display
**What it does for a producer:** Keys show the way producers say them (Bb minor, not A# minor) with the alternate spelling on hover. Sharps stay internal.
**Principle it serves:** Understanding.
**Principle it risks:** None.
**What it takes:** A display helper in `web/lib/music/keys.ts`.
**Where it belongs:** Phase 0.
**Status:** accepted (small).

---

## Durable follow-up dispatch
**What it does for a producer:** A stem separation or a loop render always ends with its own analysis in the library, even if the container that created the follow-up job died before it could hand it on.
**Principle it serves:** 5, the library is the product.
**Principle it risks:** None.
**What it takes:** Today the runner dispatches `result.queued_job_ids` in-process. A Postgres trigger on `jobs` insert (`pg_net` POST to `/dispatch`) or a small web-side sweeper for `status = 'queued'` rows older than a minute makes it durable. Half a day.
**Where it belongs:** Phase 2 (stems create many follow-ups).
**Status:** proposed.

## Stage-level progress in the UI
**What it does for a producer:** While a file analyzes, the row says what is being measured ("beats", "key", "structure"), not just a percentage, so the wait reads as work and a slow stage is visible.
**Principle it serves:** 2, measure don't guess (show the measurement happening).
**Principle it risks:** None.
**What it takes:** A `jobs.progress_stage text` column (one migration), one extra field in the throttled progress write, a label in the library row. An hour.
**Where it belongs:** Phase 0 or 1.
**Status:** proposed.

## Cancel a running job
**What it does for a producer:** Queued the wrong file for stems, or a 20-minute mix for a breakdown: stop it, and stop paying for the GPU minute.
**Principle it serves:** 4, every output is editable (including the decision to run it); cost control for Phase 10.
**Principle it risks:** None.
**What it takes:** `jobs.status = 'cancelled'` (check constraint change), a cooperative check inside `JobContext.progress()` that raises, `modal.FunctionCall.from_id(modal_call_id).cancel()` from a web route, `DELETE /api/jobs/[id]`. A day.
**Where it belongs:** Phase 2 (first GPU jobs).
**Status:** proposed.

## Loop-period bonus in the finder
**What it does for a producer:** When the analysis says the record repeats every 4 bars, the 4-bar loops rise to the top instead of tying with 1-bar cuts of the same material; the list reads the way the record is built.
**Principle it serves:** 2; the loop period is already measured.
**Principle it risks:** None serious; a wrong period estimate is gated by `loop_period_confidence`, and `matches_loop_period` is already in `components` so the UI can show it either way.
**What it takes:** One weight (e.g. 0.05 × `loop_period_confidence` when `bars == loop_period_bars`) folded into the score; harness cases from the synthetic set; a decision on whether the four packet weights shrink to keep the sum at 1.
**Where it belongs:** Phase 1 polish or Phase 2, tuned against the harness.
**Status:** proposed.

## Downbeat-likelihood term for beats-mode candidates
**What it does for a producer:** When downbeats are uncertain and the finder tries every beat, loops that start on a kick-heavy beat rank above loops that start mid-bar, so the fallback still lands on "the one".
**Principle it serves:** 2 and 4.
**Principle it risks:** None; it only reorders the fallback, and every edge is draggable.
**What it takes:** Reuse the low-band onset-energy phase score from `beats.py` per candidate start, blended into `onset_lock` in beats mode only.
**Where it belongs:** Phase 2, with BeatNet.
**Status:** proposed.

## "Same loop elsewhere" grouping
**What it does for a producer:** The Loops tab shows "also at bar 17, 25" on a candidate instead of three near-identical rows, and chat can say "that loop comes back three times".
**Principle it serves:** 5; understanding.
**Principle it risks:** None.
**What it takes:** The fingerprint and cosine used for contiguous repeats, applied to non-contiguous pairs; a `similar_to` list of start times in `components`; a small UI affordance.
**Where it belongs:** Phase 1 polish.
**Status:** proposed.

## Crossfade position control in the Loops tab
**What it does for a producer:** A switch between "blend at the head" (post-end audio wraps in) and "blend at the tail" (pre-start audio wraps in) for every loop, not only at end of file; some material sounds better one way (a decaying chord) than the other (a pickup into the one).
**Principle it serves:** 4.
**Principle it risks:** None.
**What it takes:** A `position: "head" | "tail"` option in both renderers (the tail path already exists), a per-loop remembered setting next to `crossfade_ms` and snap, vector cases.
**Where it belongs:** Phase 1 polish.
**Status:** proposed.

## Accuracy history and regression diff
**What it does for a producer:** Nothing directly; it keeps the numbers behind the confidence dots honest. Every merge records the harness scores, and a PR shows which items flipped from hit to miss and why, not just the aggregate.
**Principle it serves:** 9, 2.
**Principle it risks:** None.
**What it takes:** A `--baseline latest.json` option in `eval_accuracy.py` that lists per-item flips with reasons; a small committed `docs/accuracy/` log written by the harness job on `main` (scores only). One day.
**Where it belongs:** Phase 0 tail or Phase 1.
**Status:** proposed.

## Confidence calibration report
**What it does for a producer:** When the app says "likely F minor", "likely" should mean about the same hit rate every time. Report hit rate per confidence band (the section 11 hedging bands) per metric, so a stage whose confidence is uninformative is caught before its words reach the chat.
**Principle it serves:** 2; the grounding contract in section 14.
**Principle it risks:** None.
**What it takes:** Keep `confidence` in the harness prediction, bucket by the hedge bands, add a table to the markdown report and an optional gate on the gap between bands. Half a day.
**Where it belongs:** Phase 2 (when gates are raised).
**Status:** proposed.

## Per-account opt-in for corrections in the harness
**What it does for a producer:** Lets a tester choose to donate their corrections to the accuracy set, in writing, in the app, instead of the harness being limited to the owner's account.
**Principle it serves:** 7, 6.
**Principle it risks:** 6, mitigated by an explicit per-account flag, audio read only through short-lived signed URLs on the owner's machine, and nothing leaving it.
**What it takes:** A boolean on a `profiles` table with a settings toggle and copy explaining what is read; the corrections loader accepts a list of opted-in user ids. Small.
**Where it belongs:** Phase 10, or earlier if testers ask.
**Status:** proposed.

## Ballroom waltz subset as the meter case
**What it does for a producer:** Waltz-time records stop getting a 4/4 grid. The Ballroom set already has 3/4 items with bar annotations; scoring `downbeat` per meter gives the meter-detection proposal its harness case for free.
**Principle it serves:** 2.
**Principle it risks:** None.
**What it takes:** A per-genre and per-meter breakdown in the harness report (item metadata already carries genre and beats per bar). Hours.
**Where it belongs:** Phase 2+, with meter detection.
**Status:** proposed.

## Stored chroma profile for sample-source matching
**What it does for a producer:** "Was this sample pitched?" gets an answer against the whole library, not only against files the user names: every file's mean chroma is kept in the report so the pitch-shift estimate can compare a flip against every candidate source cheaply.
**Principle it serves:** 2, 5.
**Principle it risks:** None; a 12-number vector per file.
**What it takes:** A `chroma_mean` field on `spectral` (regenerate the schema and types), the `sample_use` stage reading candidates from the library through the job runner, a "possible source" flag on files. Half a day.
**Where it belongs:** Phase 4 or 6.
**Status:** proposed.

## Learned drum-hit classifier
**What it does for a producer:** The drum pattern stops missing hats that sit under a snare and starts telling claps from snares and rims from sticks. Rules on three spectral cues can't separate stacked hits; a small classifier trained on separated stems (and the user's own corrections to the pattern) can.
**Principle it serves:** 2; the breakdown's drums section.
**Principle it risks:** None; the rule-based classifier stays as the fallback and the method field says which ran.
**What it takes:** A per-hit feature set (already computed), a labeled set from synthetic stacks plus corrected patterns, a scikit-learn model shipped in the package. Two days.
**Where it belongs:** Phase 4 polish.
**Status:** proposed.
