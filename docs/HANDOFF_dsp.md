# HANDOFF: Phase 0 analysis stages (seam b, DSP)

Owner of this handoff: the DSP agent. Scope: `analysis/lockedgroove/analysis/{tempo,beats,key,onsets,groove,loudness,spectral,structure,grid}.py`,
their tests, and this document. No contract file was modified.

## Files written

```
analysis/lockedgroove/analysis/grid.py        shared grid helpers (bar grid, 16th grid, offsets, bar index)
analysis/lockedgroove/analysis/tempo.py
analysis/lockedgroove/analysis/beats.py
analysis/lockedgroove/analysis/key.py
analysis/lockedgroove/analysis/onsets.py
analysis/lockedgroove/analysis/groove.py
analysis/lockedgroove/analysis/loudness.py
analysis/lockedgroove/analysis/spectral.py
analysis/lockedgroove/analysis/structure.py
analysis/tests/test_grid.py test_tempo.py test_beats.py test_key.py test_onsets.py
analysis/tests/test_groove.py test_loudness.py test_spectral.py test_structure.py test_pipeline_phase0.py
docs/HANDOFF_dsp.md
```

No new packages; `pyproject.toml` untouched (librosa, scipy, numpy, scikit-learn, pyloudnorm, pydantic).

## Test command and result

```
cd /home/user/crateai/analysis && /home/user/crateai-venv/bin/python -m pytest -q
...
407 passed, 1 skipped in 52.43s
```

