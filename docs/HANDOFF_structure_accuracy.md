# HANDOFF: structure accuracy

Scope: `analysis/lockedgroove/analysis/structure.py`, `analysis/tests/test_structure.py`, this
document. Nothing else was touched; no contract file, no gate, no fixture, no other stage.
Nothing committed.

## Headline

| metric (synthetic, 48 items) | before | after |
|---|---:|---:|
| `structure_f` | **0.677** | **0.931** |
| `bpm_exact` | 0.562 | 0.562 |
| `bpm_octave` | 1.000 | 1.000 |
| `key_exact` | 0.833 | 0.833 |
| `key_relative` | 1.000 | 1.000 |
| `downbeat` | 0.792 | 0.792 |

```
cd analysis && uv run python ../scripts/eval_accuracy.py --dataset synthetic --workers 3 --no-gate
```

Per-item boundary score distribution (precision, recall):

| | before | after |
|---|---:|---:|
| (1.00, 1.00) | 17 | **32** |
| (1.00, 0.67) | 17 | 15 |
| (0.67, 0.67) | 0 | 1 |
| (0.50, 0.33) | 1 | 0 |
| (0.33, 0.33) | 4 | 0 |
| (0.09, 0.33) | 1 | 0 |
| (0.00, 0.00) | **8** | 0 |

Nothing scores zero any more, and nothing has a false boundary except one item. **0.9375 is the
ceiling of this dataset** (see "What the fixture, not the code, gets wrong"), so 0.931 is 99.3 % of what is
reachable here. Two other numbers that are not gated but are product-facing:

| | before | after |
|---|---:|---:|
| loop period correct (in the grid the beats stage produced) | 40 / 48 | **46 / 48** |
| section label pattern exactly right (ABAB / AABA / ABCB up to renaming) | 24 / 48 | **31 / 48** |

Stage cost is unchanged: median 0.12 s per item, max 0.25 s (budget 60 s for the whole file).
`analysis` suite: 423 passed, 2 skipped (both pre-existing: `basic_pitch`, `modal` not installed);
`ruff check .` clean.

## The five bugs

Everything below was found by running the harness, then re-running the stage on single items with
the beat grid cached, and reading the intermediate arrays (similarity matrix, lag histogram,
novelty curve, peak list) against the fixture's ground truth.

### 1. The boundary was systematically one bar early — path enhancement smears the thing it is measured against

**Exposed by** `key12_C_minor_120bpm`, `key15_Ds_minor_132bpm`, `octave3_half_87.5bpm`,
`loop8_ABAB_170bpm`, `key17`, `key20`, `key21`, `swing4`, `swing2`, `nodrums4` — eleven items whose
predicted boundaries were early by *exactly one bar*, e.g. key12 predicted `[15.49, 31.49, 47.49]`
against a truth of `[17.50, 33.50, 49.50]` with a 2.00 s bar. One bar is just outside the harness's
±1-bar window, so four of these scored a flat zero with three correct-looking boundaries.

**Cause.** `run` computed the novelty on `Spe = path_enhance(S)`. Write the loop-aligned novelty
out: `nov[c] = 1 - mean_k S[c-L+k, c+k] = 1 - mean(d[c-L … c-1])` where `d[m] = S[m, m+L]`. It is a
**boxcar of length L over the lag-L diagonal**, and the dip in that diagonal at a boundary is
exactly L beats wide — the boxcar is a matched filter and its maximum sits on the boundary.
`path_enhance` averages each diagonal over ±2 beats, so the dip becomes L+4 wide and no longer
matches the window. That alone would not move the peak; what moves it is that the dip is not flat.
The two loops either side of a boundary usually share a chord at some loop positions (in this
dataset A = `i VI III VII` and B = `iv i VI VII` share the `VII`), so the cross-section similarity
*rises* through the loop — measured on key12, the dip runs 0.18 → 0.83. Smearing a lopsided dip
wider than the window moves the boxcar's best position toward the deep end, i.e. earlier. Measured
on key12: the raw diagonal puts the maximum at beat 35 (the true boundary); the path-enhanced one
puts it at 33 and 34, and the downbeat snap then took it a further two beats back.

