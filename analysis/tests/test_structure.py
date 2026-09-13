"""structure.py: beat-synchronous recurrence, novelty boundaries, clustered labels, loop period."""

from __future__ import annotations

import numpy as np

from lockedgroove.analysis import beats as beats_stage
from lockedgroove.analysis import structure as structure_stage
from lockedgroove.pipeline import Context
from lockedgroove.report import AnalysisReport, FileInfo, Structure, Tempo
from lockedgroove.testing import synth

SR = 22050
BPM = 90.0
BAR = 4 * 60.0 / BPM


def _ctx_for(y: np.ndarray, bpm: float = BPM) -> Context:
    report = AnalysisReport.empty(FileInfo(duration_s=len(y) / SR, sample_rate=SR, channels=1))
    report.tempo = Tempo(bpm=bpm, confidence=0.9, method="test", alternates_bpm=[bpm / 2, bpm * 2])
    ctx = Context(report=report, sr=SR)
    report.beats = beats_stage.run(y, SR, ctx)
    return ctx


def _check_coverage(s: Structure, duration_s: float) -> None:
    assert s.sections[0].start_s == 0.0
    assert s.sections[0].start_bar == 0
    assert abs(s.sections[-1].end_s - duration_s) < 1e-6
    for a, b in zip(s.sections[:-1], s.sections[1:]):
        assert abs(a.end_s - b.start_s) < 1e-9
        assert a.start_bar + a.bars == b.start_bar
    for sec in s.sections:
        assert sec.bars >= 1
        assert 0.0 <= sec.energy <= 1.0
        assert 0.0 <= sec.confidence <= 1.0


def test_abab_four_bar_loop():
    y, truth = synth.loop_based_track(sections="ABAB", loop_bars=4, section_bars=8)
    s = structure_stage.run(y, SR, _ctx_for(y))
    assert isinstance(s, Structure)
    assert s.method
    _check_coverage(s, len(y) / SR)
    assert len(s.sections) == 4
    for got, want in zip(s.sections, truth["sections"]):
        assert abs(got.start_bar - want["start_bar"]) <= 1
        assert abs(got.start_s - want["start_s"]) <= BAR + 0.05
    labels = [sec.label for sec in s.sections]
    assert labels[0] == labels[2] and labels[1] == labels[3] and labels[0] != labels[1]
    assert labels[0] == "A" and labels[1] == "B"
    assert s.loop_period_bars == 4
    assert s.loop_period_confidence > 0.5
    assert all(sec.confidence > 0.3 for sec in s.sections)


def test_abcb_boundaries():
    y, truth = synth.loop_based_track(sections="ABCB", loop_bars=4, section_bars=8)
    s = structure_stage.run(y, SR, _ctx_for(y))
    starts = [sec.start_bar for sec in s.sections]
    for want in truth["sections"]:
        assert any(abs(sb - want["start_bar"]) <= 1 for sb in starts)
    assert len(s.sections) == 4
    assert s.loop_period_bars == 4


def test_two_bar_loop_period():
    y, truth = synth.loop_based_track(sections="AB", loop_bars=2, section_bars=8)
    s = structure_stage.run(y, SR, _ctx_for(y))
    assert s.loop_period_bars == 2
    assert len(s.sections) == 2
    assert abs(s.sections[1].start_bar - 8) <= 1


def test_short_eight_bar_file_is_one_section():
    y, _ = synth.loop_based_track(sections="A", loop_bars=4, section_bars=8)
    s = structure_stage.run(y, SR, _ctx_for(y))
    _check_coverage(s, len(y) / SR)
    assert len(s.sections) == 1
    assert s.sections[0].start_bar == 0
    assert s.sections[0].bars in (8, 9)  # the synth adds a 0.5 s tail
    assert s.sections[0].label == "A"
    assert s.loop_period_bars == 4


def test_drum_loop_is_one_section_with_one_bar_period():
    y = synth.drum_loop(BPM, 8, synth.Pattern.boom_bap(), SR)
    s = structure_stage.run(y, SR, _ctx_for(y))
    _check_coverage(s, len(y) / SR)
    assert len(s.sections) == 1
    assert s.loop_period_bars == 1


