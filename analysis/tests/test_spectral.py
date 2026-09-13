"""spectral.py: centroid, mid/side stereo width, low/high band ratio."""

from __future__ import annotations

import numpy as np

from lockedgroove.analysis import spectral as spectral_stage
from lockedgroove.pipeline import ANALYSIS_SR, Context, resample, to_mono
from lockedgroove.report import AnalysisReport, Spectral
from lockedgroove.testing import synth

SR = 44100


def _ctx(native: np.ndarray, sr: int = SR) -> Context:
    return Context(report=AnalysisReport.empty(), sr=ANALYSIS_SR, native=(native, sr))


def _analysis(native: np.ndarray, sr: int = SR) -> np.ndarray:
    return resample(to_mono(native), sr, ANALYSIS_SR)


def test_mono_has_zero_width():
    y, _ = synth.loop_based_track(sr=SR, sections="AB", section_bars=4)
    s = spectral_stage.run(_analysis(y), ANALYSIS_SR, _ctx(y))
    assert isinstance(s, Spectral)
    assert s.stereo_width == 0.0
    assert s.method
    # identical channels are also width 0
    st = synth.to_stereo(y, width=0.0)
    assert spectral_stage.run(_analysis(st), ANALYSIS_SR, _ctx(st)).stereo_width == 0.0


def test_decorrelated_stereo_is_wide():
    y, _ = synth.loop_based_track(sr=SR, sections="AB", section_bars=4)
    st = synth.to_stereo(y, width=1.0)
    s = spectral_stage.run(_analysis(st), ANALYSIS_SR, _ctx(st))
    assert s.stereo_width > 0.5
    assert s.stereo_width <= 1.0
    narrow = synth.to_stereo(y, width=0.3)
    assert 0.0 < spectral_stage.run(_analysis(narrow), ANALYSIS_SR, _ctx(narrow)).stereo_width < s.stereo_width


def test_centroid_of_a_sine():
    x = synth.sine(1000.0, 3.0, SR, amplitude=0.5)
    s = spectral_stage.run(_analysis(x), ANALYSIS_SR, _ctx(x))
    assert abs(s.centroid_hz_mean - 1000.0) < 100.0


def test_low_high_ratio_sign():
    low = synth.sine(100.0, 3.0, SR, amplitude=0.5)
    high = synth.sine(8000.0, 3.0, SR, amplitude=0.5)
    s_low = spectral_stage.run(_analysis(low), ANALYSIS_SR, _ctx(low))
    s_high = spectral_stage.run(_analysis(high), ANALYSIS_SR, _ctx(high))
    assert s_low.low_high_ratio_db > 20.0
    assert s_high.low_high_ratio_db < -20.0
    assert abs(s_low.low_high_ratio_db) <= spectral_stage.RATIO_CLAMP_DB
    assert abs(s_high.low_high_ratio_db) <= spectral_stage.RATIO_CLAMP_DB


def test_silence_and_short_audio_do_not_raise():
    for native in (np.zeros(SR * 2, dtype=np.float32), np.zeros((2, 500), dtype=np.float32), np.zeros(0, dtype=np.float32)):
        s = spectral_stage.run(_analysis(native) if native.size else native, ANALYSIS_SR, _ctx(native))
        assert np.isfinite(s.centroid_hz_mean) and np.isfinite(s.stereo_width) and np.isfinite(s.low_high_ratio_db)
        assert s.stereo_width == 0.0
        assert s.low_high_ratio_db == 0.0


def test_falls_back_to_analysis_signal_without_native():
    x = synth.sine(1000.0, 3.0, ANALYSIS_SR, amplitude=0.5)
    s = spectral_stage.run(x, ANALYSIS_SR, Context(report=AnalysisReport.empty(), sr=ANALYSIS_SR))
    assert abs(s.centroid_hz_mean - 1000.0) < 100.0
    assert s.stereo_width == 0.0
