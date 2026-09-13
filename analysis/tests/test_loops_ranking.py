"""The ranking half of the loop finder: bar count, phrase, loop period, recurrence.

The finder used to score four things, all of which measure how little goes
wrong *inside* a span. A short span has less inside it, so one-bar candidates
swept the top and the four bars a producer actually flipped ranked 50th of 52.
These tests pin the two terms that fixed it and the properties that keep them
honest -- the loop-period claim must be neutral when nothing was measured, the
prior must not be a ramp, recurrence must not be a second length bias.

Reports are built from synth ground truth, never from the analysis stages, so
what is measured here is the finder alone.
"""

from __future__ import annotations

import numpy as np
import pytest

from lockedgroove.eval.metrics import FLIP_IOU_THRESHOLD, span_iou
from lockedgroove.loops import finder as F
from lockedgroove.loops.finder import find_loops
from lockedgroove.report import AnalysisReport, Beats, Section, Structure, Tempo
from lockedgroove.testing.synth import concat, loop_based_track, tone

SR = 22050
BPM = 90.0
BAR_S = 4 * 60.0 / BPM


def report_from_truth(truth: dict, *, with_structure: bool = True, section_confidence: float = 0.9,
                      loop_period_bars: int | None = -1, loop_period_confidence: float = 0.8
                      ) -> AnalysisReport:
    sections = [Section(start_s=s["start_s"], end_s=s["end_s"], start_bar=s["start_bar"], bars=s["bars"],
                        label=s["label"], energy=0.5, confidence=section_confidence)
                for s in truth["sections"]]
    period = truth["loop_period_bars"] if loop_period_bars == -1 else loop_period_bars
    return AnalysisReport(
        tempo=Tempo(bpm=truth["bpm"], confidence=0.95, method="truth", alternates_bpm=[]),
        beats=Beats(times_s=truth["beats_s"], confidence=0.95, method="truth",
                    downbeats_s=truth["downbeats_s"], downbeat_phase=0,
                    downbeat_confidence=0.9, downbeat_method="truth", meter="4/4"),
        structure=Structure(sections=sections, loop_period_bars=period,
                            loop_period_confidence=loop_period_confidence,
                            method="truth") if with_structure else None,
    )


@pytest.fixture(scope="module")
def track():
    """Sixteen bars, ABAB, a 4-bar loop played twice per section: a record with a real loop."""
    y, truth = loop_based_track(bpm=BPM, sr=SR, loop_bars=4, sections="ABAB", section_bars=8)
    return y, truth


@pytest.fixture(scope="module")
def ranked(track):
    y, truth = track
    return find_loops(y, SR, report_from_truth(truth), top_k=None)


# --- the bug: short candidates won because nothing scored being a useful length -------------------


def test_the_top_of_the_rack_is_not_one_bar_cells(ranked):
    """The symptom that started this: a rack of one-bar fragments."""
    top = ranked[:10]
    assert top[0].bars >= 2, "the single automatic pick is a one-bar fragment again"
    assert sum(1 for c in top if c.bars == 1) <= 2, [c.bars for c in top]