**Fix.** The novelty reads the raw `S`; the path-enhanced matrix stays where it belongs (the
repetition statistics and the section affinity, where sequence matching is the point and
localization is not). **Justification:** the loop-aligned novelty *is* an average over L
consecutive beats of the diagonal, so it already answers "does this sequence repeat"; pre-smoothing
along the same axis is a second low-pass on the edge you are trying to locate.

### 2. Snapping to the nearest downbeat relocated correct boundaries by half a bar

**Exposed by** `key17_F_minor_144bpm`, `key21_A_minor_168bpm`, `loop8_ABAB_170bpm`,
`nodrums5_both_165bpm`. On all four the novelty peaks landed on *exactly* the true boundary beats
(key21: peaks 17/33/49, truth 17/33/49) and the output was still a bar out.

**Cause.** These are fast tracks where the beat stage reads half time, so a detected "bar" spans two
real bars, and its downbeat phase sits between the section changes — downbeats at beats 2, 6, 10 …
while the boundaries are at 16, 32, 48. The nearest downbeat is then two beats away *on both sides*;
`downbeat_idx[np.argmin(np.abs(downbeat_idx - p))]` breaks that tie toward the earlier one and moved
every boundary half a detected bar = one real bar.

**Fix.** `snap_boundaries()` snaps only when a downbeat is within `SNAP_MAX_BARS` (a quarter bar,
one beat in 4/4); otherwise the peak stands. **Justification:** the snap exists because section
changes fall on bar lines and the peak is accurate to about a beat — a quarter-bar move is a
refinement inside that uncertainty. A larger move is not a refinement, it is a different answer:
either the peak is equidistant between two bar lines (no information to act on) or the grid is at
the wrong metrical level or phase, and moving the boundary to it invents up to half a bar of error
against every feature in the file. Principle 2: report what was measured.

### 3. The loop period could land on a lag where nothing repeats, which shredded the file

**Exposed by** `key01_Cs_major_72bpm` (predicted 5 boundaries, none right, loop period 1 bar),
`octave0_half_70bpm` (11 boundaries, F = 0.14, loop period 1 bar), `swing3_58pct_sampled_118bpm`
(loop period 1 bar), `key04_E_major_88bpm` (loop period 3.5 bars).

**Cause.** `lag_histogram` averaged the similarity along each lag diagonal. A mean rewards material
that is *correlated* at a lag as much as material that *repeats* at it. On key01 the beats stage
reads double time, so a detected bar is half a real bar: with a four-on-the-floor kick on every real
beat and a chord held through the bar, the mean similarity at a half-bar lag is 0.67 while the real
loop (8 detected bars) reads 0.70 — and the rule "shortest peak reaching 60 % of the strongest" then
takes the half bar. The novelty window becomes half a bar, which makes a boundary out of every chord
change. The measurement that says the half-bar lag is not a period was sitting right next to it:
the similarity at *twice* that lag is 0.36, i.e. at the histogram's baseline, and a signal that
repeats with period T also repeats at 2T.

**Fix.** `repeat_histogram()` counts, per lag, the fraction of beats whose counterpart one lag later
is *the same material* (path-enhanced similarity ≥ `REPEAT_SIM` = 0.8), instead of averaging the
similarity. On key01 that reads 0.31 at the half bar against 0.70 at the true loop; on
`octave0_half_70bpm`, 0.23 against 0.52. **Justification:** a loop is a repeat, so count repeats. A
sustain, a pad, a kick on every beat and a hat on every 8th all raise the *correlation* at short lags
without anything recurring; a threshold at "this is the same bar again" is immune to them, and it is
the same question the producer is asking ("what is the loop?").

