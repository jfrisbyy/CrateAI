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