def true_loops(truth: dict) -> list[tuple[float, float]]:
    """Every aligned statement of the record's own loop: the truth a sample pair carries."""
    loop_bars = int(truth["loop_period_bars"])
    out = []
    for s in truth["sections"]:
        for k in range(max(1, int(s["bars"]) // loop_bars)):
            start = float(s["start_s"]) + k * loop_bars * BAR_S
            out.append((start, start + loop_bars * BAR_S))
    return out


def test_the_records_own_loop_is_near_the_top(ranked, track):
    """The harness question, as a unit test: is the loop the record is built from in the rack?"""
    _, truth = track
    ranks = sorted(i + 1 for i, c in enumerate(ranked)
                   if any(span_iou((c.start_s, c.end_s), t) >= FLIP_IOU_THRESHOLD
                          for t in true_loops(truth)))
    assert ranks, "the record's own 4-bar loop is nowhere in the ranking"
    assert ranks[0] <= 3, f"the record's own loop is only rank {ranks[0]}"
    assert len(ranks) >= 4, "every statement of the loop should be findable, not only the best one"


def test_four_bars_outscores_the_same_material_cut_to_one_bar(ranked):
    by_bars = {b: [c.score for c in ranked if c.bars == b] for b in (1, 2, 4, 8)}
    assert all(by_bars[b] for b in (1, 2, 4, 8))
    assert np.mean(by_bars[4]) > np.mean(by_bars[2]) > np.mean(by_bars[1])


# --- the bar prior is a musical claim, not a length bonus ------------------------------------------


def test_the_bar_prior_peaks_at_four_rather_than_ramping_with_length():
    """A bonus for being long would put every eight-bar candidate on top; this must not."""
    assert F.BAR_PRIOR[4] > F.BAR_PRIOR[8] > F.BAR_PRIOR[2] > F.BAR_PRIOR[1]
    assert F.BAR_PRIOR[4] == 1.0
    assert 0.0 < F.BAR_PRIOR[1] < 0.5, "a one-bar candidate must still be offered, just not first"
    assert 0.0 <= F.BAR_PRIOR_DEFAULT <= 1.0


def test_the_weights_sum_to_one_and_length_biased_terms_lost_their_majority():
    assert sum(F.WEIGHTS.values()) == pytest.approx(1.0)
    assert set(F.WEIGHTS) == {"seam", "phrase", "stability", "novelty", "onset_lock", "recurrence"}
    length_biased = F.WEIGHT_SEAM + F.WEIGHT_STABILITY + F.WEIGHT_NOVELTY
    assert length_biased < 0.65, "seam + stability + novelty all fall with length; they cannot be 0.9"
    assert F.WEIGHT_SEAM == max(F.WEIGHTS.values()), "the seam is still the biggest single term"
    assert F.WEIGHT_ONSET_LOCK == 0.10, "onset_lock never had a length bias and did not need changing"


def test_every_term_stays_in_range_and_the_score_is_their_weighted_sum(ranked):
    for c in ranked[:20]:
        comp = c.components
        for term in F.WEIGHTS:
            assert 0.0 <= comp[term] <= 1.0, (term, comp[term])
        expected = sum(F.WEIGHTS[t] * comp[t] for t in F.WEIGHTS)
        assert c.score == pytest.approx(expected, abs=2e-4)


# --- phrase alignment -----------------------------------------------------------------------------


def test_phrase_alignment_prefers_a_start_on_a_phrase_line(ranked):
    fours = {c.components["bar_index"]: c for c in ranked if c.bars == 4}
    assert fours[0].components["phrase_alignment"] == pytest.approx(1.0)
    assert fours[2].components["phrase_alignment"] == pytest.approx(0.0)  # half a phrase late
    assert fours[1].components["phrase_alignment"] == pytest.approx(0.5)  # one bar of four late
    assert fours[0].score > fours[2].score


def test_a_section_start_is_also_a_phrase_line():
    """A record with a two-bar intro still has its phrases found, through the section start."""
    grid = F._Grid(anchors=[i * 2.0 for i in range(12)], n_measured=12, step=1, name="downbeats",
                   bpb=4, beat_period_s=0.5, beats=np.asarray([i * 0.5 for i in range(48)]))
    assert F._phrase_origins(grid, None) == [0]
    origins = F._phrase_origins(grid, [(4.0, 0.8)])  # a section starting at anchor 2
    assert origins == [0, 2]
    # a 4-bar candidate at anchor 2 is off the bar-0 lattice but on the section's
    assert F._phrase_alignment(2, 4, [0]) == pytest.approx(0.0)
    assert F._phrase_alignment(2, 4, origins) == pytest.approx(1.0)
    # a section start further than half a beat from any anchor is not on the grid
    assert F._phrase_origins(grid, [(4.4, 0.8)]) == [0]


def test_phrase_alignment_is_measured_in_the_candidates_own_length():
    assert F._phrase_alignment(4, 4, [0]) == pytest.approx(1.0)
    assert F._phrase_alignment(4, 8, [0]) == pytest.approx(0.0)
    assert F._phrase_alignment(8, 8, [0]) == pytest.approx(1.0)
    assert F._phrase_alignment(1, 1, [0]) == pytest.approx(1.0)  # every bar is a 1-bar phrase line


# --- the loop period is a measurement, so it only counts when it was measured ---------------------


@pytest.mark.parametrize("bars,period,expected", [
    (4, 4, 1.00), (4, 8, 0.90), (8, 4, 0.80), (2, 8, 0.45), (8, 2, 0.45), (4, 3, 0.35),
])
def test_period_agreement_reads_the_ratio(bars, period, expected):
    assert F._period_agreement(bars, period, 1.0) == pytest.approx(expected)


def test_period_agreement_is_neutral_without_a_measurement():
    assert F._period_agreement(1, None, 1.0) == 1.0
    assert F._period_agreement(1, 8, 0.0) == 1.0, "a period measured with no confidence claims nothing"
    assert F._period_agreement(1, 8, 0.5) == pytest.approx(1.0 - 0.5 * (1.0 - F.PERIOD_AGREEMENT_OTHER))


def test_no_structure_means_no_period_claim_and_no_novelty_penalty(track):
    y, truth = track
    res = find_loops(y, SR, report_from_truth(truth, with_structure=False), top_k=None)
    assert res
    assert all(c.components["period_agreement"] == 1.0 for c in res)
    assert all(c.components["novelty"] == 1.0 for c in res)
    assert all(c.components["loop_period_bars"] is None for c in res)


def test_a_measured_eight_bar_period_lifts_eight_bar_candidates(track):
    y, truth = track
    four = find_loops(y, SR, report_from_truth(truth, loop_period_bars=4, loop_period_confidence=1.0),
                      top_k=None)
    eight = find_loops(y, SR, report_from_truth(truth, loop_period_bars=8, loop_period_confidence=1.0),
                       top_k=None)
    mean_eight_under_four = np.mean([c.score for c in four if c.bars == 8])
    mean_eight_under_eight = np.mean([c.score for c in eight if c.bars == 8])
    assert mean_eight_under_eight > mean_eight_under_four
    # and the record can never invent a preference: with no confidence, nothing moves
    flat = find_loops(y, SR, report_from_truth(truth, loop_period_bars=8, loop_period_confidence=0.0),
                      top_k=None)
    assert all(c.components["period_agreement"] == 1.0 for c in flat)


# --- recurrence -----------------------------------------------------------------------------------


def _two_phrase_track():
    """Eight bars at 120 BPM: bars 0-4 are a phrase that comes back at 4-8 an octave apart.

    A -- B -- A -- B by bar, so a 2-bar window starting on an even bar recurs and
    the bars themselves each recur, while the 4-bar window has no twin.
    """
    bar_s = 2.0
    pattern = [57, 69, 57, 69, 57, 69, 57, 69]
    y = concat(*[tone(p, bar_s, SR, amplitude=0.5, attack_s=0.005) for p in pattern])
    rep = AnalysisReport(
        tempo=Tempo(bpm=120.0, confidence=0.9, method="truth"),
        beats=Beats(times_s=[i * 0.5 for i in range(32)], confidence=0.9, method="truth",
                    downbeats_s=[i * 2.0 for i in range(8)], downbeat_confidence=0.9,
                    downbeat_method="truth"),
    )
    return y, rep


def test_recurrence_counts_content_heard_elsewhere_in_the_record():
    y, rep = _two_phrase_track()
    res = find_loops(y, SR, rep, bars=(2,), top_k=None)
    heads = {round(c.start_s, 3): c for c in res}
    head = heads[0.0]
    assert head.components["recurs_elsewhere"] >= 1
    assert head.components["recurrence"] > 0.0
    assert any("come back" in r for r in head.components["reasons"])


def test_recurrence_is_not_a_second_length_bias():
    """A one-bar cell recurs as readily as a four-bar phrase; that is the point of the term."""
    y, rep = _two_phrase_track()
    ones = find_loops(y, SR, rep, bars=(1,), top_k=None)
    twos = find_loops(y, SR, rep, bars=(2,), top_k=None)
    assert max(c.components["recurrence"] for c in ones) >= max(c.components["recurrence"] for c in twos)


def test_recurrence_saturates_rather_than_rewarding_a_long_record():
    assert F._score_recurrence(F._Cand(0.0, 1.0, 1, None, False, recurs=0)) == 0.0
    assert F._score_recurrence(F._Cand(0.0, 1.0, 1, None, False, recurs=F.RECURRENCE_FULL)) == 1.0
    assert F._score_recurrence(F._Cand(0.0, 1.0, 1, None, False, recurs=50)) == 1.0


def test_recurrence_is_measured_before_the_repeat_collapse(track):
    """Which is what keeps the score the same with stems and without (see sample_ready)."""
    y, truth = track
    res = find_loops(y, SR, report_from_truth(truth), top_k=None)
    head = next(c for c in res if c.bars == 4 and c.components["repeats"] >= 1)
    assert head.components["recurs_elsewhere"] >= head.components["repeats"]


# --- the reasons a producer reads ------------------------------------------------------------------


def test_the_reasons_explain_the_new_terms(ranked):
    text = " | ".join(r for c in ranked[:12] for r in c.components["reasons"])
    assert "phrase line" in text
    assert any("bar" in r for c in ranked[:12] for r in c.components["reasons"])
    for c in ranked[:12]:
        assert all(isinstance(r, str) and r for r in c.components["reasons"])