def test_humanized_drum_loop_is_one_section():
    # timing and spectral jitter must not be inflated into structure
    y = synth.drum_loop(BPM, 8, synth.Pattern.boom_bap(), SR, jitter_ms=8.0, spectral_variation=0.2, velocity_jitter=0.2, seed=5)
    s = structure_stage.run(y, SR, _ctx_for(y))
    _check_coverage(s, len(y) / SR)
    assert len(s.sections) == 1
    assert s.loop_period_bars == 1


def test_uniform_click_has_no_spurious_sections():
    # A bare click has all its energy in one 5 ms burst on every beat boundary; the loop period it reports
    # is a frame-quantization artifact (see HANDOFF_dsp.md), but it must never be split into sections.
    for bpm in (BPM, 180.0):
        y = synth.click_track(bpm, 12.0, SR)
        s = structure_stage.run(y, SR, _ctx_for(y, bpm=90.0))
        _check_coverage(s, len(y) / SR)
        assert len(s.sections) == 1
        assert s.sections[0].label == "A"


def test_no_beats_or_silence_do_not_raise():
    for y in (synth.silence(5.0, SR), synth.silence(0.05, SR), np.zeros(0, dtype=np.float32)):
        ctx = Context(report=AnalysisReport.empty(FileInfo(duration_s=len(y) / SR)), sr=SR)
        s = structure_stage.run(y, SR, ctx)
        assert isinstance(s, Structure)
        assert len(s.sections) >= 1
        assert s.sections[0].start_s == 0.0
        assert 0.0 <= s.loop_period_confidence <= 1.0
    y, _ = synth.loop_based_track(sections="AB", loop_bars=4, section_bars=8)
    ctx = Context(report=AnalysisReport.empty(FileInfo(duration_s=len(y) / SR)), sr=SR)  # no beats section
    s = structure_stage.run(y, SR, ctx)
    assert len(s.sections) >= 1 and s.notes


def test_deterministic():
    y, _ = synth.loop_based_track(sections="ABAB", loop_bars=4, section_bars=8)
    ctx = _ctx_for(y)
    assert structure_stage.run(y, SR, ctx) == structure_stage.run(y, SR, ctx)


# --------------------------------------------------------------------------
# regressions: four bugs found against the 48-item synthetic evaluation set
# (docs/HANDOFF_structure_accuracy.md). Each fixture isolates one of them.
# --------------------------------------------------------------------------

def _diagonal_matrix(n: int, lag: int, diagonal: np.ndarray) -> np.ndarray:
    """A matrix whose ``lag`` diagonal is ``diagonal`` and which is zero elsewhere.

    ``sequence_novelty`` reads only that diagonal, and ``path_enhance`` averages *along*
    diagonals, so this isolates the novelty from the features that produced it.
    """
    S = np.zeros((n, n))
    idx = np.arange(n - lag)
    S[idx, idx + lag] = diagonal[: n - lag]
    return S


def test_sequence_novelty_peaks_on_the_boundary_not_before_it():
    # A section change at beat 32 with a 16-beat loop: the lag-16 diagonal dips over the 16
    # beats before it, and the dip is *asymmetric* because the two loops happen to share a
    # chord towards the end (measured on the synthetic set: the dip runs 0.2 -> 0.8).
    n, lag, boundary = 64, 16, 32
    d = np.ones(n)
    d[boundary - lag:boundary] = np.linspace(0.0, 0.8, lag)
    S = _diagonal_matrix(n, lag, d)

    nov = structure_stage.sequence_novelty(S, lag)
    assert int(np.argmax(nov)) == boundary

    # Path-enhancing first widens the dip past the width of the window matched to it, and the
    # asymmetry then pulls the maximum off the boundary. That is why run() novelty-scores the
    # raw similarity matrix and keeps the path-enhanced one for the repetition statistics.
    smeared = structure_stage.sequence_novelty(structure_stage.path_enhance(S), lag)
    assert int(np.argmax(smeared)) < boundary