The threshold is the one number in the change that a score could pull on, so here is the whole sweep,
end to end on all 48 items:

| `REPEAT_SIM` | 0.50 | 0.60 | 0.70 | 0.75 | **0.80** | 0.85 | 0.90 | 0.95 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| `structure_f` | 0.861 | 0.880 | 0.880 | 0.917 | **0.931** | 0.938 | 0.938 | 0.933 |
| loop period right | 41 | 42 | 42 | 45 | **46** | 47 | 47 | 45 |

0.85 reaches the dataset's ceiling and I did not take it. This set's repeats are *identical renders*,
so its optimum sits as high as the numbers allow; a repeat on a record is the same loop with a
different vocal, a fill and a room on it, and a threshold that demands near-identity would find no
loop at all there and drop the stage onto its weaker fallback. 0.80 is the low edge of the range
where the statistic still separates repeats from correlation, which is the right side to err on.
That choice costs 0.007 of measured score, on one item, on purpose.

Side effect, free: loop period accuracy 40/48 → 46/48, and `loop8_*` items now report their true
8-bar loop instead of its 4-bar half.

### 4. A comparison window as long as the form produced no boundaries at all

**Exposed by** `octave3_double_175bpm`: 0 predicted boundaries, F = 0.00, after fix 3 had been
applied (it was masked before by bug 3 picking a shorter lag for the wrong reason).

**Cause.** This file's strongest repetition is its whole ABAB form (A ↔ A and B ↔ B at 32 beats,
88 % of everything it can match), while its 4-bar loop only matches inside sections (26 %). With the
32-beat lag chosen, `sequence_novelty` needs `n ≥ 2L` just to return anything, and with `n = 66` it
evaluated three points — a boundary cannot be a local maximum of a three-point array, so nothing was
found.

**Fix.** Two constraints, one selection function: `loop_period(h, bpb, max_lag=...)` is called twice
— `n // MIN_LOOP_REPEATS` (2) for the period that gets *reported*, and `n // MIN_WINDOW_REPEATS` (4)
for the period the novelty uses as its comparison window. If nothing qualifies for the window, the
novelty falls back to the four-bar checkerboard contrast, the section confidences are halved, and
`notes` says so. **Justification:** a period needs two occurrences before it is a period, and a
window needs to fit in the file several times before a boundary is a *local* peak rather than a
plateau across the whole track. The result is insensitive to that second number — n/3, n/4, n/5 and
n/6 all give the same score — which is what tells you it is structural rather than tuned.

### 5. The merge step deleted real boundaries whenever the labeling under-counted sections

**Exposed by** `key20_Gs_minor_162bpm` and `key23_B_minor_175bpm` (both ABCB, both lost their A→B
boundary although the novelty had found it and snapped it onto the right downbeat).

**Cause.** `run` dropped every boundary whose two sides landed in the same spectral cluster. But `k`
is chosen once for the whole file by silhouette; on an ABCB form with a very distinct C, the
silhouette prefers `k = 2` and puts A and B together. That is a statement about how much variety the
file has, not evidence that the novelty was wrong, and it deleted a boundary with a 0.6 relative
prominence.

**Fix.** `merge_same_material()` drops a boundary only when the two sections' own aligned similarity
reaches `REPEAT_SIM` — the same bar the loop detector uses for "this is the same material".
**Justification:** "these two stretches are the same material" is a measurement, and it should be
made directly rather than inherited from a partition of the whole file. The guard is still there for
its real purpose (a spurious split inside one homogeneous section) and still fires on real material;
on this dataset no adjacent pair reaches 0.6, let alone 0.8, so it changes nothing here and removes
two deletions.

### 5b. Sections were compared a pickup out of phase (labels, not boundaries)

