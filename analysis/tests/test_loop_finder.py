"""Loop finder on synthetic fixtures (BUILD_PACKET section 7; principle 8: tests before DSP).

Reports are built from the synth ground truth, never from the analysis
stages, so these tests pin the finder alone.
"""

import json

import numpy as np
import pytest

from lockedgroove.loops import finder as F
from lockedgroove.loops.finder import DOWNBEAT_CONFIDENCE_THRESHOLD, LoopCandidate, find_loops
from lockedgroove.report import AnalysisReport, Beats, Onsets, Section, Structure, Tempo
from lockedgroove.testing.synth import concat, loop_based_track, silence, tone

SR = 22050
BPM = 90.0
BAR_S = 4 * 60.0 / BPM


@pytest.fixture(scope="module")
def track():
    y, truth = loop_based_track(bpm=BPM, sr=SR, loop_bars=4, sections="ABAB", section_bars=8)
    return y, truth


def report_from_truth(truth: dict, downbeat_confidence: float = 0.9, with_structure: bool = True,
                      section_confidence: float = 0.9) -> AnalysisReport:
    sections = [Section(start_s=s["start_s"], end_s=s["end_s"], start_bar=s["start_bar"], bars=s["bars"],
                        label=s["label"], energy=0.5, confidence=section_confidence) for s in truth["sections"]]
    return AnalysisReport(
        tempo=Tempo(bpm=truth["bpm"], confidence=0.95, method="truth", alternates_bpm=[45.0, 180.0]),
        beats=Beats(times_s=truth["beats_s"], confidence=0.95, method="truth",
                    downbeats_s=truth["downbeats_s"], downbeat_phase=0,
                    downbeat_confidence=downbeat_confidence, downbeat_method="truth", meter="4/4"),
        structure=Structure(sections=sections, loop_period_bars=truth["loop_period_bars"],
                            loop_period_confidence=0.8, method="truth") if with_structure else None,
    )


@pytest.fixture(scope="module")
def ranked(track):
    y, truth = track
    return find_loops(y, SR, report_from_truth(truth), top_k=12)


@pytest.fixture(scope="module")
def ranked_all(track):
    y, truth = track
    return find_loops(y, SR, report_from_truth(truth), top_k=None)


def _on_true_downbeat(c: LoopCandidate, truth: dict, tol_s: float = 0.015) -> bool:
    return any(abs(c.start_s - d) <= tol_s for d in truth["downbeats_s"])


def test_top_candidates_include_a_four_bar_loop_on_a_true_downbeat(ranked, track):
    _, truth = track
    fours = [c for c in ranked if c.bars == 4]
    assert fours, "no 4-bar loop in the top 12"
    best = fours[0]
    assert _on_true_downbeat(best, truth)
    assert abs(best.duration_s - 4 * BAR_S) < 0.015
    assert best.components["seam"] >= 0.6
    assert best.components["seam_wrap"] >= 0.9  # what the tail crossfade plays matches the head
    assert best.components["stability"] >= 0.8
    assert best.components["novelty"] == 1.0
    assert best.components["grid"] == "downbeats"
    assert best.components["matches_loop_period"] is True
    assert best.name.startswith("4 bars from bar ")


def test_all_downbeat_candidates_start_on_true_downbeats(ranked_all, track):
    _, truth = track
    assert all(_on_true_downbeat(c, truth) for c in ranked_all)
    assert {c.bars for c in ranked_all} == {1, 2, 4, 8}


def test_candidate_straddling_section_boundary_scores_lower_novelty(ranked_all):
    fours = {round(c.start_s, 3): c for c in ranked_all if c.bars == 4}
    inside_a = fours[round(0.0, 3)]
    straddling = fours[round(6 * BAR_S, 3)]  # bars 6-10 cross the A->B boundary at bar 8
    assert inside_a.components["novelty"] == 1.0
    assert inside_a.components["interior_boundaries"] == 0
    assert straddling.components["interior_boundaries"] == 1
    assert straddling.components["novelty"] < inside_a.components["novelty"]
    assert straddling.components["novelty"] == pytest.approx(1 / (1 + 0.9), abs=1e-3)
    assert any("section boundary" in r for r in straddling.components["reasons"])


def test_sorted_descending_without_duplicates(ranked_all):
    scores = [c.score for c in ranked_all]
    assert scores == sorted(scores, reverse=True)
    keys = {(round(c.start_s, 3), c.bars) for c in ranked_all}
    assert len(keys) == len(ranked_all)
    for c in ranked_all:
        assert 0.0 <= c.score <= 1.0
        for k in ("seam", "phrase", "stability", "novelty", "onset_lock", "recurrence"):
            assert 0.0 <= c.components[k] <= 1.0
    assert len(ranked_all) > 12


def test_top_k_limits_and_keeps_order(ranked, ranked_all):
    assert len(ranked) == 12
    assert [(c.start_s, c.bars) for c in ranked] == [(c.start_s, c.bars) for c in ranked_all[:12]]