def test_repeat_histogram_counts_repeats_not_correlation():
    # Material that repeats every 16 beats, over a texture that is merely *correlated* every
    # 4 beats (a kick on every beat, a chord held through the bar). Averaging the lag
    # diagonal makes the 4-beat lag look like the loop; counting repeats does not.
    n = 96
    lag = np.abs(np.subtract.outer(np.arange(n), np.arange(n)))
    S = np.where(lag % 16 == 0, 1.0, np.where(lag % 4 == 0, 0.7, 0.0))

    mean_hist = np.array([np.trace(np.clip(S, 0.0, 1.0), offset=x) / n for x in range(n)])
    assert structure_stage.loop_period(mean_hist, 4)[0] == 4  # the old statistic's answer

    hist = structure_stage.repeat_histogram(S, 4)
    assert hist[4] == 0.0 and hist[16] > 0.5
    assert structure_stage.loop_period(hist, 4)[0] == 16


def test_loop_period_max_lag_bounds_the_comparison_window():
    # A file whose strongest repetition is its whole form (32 beats) over a 8-beat loop that
    # only repeats inside sections. The reported period may be the long one; the novelty
    # window has to stay short enough to fit in the file several times.
    h = np.zeros(128)
    h[8] = 0.30
    h[32] = 0.55
    assert structure_stage.loop_period(h, 4) == (32, 0.55)
    assert structure_stage.loop_period(h, 4, max_lag=16)[0] == 8
    assert structure_stage.loop_period(h, 4, max_lag=4)[0] is None


def test_snap_keeps_a_boundary_no_downbeat_is_near():
    downbeats = np.arange(2, 60, 4)  # bar lines on beats 2, 6, 10, ... : half a bar off
    # a peak one beat from a bar line is refined onto it
    assert structure_stage.snap_boundaries(np.array([17]), np.array([1.0]), downbeats, 64, 8, 1) == {18: 1.0}
    # a peak equidistant from two bar lines stays where the evidence put it, instead of being
    # moved half a bar to the earlier one
    assert structure_stage.snap_boundaries(np.array([16]), np.array([1.0]), downbeats, 64, 8, 1) == {16: 1.0}
    # ... and boundaries inside the first/last block of the file are still dropped
    assert structure_stage.snap_boundaries(np.array([4]), np.array([1.0]), downbeats, 64, 8, 1) == {}


def test_merge_only_drops_a_boundary_between_the_same_material():
    # sections 0 and 1 are different material that a two-cluster labeling would lump together;
    # sections 1 and 2 are the same material split in two.
    A = np.array([[1.0, 0.55, 0.20],
                  [0.55, 1.0, 0.90],
                  [0.20, 0.90, 1.0]])
    assert structure_stage.merge_same_material([10, 20], A) == [10]
    assert structure_stage.merge_same_material([10, 20], A, threshold=0.5) == []


def _fixed_grid_ctx(y: np.ndarray, beat_s: float, first_downbeat_s: float) -> Context:
    """A context whose beat grid is given rather than tracked (to fix a metrical level)."""
    from lockedgroove.report import Beats

    report = AnalysisReport.empty(FileInfo(duration_s=len(y) / SR, sample_rate=SR, channels=1))
    times = list(np.arange(0.0, len(y) / SR, beat_s))
    downs = [t for t in times if t >= first_downbeat_s - 1e-9
             and abs(round((t - first_downbeat_s) / beat_s) % 4) < 1e-6
             and abs((t - first_downbeat_s) / beat_s - round((t - first_downbeat_s) / beat_s)) < 1e-6]
    report.beats = Beats(times_s=times, confidence=0.8, method="test", downbeats_s=downs,
                         downbeat_confidence=0.8, downbeat_method="test", meter="4/4")
    return Context(report=report, sr=SR)