Found while checking that labels had not regressed. `aligned_similarity` lined sections up from
their start times. The first section starts at t = 0, so it carries whatever lead-in silence or
pickup the file has, and it was therefore compared with its own repeat 3 beats out of phase: on
`key12` the A ↔ A similarity read 0.36 instead of 0.99 and the file was labelled ABCB instead of
ABAB. Sections are now lined up from their first downbeat (`section_anchors`), which is their start
except where a section does not begin on a bar line. Labels: 27 → 31 of 48 exactly right.

I tried taking the *best* of the start-aligned and bar-aligned comparisons, which sounds more
robust and scores one item worse: that number also decides whether a boundary is deleted (bug 5), so
inflating it with a max over more alignments is the wrong direction.

## What the fixture, not the code, gets wrong: 15 items cannot score above 0.8

Every remaining miss but one is the same thing: the first boundary of an `AABA` item.

`build_synthetic_dataset.py` renders a section from its label alone, so in AABA the two A sections
carry the same material. **Re-measured independently during review, and the mechanism is not the
same on every item** — the conclusion holds but the evidence is more mixed than first written:

| AABA items | A₁ − A₂ | boundary findable? |
|---|---|---|
| 6 (`loop8_AABA_126`, `key07`, `nodrums1`, `nodrums4`, `octave1_double`, `octave1_half`) | 0.0 to 1.5e-5 (−96 dBFS) | no: the audio either side is the same audio |
| 8 (`key01`, `key04`, `swing2`, `swing5`, …) | 0.2 to 0.95, but **equal to the difference between two ordinary loop repeats inside the same section** | no: the AA line looks like every other bar line |
| 1 (`key10`) | 5.2e-1 against 1.5e-5 within the section | yes, in principle: this one does carry evidence |

Comparing raw samples here is delicate: the section starts are not on integer sample boundaries, and
truncating rather than rounding the index misaligns the spans by one sample, which on a kick
transient reads as a difference of 0.7 where the true difference is 0.0. The numbers above round.

So the ceiling is *approximately* 0.9375 rather than exactly: 14 of 15 AABA items are capped at
P=1.00, R=0.67, F=0.80 on the first boundary, which puts it near 0.94, and 0.931 is close to it.
Treat that as the working estimate, not a proven bound.

I did not touch the fixture (`scripts/` is not mine). The fix, for whoever owns it, is
either to make repeated sections distinguishable (a fill in the last bar of a section, a filter
sweep, a dropped layer — which is what real AABA records do) or to annotate the AA boundary as
optional. Until then `structure_f` on `synthetic` cannot exceed 0.9375, and a future change that
reports 0.95 should be treated as a bug in the metric or the code, not an improvement.

## Left alone deliberately

- **`loop8_ABCB_140bpm`, the one item with a false boundary** (P = R = 0.67). Its 8-bar loop is two
  4-bar phrases that share half their chords, so the 4-bar period is genuinely strong and gets
  chosen; with a 4-bar window the first boundary lands 2 bars early. The two readings of that file
  are both defensible and I am not going to move `PERIOD_STRONG_FRAC` to make one item flip.
- **`octave3_double_175bpm`'s reported loop period** (8 detected bars = the AB form, rather than the
  2 detected bars the fixture calls the loop). Each of its sections is exactly two loops long, so
  the 4-real-bar loop only matches over half the file while the form matches over all of it. The
  *window* selection picks the short one and the boundaries are perfect; only the reported number is
  the longer reading. Correcting it needs a rule about which of two true periods to name, which is a
  design question, not a bug.
- **`NOV_ABS` (0.3), `NOV_REL_PROM` (0.4), `PERIOD_STRONG_FRAC` (0.6), `PERIOD_MIN_PROM`,
  `SIL_MIN`, `COSINE_REG`, the feature floors.** No item's failure traced to any of them, so
  nothing was moved. Every constant I did add is either a musical fact (a period needs 2
  occurrences; a snap is a quarter-bar refinement) or sits on a measured plateau (`REPEAT_SIM`).