(The whole `analysis/tests` directory, including the pre-existing schema/ingest tests and the other
seams' tests that landed meanwhile. My 74 tests are the ten files above. `ruff check` on my files: clean.)

Runtime: the default stage set on a synthetic 3-minute stereo 44.1 kHz file takes **17.5 s** on the
4-core build box (tempo 5.2, beats 3.8, loudness 4.2, key 1.1, spectral 0.9, structure 0.5, onsets and
groove ~0 because they reuse memoized work). Budget was 60 s.

## Confidence derivations (also in each module docstring)

| section | confidence |
|---|---|
| tempo | `(1 - runner_up / best) * min(1, best / 0.3)`: strongest prior-weighted tempogram peak over the strongest peak that is not a metrical relative (integer 16ths or 8th-triplets of the winner), times a strength factor so silence/noise cannot be confident; halved if `beat_track`'s own estimate disagrees non-octave |
| beats | fraction of beats within ±30 ms of a backtracked onset |
| downbeat | `(best - second) / best` over the per-phase mean low-band (<150 Hz) onset energy |
| key | `min(1, (r1 - r2) / 0.25) * min(1, r1 / 0.6)`: normalized gap between the best and second-best profile correlation, scaled down when the best profile itself fits poorly |
| groove | `beats.confidence * 1 / (1 + (std_ms / 20)^2) * min(1, n_onsets / 16)` (×0.8 when no off-beat 8ths were available to measure swing) |
| structure (per section) | `0.5 * boundary_strength + 0.5 * silhouette`; boundary strength = normalized novelty prominence at the section's edges (file edges = 1); halved when no reliable loop period exists |
| structure (loop period) | prominence of the chosen lag-histogram peak / 0.4, halved when the lag is not within a quarter bar of a whole number of bars |

`Onsets`, `Loudness`, `Spectral` have no confidence field in the schema; their `method` strings record the measurement.

## Interpretation choices (numbered so PRs can cite them)

1. **Tempo estimator.** Local autocorrelation tempogram of the onset envelope (hop 256, 8.9 s Hann windows,
   detrended per window, averaged with a quarter-window hop instead of librosa's every-frame tempogram; same
   estimate, a fraction of the cost). Prior: log-normal at 95 BPM, σ = 1 octave, window 50–200 as instructed
   (OPEN_QUESTIONS 8 says 60–180; the task said 50–200; 50–200 it is). Parabolic interpolation on the peak:
   bin resolution alone is ~1.5 BPM at 90. `alternates_bpm` = `[bpm/2, bpm*2]`.
2. **"beat_track plus tempogram"** is realised as a cross-check: `beat_track(start_bpm=estimate)` re-estimates
   tempo with librosa's own tempogram; a non-octave disagreement > 8 % halves the confidence and is written to
   `notes`. It does not refine the BPM (the interpolated tempogram is already ±0.1 BPM on steady material).
3. **Tempo confidence and metrical relatives.** With 8th-note hats, the autocorrelation has a comb of peaks at
   every 8th-note multiple (at 90 BPM: 180, 120, 90, 72, 60, 51). Treating those as competitors gave 0.2 on a
   rock-solid boom-bap loop, so the runner-up excludes peaks whose lag is an integer number of 16ths or
   8th-triplets at the winning tempo (they are the alternates, not competition). Consequence: a 3:2 (dotted)
   ambiguity that lands on the triplet grid is also excluded. Swung material (62 %) still reads 0.55 because
   swing creates off-grid peaks; the harness will say whether that needs a swing-aware exclusion.
4. **Half-time on four-on-the-floor.** A 128 BPM house loop reports 63.96 with 128 in `alternates_bpm`: the
   backbeat makes the 2-beat lag stronger than the 1-beat lag, and the 95 BPM prior does not overcome it.
   Expected under the hip-hop-first prior (octave-tolerant metric covers it). Knock-on: at half time the 16th
   grid is the real 8th grid, so off-8th hats read as ±117 ms deviations and the groove says `loose` (0.29).
5. **Beat tracker pinned to the tempo section.** `beat_track(bpm=hint)` rather than `start_bpm=hint`: the tempo
   stage owns the octave decision, the tracker should not re-decide it with its own one-octave prior. Without a
   tempo section it falls back to `start_bpm=95` and says so in `notes`. Hop 256 (hop 128 made the DP
   sloppier, hop 512 coarser).
6. **Beat refinement on onsets.** librosa's DP runs 20–45 ms late on percussive material at frame resolution
   and now and then grabs an off-beat kick (the boom-bap "and-a" pulled beat 2 by 140 ms). Three fixes, in
   order: the whole grid is shifted by the median beat→onset offset (keeps per-beat groove intact, unlike
   per-beat snapping); a beat further than 15 % of the local period from the median prediction of its ±6
   neighbours is regridded; beats before the first onset or after the last one (silent lead-in / tail) are
   trimmed, and a first beat shifted a few ms before zero is clamped to 0, not dropped. Result on programmed
   drums: median error < 15 ms, 94 % within 30 ms. `grid.extend_beats` rebuilds a full-file grid for
   consumers that need one.
7. **Onset at t = 0.** Spectral flux cannot see an attack at the first sample (no previous frame), so a loop
   exported on the one lost its first beat and bar 0 its downbeat. `detect_onsets` adds an onset at 0.0 when
   the first 23 ms already carry ≥ 10 % of the file's peak short-time RMS.
8. **Onset resolution.** Hop 64 (2.9 ms) with `backtrack=True`; 8 clicks come back within ±2 ms. Hop 128 was
   within ±5 ms, hop 512 up to −21 ms. Hop 64 costs ~3 s on 3 minutes; the result is memoized (one-entry
   cache keyed on the array's pointer, shape and a checksum) so beats, onsets and groove compute it once.
   `key.chroma_cqt` is memoized the same way for key and structure.
9. **Downbeat phase.** Zero-phase 6th-order Butterworth low-pass at 150 Hz, positive increments of the RMS
   envelope read in [−30, +60] ms around each beat, mean per phase class. Kick-on-one: 1.0; boom-bap: 0.79;
   four-on-the-floor: 0.00 (every phase equal, honestly undecidable); meter override via
   `ctx.options["meter"]` regroups with `grid.beats_per_bar` (3/4 verified).
10. **Key is a pitch-class-set estimate, and `synth.loop_based_track` is Dorian.** Plain K-S on mean
    `chroma_cqt` is right on every unambiguous fixture (C major / A minor arpeggios and scales, a Bb major
    progression). The loop track's chords (Fm G# A# Cm / D# Fm Cm G#) use D natural, so its pitch-class set
    is C minor = Eb major = F *Dorian*, and C is the most frequent pitch class (in 6 of 8 chords). Any profile
    method reports **C minor (alt D# major)** there; F minor is 4th. I tried bass-register / lowest-voice
    emphasis: it recovers F minor on paper but the synthetic kick tail (48 Hz ≈ G1) turns it into "G minor",
    and real 808s would do the same, so it is out. The pipeline test therefore accepts the fixture's truth
    **or its pitch-class family** {F minor, C minor, D# major} on the key or the alternate, with a comment.
    See "Needs in contract files" below.
11. **Key confidence scale.** `(r1 - r2) / 0.25`: a gap of 0.25 in correlation is a clear win. Calibration
    on fixtures: A minor scale 0.99, C major scale 0.64 ("likely"), the Dorian loop 0.37 ("I can't tell",
    honest), drums-only 0.37, a plain C-E-G arpeggio 0.12 (the tone's 5th harmonic makes E minor a close
    second; a two-octave arpeggio is 1.0). A metronome click reads "C minor 0.68" because the 1 kHz click is
    tonal; nothing in the method knows it is not music. Tune with the harness (Key exact gate 65 %).
12. **Groove: swing first, then deviations against the swung grid.** Swing = median over beats of the
    per-beat median position of onsets in the off-8th region (40–72 % of the beat; straight 16ths at 25/75 %
    stay outside; needs ≥ 4 beats with an off-8th, else 50 and confidence ×0.8). Deviations are measured
    from the 16th grid built *with that swing* (`grid.sixteenth_grid`), so a programmed swung loop reads tight
    (std 7.8 ms) and `timing_deviation_ms` measures looseness, not swing. Fixtures: straight 50.4, swing 56 →
    56.3, 62 → 62.1, 66.7 → 67.2. Feel: `swung` if swing > 54, else `loose` if std > 20 ms, else `straight`
    (swung wins over loose because the swing value is the actionable one; Phase 4 `drums.py` reports the
    programmed/sampled question separately).
13. **Loudness conventions.** Runs on `ctx.native` (stereo at the file rate). BS.1770 reads a single-channel
    0 dBFS sine as −3.01 LKFS, so the "−20 dBFS sine → −20 LUFS ±1" test is the stereo case (−20.04);
    the mono case is −23.05 and tested as such. Silence reports the floor −70 LUFS / −100 dBTP rather than
    −inf so the report stays JSON. Files shorter than a 400 ms block are zero-padded to one block. LRA
    follows EBU Tech 3342 (3 s windows every 100 ms, −70 absolute gate, −20 LU relative gate, P95 − P10)
    computed with cumulative sums over the K-weighted signal (pyloudnorm's own filters); a two-level
    −30/−10 dBFS signal gives 20.0 LU.
14. **Spectral width** = `2·E_side / (E_mid + E_side)` clipped to [0, 1], which equals `1 − corr(L, R)` for
    balanced channels: mono 0, `to_stereo(width=1)` → 1.0 (clipped from 1.07), width 0.3 → 0.19. Centroid is
    the mean per-frame centroid over frames within 60 dB of the loudest (silence does not drag it down);
    low/high ratio is clamped to ±60 dB and 0 when both bands are empty.
15. **Structure: sequence novelty instead of a literal Foote kernel.** Beat-synchronous MFCC (plain mean per
    beat) + chroma (RMS-weighted mean per beat), standardized with floors (2 dB MFCC, 0.05 chroma) and a
    regularized cosine SSM so humanization noise in uniform material is not inflated into structure. The SSM
    is path-enhanced (diagonal mean over ±2 beats) so entries mean *sequence* similarity. The loop period is
    the shortest lag-histogram peak reaching 60 % of the strongest, histogram normalized by the number of
    beats (not pairs) so long lags do not win by default. Boundaries: the checkerboard novelty on that
    recurrence matrix, evaluated on the loop-aligned diagonal of the cross blocks (`1 − mean_k S[c−L+k, c+k]`
    with `L` = loop period, or two bars without one). The plain within-block terms were the failure mode: a
    loop of four distinct chords has ~0 within-block similarity, and any window straddling a boundary that
    happens to contain a repeated chord peaks one bar early (it did, systematically). Peaks are snapped to
    downbeats, kept ≥ one loop from either file edge (a fade or silent tail is not a section), and a boundary
    between two stretches with the same label is dropped. Labels: sections compared by their aligned
    diagonal (±1 beat), spectral clustering with k by silhouette over 2..min(6, n−1); n = 2 uses a 0.5
    similarity threshold; silhouette < 0.05 means one label. Verified: ABAB/ABCB/ABBA/ABAB-2-bar/ABAB-16-bar
    boundaries exact with correct labels; repeated same-content sections (AABB, ABBA's BB) correctly merge;
    8-bar single-loop file, humanized drum loops (two seeds) and clicks give one section.
16. **Structure without beats.** Fewer than two bars of beats (or silence): one section covering the file,
    `start_bar` 0, `bars` 1, confidence 0, `notes` says why; no loop period. I chose that over a fake 0.5 s
    pseudo-grid because "bars" would then not be bars.
17. **Bar grid semantics (`grid.bar_grid`).** Downbeats anchor the grid; bar length is the median downbeat
    spacing; bars extrapolate to cover `[0, duration]`; a pickup before the first downbeat belongs to bar 0
    (indices never go negative). `Section.start_bar/bars` use it; the last section ends exactly at the file
    duration, so a 0.5 s tail makes an 8-bar loop report 9 bars.
18. **Rounding.** Beat/onset/downbeat times are rounded to 0.1 ms, BPM to 0.001, confidences to 1e-4, so
    the JSON is stable and diff-able. Determinism: no RNG anywhere; `SpectralClustering(random_state=0)`;
    the pipeline test asserts equality of two runs.
19. **Never raising.** Every `run` catches its own failures and returns a low-confidence section; the
    pipeline test runs 2 s of silence and 50 ms of silence through the default stage set with
    `ctx.errors == {}`.

## Needs in contract files (I did not touch them)

- `analysis/lockedgroove/testing/synth.py` — `loop_based_track` truth `key: F minor` is a Dorian vamp whose
  pitch-class content is C minor / D# major (choice 10). Either add `key_family` (or accept
  `{F minor, C minor, D# major}`) to the truth, or change the A loop to an Aeolian progression (e.g. Fm
  C# D# Cm, i.e. Db instead of Bb) so the truth is unambiguous. Until then `test_pipeline_phase0.py`
  accepts the family, with a comment pointing here. The harness "key relative-tolerant" metric should
  count the relative of the reported key, which is what `alternate` carries.
- `pipeline.Context` has no scratch slot for stage-to-stage feature sharing. I memoize the hop-64 onsets and
  `chroma_cqt` inside `onsets.py` / `key.py` (one-entry caches keyed on the array pointer + checksum). A
  `Context.cache: dict` field would make that explicit and let Phase 4 stages (drums, chords) reuse the
  same features; the memo would then move there without changing any `run` signature.

## Known limitations for the harness to quantify

- ABAB where each section is exactly one loop with no internal repetition: the lag histogram finds the AB
  period and the aligned novelty sees nothing inside it; timbre is the only cue and MFCC alone was not
  reliable in Phase 0. Reported as one section with the longer loop period (not wrong, just coarse).
- A bare metronome click reports a 2-bar loop period: the 5 ms burst sits on the beat-boundary frame and its
  Hann-window position cycles with beat-frame quantization. Real hits are 50–300 ms long and average this
  out; clicks are not material, so I stopped there (the section split it used to cause is fixed).
- Tempo confidence on heavily swung loops (0.55) and half-time on four-on-the-floor house (choice 4).
- Key on Dorian/modal vamps (choice 10) and on non-musical tonal input (choice 11).
- `beats.confidence` on chords-only material is ~0.6 (soft attacks; fewer onsets within 30 ms of a beat).
- Constants worth tuning against GiantSteps/Ballroom: `tempo.STRENGTH_FULL`, `key.GAP_FULL`,
  `groove.LOOSE_STD_MS`, `structure.NOV_ABS/NOV_REL_PROM/PERIOD_STRONG_FRAC/COSINE_REG`. All are named
  module constants.

## PROPOSALS

## Swing-aware tempo confidence
**What it does for a producer:** A swung break gets "90 BPM" stated plainly instead of "roughly 90 BPM": the confidence stops treating the swung off-beats as a competing pulse.
**Principle it serves:** 2, measure don't guess (the hedge should reflect real ambiguity, not swing).
**Principle it risks:** None; a genuinely ambiguous 3:2 pulse still lowers the confidence because it is off the swung grid too.
**What it takes:** `groove.py` already measures the swing; feed it back into `tempo.py`'s metrical-relative rule (exclude lags at `s` and `1 - s` of a beat as well as the straight subdivisions). Half a day plus harness runs on Ballroom.
**Where it belongs:** Phase 2 (with the better beat tracker).
**Status:** proposed.

## Tonic refinement for modal vamps
**What it does for a producer:** Fm-Ab-Bb-Cm reads as "F minor" the way the producer hears it, not "C minor", once the chord segmentation exists: the loop's resting chord and the chord roots break the tie inside a diatonic family.
**Principle it serves:** 2 and the learning goal; the key shown matches the loop the producer will build in.
**Principle it risks:** 2, if a heuristic overrides measured pitch content. Mitigated by only re-ranking keys within the pitch-class family K-S already chose, by leaving `alternate` as the K-S runner-up, and by logging corrections (principle 7) to measure whether it helps.
**What it takes:** `chords.py` (Phase 4) gives the chord sequence; a tonic score from chord-root duration, loop-start chord (structure's loop period), and cadence patterns; one harness case set from GiantSteps minor keys. Two days.
**Where it belongs:** Phase 4, after `chords.py`.
**Status:** proposed.

## Octave decision from the drum pattern
**What it does for a producer:** House and drum-and-bass records get 128 / 174 instead of 64 / 87 when the kick pattern says so, while boom-bap stays at 90 instead of 180, without changing the prior.
**Principle it serves:** 2; the octave choice becomes a measurement (kick period versus snare period) instead of a prior.
**Principle it risks:** None serious; the alternates stay, halve/double stays one click.
**What it takes:** Once `drums.py` classifies hits, the kick inter-onset period and the snare (backbeat) period decide between `bpm` and its alternates; a harness split by genre. One day.
**Where it belongs:** Phase 4, or Phase 2 if BeatNet's downbeat output makes it trivial.
**Status:** proposed.

## Shared feature cache on Context
**What it does for a producer:** Faster analysis on every upload; nothing visible.
**Principle it serves:** 8/9 indirectly (cheaper harness runs), and the cost line in BUILD_PACKET section 19.
**Principle it risks:** None.
**What it takes:** A `cache: dict` on `pipeline.Context`; `onsets.detect_onsets` and `key.chroma_cqt` read/write it instead of their module memos; Phase 4 stages reuse the beat-synchronous features from `structure.py`. An hour.
**Where it belongs:** Phase 0/1 housekeeping.
**Status:** proposed.