def test_half_time_grid_does_not_move_boundaries_half_a_bar():
    # The beat tracker reads this ABAB track at half time, so a "bar" spans two real bars and
    # the bar lines fall in the middle of the section changes. Snapping to the nearest bar line
    # would move every boundary a full real bar; the novelty peaks are exactly right.
    y, truth = synth.loop_based_track(sections="ABAB", loop_bars=4, section_bars=8)
    ctx = _fixed_grid_ctx(y, 2 * 60.0 / BPM, BAR)  # half-time beats, bar lines one bar late
    s = structure_stage.run(y, SR, ctx)
    _check_coverage(s, len(y) / SR)
    assert len(s.sections) == 4
    for got, want in zip(s.sections, truth["sections"]):
        assert abs(got.start_s - want["start_s"]) < BAR / 2


def test_double_time_grid_does_not_shred_the_file_into_bars():
    # The beat tracker reads this four-on-the-floor track at double time, so a "bar" spans half
    # a real bar and the kick makes every one of them alike. Taking that for the loop period
    # points the novelty at a half-bar window, which finds a boundary at every chord change.
    loops = {
        "A": [synth.triad(r, m, 4) for r, m in (("C", "major"), ("G", "major"), ("A", "minor"), ("F", "major"))],
        "B": [synth.triad(r, m, 4) for r, m in (("A", "minor"), ("F", "major"), ("C", "major"), ("G", "major"))],
    }
    section_bars, labels = 8, "ABAB"
    parts = [synth.chord_progression(loops[x], 4, BPM, SR, repeats=section_bars // 4, amplitude=0.5)[
        : int(round(section_bars * BAR * SR))] for x in labels]
    harmonic = synth.concat(*parts)
    drums = synth.drum_loop(BPM, section_bars * len(labels), synth.Pattern.four_on_floor(), SR)[: len(harmonic)]
    y = synth.normalize(synth.mix(harmonic[: len(drums)], drums, gains=[0.8, 0.9]), 0.9)

    ctx = _fixed_grid_ctx(y, 30.0 / BPM, 30.0 / BPM)  # double-time beats
    s = structure_stage.run(y, SR, ctx)
    _check_coverage(s, len(y) / SR)
    assert len(s.sections) == len(labels)
    assert s.loop_period_bars == 8  # four real bars, in this grid's half-length bars
    for i, sec in enumerate(s.sections):
        assert abs(sec.start_s - i * section_bars * BAR) < BAR / 2


def test_abab_boundaries_land_on_the_bar_not_a_bar_early():
    # The harness scores a boundary as a hit within one bar, which hides a systematic one-bar
    # bias. On material this clean the boundaries should be exact.
    y, truth = synth.loop_based_track(sections="ABAB", loop_bars=4, section_bars=8)
    s = structure_stage.run(y, SR, _ctx_for(y))
    assert len(s.sections) == 4
    for got, want in zip(s.sections, truth["sections"]):
        assert abs(got.start_s - want["start_s"]) < 0.5 * 60.0 / BPM  # half a beat


def test_sections_are_compared_bar_for_bar_across_a_pickup():
    # 3 pickup beats, then A (16 beats), B, A. The first section owns the pickup, so lining the
    # sections up from their start times compares A with itself three beats out of phase and
    # calls the repeat different material -- which relabels it, and, at the merge threshold,
    # could delete the boundary into it.
    pickup, unit, n = 3, 16, 3 + 3 * 16
    material = ["P"] * pickup + ["A"] * unit + ["B"] * unit + ["A"] * unit
    S = np.zeros((n, n))
    for i in range(n):
        for j in range(n):
            same_phase = i >= pickup and j >= pickup and (i - j) % unit == 0
            S[i, j] = 1.0 if (i == j or (same_phase and material[i] == material[j])) else 0.0
    bounds = [0, pickup + unit, pickup + 2 * unit, n]
    downbeats = np.arange(pickup, n, 4)

    assert structure_stage.section_anchors(bounds, downbeats) == [pickup, pickup + unit, pickup + 2 * unit]
    assert structure_stage.aligned_similarity(S, bounds)[0, 2] < 0.2
    anchored = structure_stage.aligned_similarity(S, bounds, anchors=structure_stage.section_anchors(bounds, downbeats))
    assert anchored[0, 2] > 0.9
    assert anchored[0, 1] < 0.2