- **The gate** (`scripts/gates.json`, `synthetic.structure_f` ≥ 0.60). It is not mine to edit and I
  am not asking for a raise yet: the honest bound is the fixture's 0.9375 ceiling, and the number
  above it is mostly a statement about synthetic material. Once the AABA fixtures carry real
  variation, a gate around 0.80 would have margin. Raising it now would lock in a dataset artifact.
- **The whole-file / no-beats / features-failed paths, rounding, determinism.** Unchanged.

## What will still fail on real records

The synthetic set is programmed drums and tones: exact repeats, no vocals, no reverb tails across a
boundary, no live tempo drift, and one arrangement change per boundary. Expect these to be the real
failure modes, in rough order of how much they will cost:

1. **Sections that change without repeating.** The loop-aligned novelty needs a period; with none it
   falls back to the four-bar checkerboard contrast, which is the weaker instrument (that is why the
   confidence halves). A through-composed intro, a bridge that appears once, a live band record — all
   land on the fallback. The synthetic set barely exercises it.
2. **Boundaries announced early.** Real records put a fill, a riser or a cymbal choke in the bar
   *before* the change, and a vocal pickup before that. The novelty will peak in the fill, a bar
   early, and the quarter-bar snap will not pull it back. On this dataset the harness cannot see
   that class of error at all.
3. **Additive changes.** A verse that becomes a chorus when a synth and a vocal enter over the same
   loop keeps most of its beat-level similarity — MFCC+chroma per beat sees a modest change where a
   listener hears a section. Sections that differ only by energy or density will be under-segmented.
4. **A wrong metrical level upstream.** Half or double time is common on real hip-hop (and already
   happens on 21 of these 48 items: 17 at half time, 4 at double). The stage is now robust to the
   *phase* of that grid — that is bug 2 — but the loop period is reported in whatever bars the beats
   stage produced, so "a 2-bar loop" can mean 4 real bars. Anything downstream that prints the number
   should print it with the tempo it was measured against.
5. **Reverb, delay tails and long release** across a boundary raise the cross-section similarity for
   the first beat or two of the new section, which flattens the top of the novelty and makes the
   exact bar ambiguous. Visible already in a hand-built fixture where the two loops end on the same
   chord: the novelty plateaus for five beats and the peak inside that plateau is arbitrary. The
   plateau is honest — the shared bar could belong to either section — but the reported boundary
   within it is a coin flip.
6. **Long records.** Everything here is 45–145 s. `S` is O(beats²); a 7-minute track at 170 BPM is
   ~1200 beats, which is still small (a few MB, well under a second), but the `MIN_WINDOW_REPEATS`
   rule gets easier and `MIN_LOOP_REPEATS` never binds, so the failure mode flips from "no
   boundaries" to "too many".

