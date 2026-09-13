"""tempo.py: 90 BPM click -> 90 +/- 1 with confidence > 0.9; 180 -> 180 or 90 with the truth in alternates."""

from __future__ import annotations

import numpy as np
import pytest

from lockedgroove.analysis import tempo
from lockedgroove.pipeline import Context
from lockedgroove.report import AnalysisReport, Tempo
from lockedgroove.testing import synth

SR = 22050


def _ctx() -> Context:
    return Context(report=AnalysisReport.empty(), sr=SR)


def test_click_90_is_exact_and_confident():
    y = synth.click_track(90.0, 12.0, SR)
    t = tempo.run(y, SR, _ctx())
    assert isinstance(t, Tempo)
    assert abs(t.bpm - 90.0) <= 1.0
    assert t.confidence > 0.9
    assert t.method
    assert t.alternates_bpm == pytest.approx([t.bpm / 2, t.bpm * 2])


def test_click_180_is_180_or_90_and_truth_in_alternates():
    y = synth.click_track(180.0, 12.0, SR)
    t = tempo.run(y, SR, _ctx())
    assert abs(t.bpm - 180.0) <= 1.0 or abs(t.bpm - 90.0) <= 1.0
    candidates = [t.bpm] + list(t.alternates_bpm)
    assert any(abs(c - 180.0) <= 1.0 for c in candidates)


@pytest.mark.parametrize("bpm", [75.0, 110.0, 140.0])
def test_drum_loops_within_two_bpm_or_octave(bpm):
    y = synth.drum_loop(bpm, 8, synth.Pattern.boom_bap(), SR)
    t = tempo.run(y, SR, _ctx())
    candidates = [t.bpm] + list(t.alternates_bpm)
    assert any(abs(c - bpm) <= 2.0 for c in candidates)
    assert abs(t.bpm - bpm) <= 2.0  # boom-bap in the 50-200 window with a 95 BPM prior lands on the truth


def test_prior_window_bounds():
    y = synth.drum_loop(90.0, 8, synth.Pattern.boom_bap(), SR)
    t = tempo.run(y, SR, _ctx())
    assert tempo.MIN_BPM <= t.bpm <= tempo.MAX_BPM


def test_short_and_silent_audio_do_not_raise():
    for y in (synth.click_track(90.0, 0.5, SR), synth.silence(3.0, SR), synth.silence(0.05, SR), np.zeros(0, dtype=np.float32)):
        t = tempo.run(y, SR, _ctx())
        assert isinstance(t, Tempo)
        assert t.confidence <= 0.1
        assert tempo.MIN_BPM <= t.bpm <= tempo.MAX_BPM
        assert 0.0 <= t.confidence <= 1.0


def test_noise_has_low_confidence():
    y = (np.random.default_rng(0).standard_normal(SR * 6) * 0.1).astype(np.float32)
    t = tempo.run(y, SR, _ctx())
    assert t.confidence < 0.3


def test_deterministic():
    y = synth.drum_loop(90.0, 4, synth.Pattern.boom_bap(), SR)
    a = tempo.run(y, SR, _ctx())
    b = tempo.run(y, SR, _ctx())
    assert a == b