def test_contiguous_repeats_collapse_onto_the_earliest(ranked_all):
    fours = {round(c.start_s, 3): c for c in ranked_all if c.bars == 4}
    first_a = fours[round(0.0, 3)]
    assert first_a.components["repeats"] == 1  # bars 4-8 repeat bars 0-4
    assert round(4 * BAR_S, 3) not in fours  # the repeat itself is gone
    assert any("repeats 1x" in r for r in first_a.components["reasons"])
    # the second A section is not contiguous with the first, so it stays
    assert round(16 * BAR_S, 3) in fours


def test_empty_report_returns_nothing(track):
    y, _ = track
    assert find_loops(y, SR, AnalysisReport.empty()) == []
    no_beats = AnalysisReport(beats=Beats(times_s=[], confidence=0.0, method="none"))
    assert find_loops(y, SR, no_beats) == []
    assert find_loops(y, SR, AnalysisReport.empty(), top_k=0) == []


def test_low_downbeat_confidence_falls_back_to_beats(track):
    y, truth = track
    assert DOWNBEAT_CONFIDENCE_THRESHOLD == 0.5
    rep = report_from_truth(truth, downbeat_confidence=DOWNBEAT_CONFIDENCE_THRESHOLD - 0.01)
    res = find_loops(y, SR, rep, top_k=12)
    assert res and all(c.components["grid"] == "beats" for c in res)
    assert all(c.components["bar_index"] is None for c in res)
    # every start is on a beat and lengths are whole bars
    beats = np.asarray(truth["beats_s"])
    for c in res:
        assert np.min(np.abs(beats - c.start_s)) < 1e-6
        assert abs(c.duration_s / BAR_S - c.bars) < 1e-6
    at_threshold = find_loops(y, SR, report_from_truth(truth, downbeat_confidence=DOWNBEAT_CONFIDENCE_THRESHOLD), top_k=3)
    assert all(c.components["grid"] == "downbeats" for c in at_threshold)


def test_user_edits_drive_the_grid(track):
    y, truth = track
    rep = report_from_truth(truth, downbeat_confidence=0.9)
    rep.user_edits.downbeat_phase = 2  # the user says the one is on beat 3
    res = find_loops(y, SR, rep, top_k=None)
    beat = 60.0 / BPM
    assert res and all(c.components["grid"] == "downbeats" for c in res)
    for c in res:
        beat_index = round(c.start_s / beat)
        assert abs(c.start_s / beat - beat_index) < 1e-6
        assert beat_index % 4 == 2


def test_no_structure_means_no_novelty_penalty(track):
    y, truth = track
    res = find_loops(y, SR, report_from_truth(truth, with_structure=False), top_k=None)
    assert res and all(c.components["novelty"] == 1.0 for c in res)
    assert all(c.components["matches_loop_period"] is False for c in res)


def test_to_row_matches_loops_table_columns(ranked):
    row = ranked[0].to_row()
    assert set(row) == {"start_s", "end_s", "bars", "score", "origin", "components", "name"}
    assert row["origin"] == "finder"
    assert row["end_s"] > row["start_s"]
    assert isinstance(row["bars"], int) and isinstance(row["score"], float)
    json.dumps(row)  # components must be JSON-serializable for the jsonb column
    comp = row["components"]
    for k in ("seam", "phrase", "stability", "novelty", "onset_lock", "recurrence", "reasons",
              "repeats", "recurs_elsewhere", "grid", "weights"):
        assert k in comp
    assert comp["weights"] == {"seam": 0.30, "phrase": 0.22, "stability": 0.15, "novelty": 0.15,
                               "onset_lock": 0.10, "recurrence": 0.08}
    assert sum(comp["weights"].values()) == pytest.approx(1.0)
    assert all(isinstance(r, str) and r for r in comp["reasons"])


def test_stereo_input_gives_the_same_candidates(track):
    y, truth = track
    stereo = np.stack([y, y * 0.5])
    a = find_loops(y, SR, report_from_truth(truth), top_k=5)
    b = find_loops(stereo, SR, report_from_truth(truth), top_k=5)
    assert [(c.start_s, c.bars) for c in a] == [(c.start_s, c.bars) for c in b]


# --- component-level checks on purpose-built signals ----------------------------------------------


def _alternating_tone_track():
    """8 bars at 120 BPM: even bars a low note, odd bars a high note."""
    bar_s = 2.0
    parts = [tone(57 if b % 2 == 0 else 88, bar_s, SR, amplitude=0.5, attack_s=0.005) for b in range(8)]
    y = concat(*parts)
    rep = AnalysisReport(
        tempo=Tempo(bpm=120.0, confidence=0.9, method="truth"),
        beats=Beats(times_s=[i * 0.5 for i in range(32)], confidence=0.9, method="truth",
                    downbeats_s=[i * 2.0 for i in range(8)], downbeat_confidence=0.9, downbeat_method="truth"),
    )
    return y, rep