The next real improvement is not another threshold: it is scoring the stage against
`data/harmonix` (140 hip-hop tracks with human segment annotations, which `fetch_public_datasets.py`
already supports and which need only the user's own audio). Every claim in the list above is a
hypothesis until it is measured on records.

## Files

```
analysis/lockedgroove/analysis/structure.py   the five fixes, documented in the module docstring
analysis/tests/test_structure.py              +9 regression tests (the 9 that existed are untouched)
docs/HANDOFF_structure_accuracy.md            this file
```

New tests, one per bug, each isolating it on a fixture built in the test:

| test | bug |
|---|---|
| `test_sequence_novelty_peaks_on_the_boundary_not_before_it` | 1 — a hand-built asymmetric dip; asserts the raw matrix peaks on the boundary and that smearing it first does not |
| `test_abab_boundaries_land_on_the_bar_not_a_bar_early` | 1 — end to end, tolerance half a beat instead of the harness's bar |
| `test_snap_keeps_a_boundary_no_downbeat_is_near` | 2 — a peak equidistant between two bar lines stays put; one beat away still snaps |
| `test_half_time_grid_does_not_move_boundaries_half_a_bar` | 2 — end to end with a half-time grid whose bar lines fall between the sections |
| `test_repeat_histogram_counts_repeats_not_correlation` | 3 — material that repeats every 16 beats over a texture correlated every 4; asserts the old statistic's answer as well |
| `test_double_time_grid_does_not_shred_the_file_into_bars` | 3 — end to end; the old code returns 16 sections, the new one 4 |
| `test_loop_period_max_lag_bounds_the_comparison_window` | 4 |
| `test_merge_only_drops_a_boundary_between_the_same_material` | 5 |
| `test_sections_are_compared_bar_for_bar_across_a_pickup` | 5b |

Seven of the nine fail against the previous `structure.py` (verified by running the same test file
against `git show HEAD:...structure.py`). The two that do not:
`test_sequence_novelty_peaks_on_the_boundary_not_before_it` asserts the correct behaviour of a
function the fix did not change — what changed is what `run` hands it — and
`test_abab_boundaries_land_on_the_bar_not_a_bar_early` passes on both because that fixture's two
loops happen not to share a chord, so it is a guard rather than a reproduction.

## Proposals

Not appended to `docs/PROPOSALS.md`: three other agents are editing this tree in parallel and that
file is shared. Promote whichever fit.

```
## Section lengths quantized to the loop
**What it does for a producer:** Sections start where the loop starts. A verse that the analysis puts 2 bars early because the loop's two halves rhyme gets pulled onto the bar the producer would have marked, and a section is always a whole number of loops long, so the loop browser, the chopper and the arrangement view agree with each other.
**Principle it serves:** 2 (the loop period is measured, and a section boundary that is not a multiple of it is evidence against itself), 4 (the corrected value is one drag away either way).
**Principle it risks:** 2, if it forces a grid onto material that genuinely does not sit on one. Mitigated by only moving a boundary within its own novelty plateau, and by leaving it alone when the loop period is not reliable.
**What it takes:** Take the strongest boundary as the phase reference; for each other boundary, snap to the nearest multiple of the loop period from it when that lands inside the novelty peak's plateau. One afternoon in structure.py, plus the Harmonix run below to prove it does not hurt records.
**Where it belongs:** Phase 2, with the better beat tracker (it is only as good as the bar grid).
**Status:** proposed.

## Structure scored on Harmonix
**What it does for a producer:** The confidence dot next to "Verse / Chorus" starts meaning something, because the stage has been measured on 140 hip-hop records with human segment annotations instead of 48 renders of drum machines and triads. Every claim about what breaks on real music becomes a number.
**Principle it serves:** 9 (the harness gates merges), 2.
**Principle it risks:** None. The set distributes annotations only; the audio is the user's own copy and never leaves the machine (`scripts/README.md` §2).
**What it takes:** `fetch_public_datasets.py --dataset harmonix` already pulls the annotations and the loader scores whatever audio is present; the gap is a `structure_f` gate for that dataset and a first run. A day, most of it finding the tracks.
**Where it belongs:** Phase 0 tail, before the structure gate is raised.
**Status:** proposed.

## AABA fixtures that a section boundary could be heard in
**What it does for a producer:** Nothing directly; it stops the harness rewarding a stage for guessing. 15 of the 48 synthetic items annotate a boundary in the middle of two bit-identical renders of the same section, which caps the metric at 0.9375 and would credit any method that split there by luck.
**Principle it serves:** 9, and 2 by extension.
**Principle it risks:** None.
**What it takes:** In `build_synthetic_dataset.py`, vary a repeated section the way a record does - a fill in its last bar, a dropped hat layer, a filter opening - or mark the AA boundary optional in the truth so the metric skips it. Hours, plus a rebuild of the set.
**Where it belongs:** Phase 0 tail (it belongs to whoever owns scripts/).
**Status:** proposed.
```
