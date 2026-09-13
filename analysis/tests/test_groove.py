"""groove.py: swing from the off-beat 8th position; timing deviation from the 16th grid."""

from __future__ import annotations

import numpy as np

from lockedgroove.analysis import beats as beats_stage
from lockedgroove.analysis import groove as groove_stage
from lockedgroove.analysis import onsets as onsets_stage
from lockedgroove.pipeline import Context
from lockedgroove.report import AnalysisReport, Groove, Tempo
from lockedgroove.testing import synth

SR = 22050
BPM = 90.0


def _ctx_for(y: np.ndarray, bpm: float = BPM) -> Context:
    report = AnalysisReport.empty()
    report.tempo = Tempo(bpm=bpm, confidence=0.9, method="test", alternates_bpm=[bpm / 2, bpm * 2])
    ctx = Context(report=report, sr=SR)
    report.beats = beats_stage.run(y, SR, ctx)
    report.onsets = onsets_stage.run(y, SR, ctx)
    return ctx


def test_straight_loop():
    y = synth.drum_loop(BPM, 8, synth.Pattern.boom_bap(), SR, swing_pct=50.0)
    g = groove_stage.run(y, SR, _ctx_for(y))
    assert isinstance(g, Groove)
    assert abs(g.swing_pct - 50.0) <= 3.0
    assert g.feel == "straight"
    assert g.timing_deviation_ms.std < 12.0
    assert abs(g.timing_deviation_ms.mean) < 12.0
    assert g.confidence > 0.6
    assert g.method


def test_swung_loop_62():
    y = synth.drum_loop(BPM, 8, synth.Pattern.boom_bap(), SR, swing_pct=62.0)
    g = groove_stage.run(y, SR, _ctx_for(y))
    assert abs(g.swing_pct - 62.0) <= 3.0
    assert g.feel == "swung"
    # deviations are measured against the swung grid, so a programmed swung loop is still tight
    assert g.timing_deviation_ms.std < 12.0


def test_swung_loop_56_is_swung_but_close_to_straight():
    y = synth.drum_loop(BPM, 8, synth.Pattern.boom_bap(), SR, swing_pct=56.0)
    g = groove_stage.run(y, SR, _ctx_for(y))
    assert abs(g.swing_pct - 56.0) <= 3.0
    assert g.feel == "swung"


def test_loose_timing_is_loose():
    y = synth.drum_loop(BPM, 8, synth.Pattern.boom_bap(), SR, jitter_ms=30.0, spectral_variation=0.2, seed=3)
    g = groove_stage.run(y, SR, _ctx_for(y))
    assert g.feel == "loose"
    assert g.timing_deviation_ms.std > 15.0
    assert g.confidence < 0.6


def test_no_beats_gives_zero_confidence():
    y = synth.silence(3.0, SR)
    ctx = Context(report=AnalysisReport.empty(), sr=SR)
    g = groove_stage.run(y, SR, ctx)
    assert g.confidence == 0.0
    assert g.swing_pct == 50.0
    assert g.feel == "straight"


def test_missing_onsets_section_is_computed_internally():
    y = synth.drum_loop(BPM, 4, synth.Pattern.boom_bap(), SR)
    ctx = _ctx_for(y)
    ctx.report.onsets = None
    g = groove_stage.run(y, SR, ctx)
    assert abs(g.swing_pct - 50.0) <= 3.0


def test_short_audio_does_not_raise():
    for y in (synth.silence(0.05, SR), np.zeros(0, dtype=np.float32), synth.drum_loop(BPM, 1, synth.Pattern.boom_bap(), SR)):
        ctx = Context(report=AnalysisReport.empty(), sr=SR)
        g = groove_stage.run(y, SR, ctx)
        assert 0.0 <= g.confidence <= 1.0