def test_seam_raw_prefers_same_texture_and_seam_wrap_prefers_true_period():
    y, rep = _alternating_tone_track()
    res = find_loops(y, SR, rep, bars=(1, 2), top_k=None)
    ones = [c for c in res if c.bars == 1]
    twos = [c for c in res if c.bars == 2]
    assert ones and twos
    # raw playback of a 1-bar loop wraps the same note onto itself; a 2-bar loop wraps high -> low
    assert min(c.components["seam_raw"] for c in ones) > 0.9
    assert max(c.components["seam_raw"] for c in twos) < 0.6
    # the tail crossfade plays what follows the end: identical for the 2-bar period, the other note for 1 bar
    assert min(c.components["seam_wrap"] for c in twos) > 0.95
    assert max(c.components["seam_wrap"] for c in ones) < 0.6
    # contiguous repeats of the 2-bar period collapse: [0,4) repeats three more times
    head = next(c for c in twos if c.start_s == 0.0)
    assert head.components["repeats"] == 3
    assert sum(1 for c in twos if c.start_s in (4.0, 8.0, 12.0)) == 0


@pytest.mark.parametrize("shift_s,expected", [(0.0, 1.0), (0.02, 1.0), (0.05, 0.5), (0.08, 0.0), (0.2, 0.0)])
def test_onset_lock_uses_report_onsets_with_linear_decay(shift_s, expected):
    y, rep = _alternating_tone_track()
    rep.onsets = Onsets(times_s=[d + shift_s for d in rep.beats.downbeats_s], method="truth", count=8)
    res = find_loops(y, SR, rep, bars=(2,), top_k=None)
    assert res
    for c in res:
        assert c.components["onset_lock"] == pytest.approx(expected, abs=1e-6)
        assert c.components["onset_distance_ms"] == pytest.approx(shift_s * 1000, abs=0.2)


def test_onsets_detected_locally_when_section_is_null():
    y, rep = _alternating_tone_track()
    assert rep.onsets is None
    res = find_loops(y, SR, rep, bars=(1,), top_k=None)
    # the note changes at every bar are strong onsets; starts after the first bar lock on
    later = [c for c in res if c.start_s >= 2.0]
    assert later and any(c.components["onset_lock"] > 0.8 for c in later)
    assert all(c.components["onset_distance_ms"] is not None for c in res)


def test_stability_penalizes_energy_dropouts():
    bar_s = 2.0
    y = concat(tone(57, bar_s, SR, amplitude=0.5), silence(bar_s, SR),
               tone(57, bar_s, SR, amplitude=0.5), tone(57, bar_s, SR, amplitude=0.5))
    rep = AnalysisReport(beats=Beats(times_s=[i * 0.5 for i in range(16)], confidence=0.9, method="truth",
                                     downbeats_s=[0.0, 2.0, 4.0, 6.0], downbeat_confidence=0.9,
                                     downbeat_method="truth"))
    res = {c.start_s: c for c in find_loops(y, SR, rep, bars=(2,), top_k=None)}
    assert res[4.0].components["stability"] == pytest.approx(1.0, abs=1e-3)
    assert res[0.0].components["stability"] == pytest.approx(0.0, abs=1e-3)
    assert res[4.0].score > res[0.0].score


def test_silent_candidates_are_dropped_and_last_bar_is_extrapolated():
    bar_s = 2.0
    y = concat(tone(57, bar_s, SR, amplitude=0.5), tone(57, bar_s, SR, amplitude=0.5), silence(2 * bar_s, SR))
    rep = AnalysisReport(beats=Beats(times_s=[i * 0.5 for i in range(16)], confidence=0.9, method="truth",
                                     downbeats_s=[0.0, 2.0, 4.0, 6.0], downbeat_confidence=0.9,
                                     downbeat_method="truth"))
    res = find_loops(y, SR, rep, bars=(1,), top_k=None)
    # bars 3 and 4 are silence and never become candidates; bar 2 is a contiguous repeat of bar 1
    assert [c.start_s for c in res] == [0.0]
    assert res[0].components["repeats"] == 1
    # bar 4's end is the extrapolated downbeat at 8 s, so a 4-bar loop over the whole file exists
    res2 = find_loops(y, SR, rep, bars=(4,), top_k=None)
    assert len(res2) == 1 and res2[0].components["extrapolated_end"] is True
    assert res2[0].end_s == pytest.approx(8.0)


def test_meter_override_regroups_bars():
    y, rep = _alternating_tone_track()
    rep.user_edits.meter = "3/4"
    rep.user_edits.downbeat_phase = 0
    res = find_loops(y, SR, rep, bars=(1,), top_k=None)
    assert res and all(abs(c.duration_s - 1.5) < 1e-6 for c in res)
    assert F.beats_per_bar("6/8") == 2 and F.beats_per_bar("7/8") == 7 and F.beats_per_bar("junk") == 4
